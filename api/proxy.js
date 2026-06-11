import http from 'node:http';
import https from 'node:https';

/**
 * Low-level HTTP GET that sends ALL headers we specify,
 * including Content-Length: 0 which some IPTV servers require.
 */
function rawGet(targetUrl, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(targetUrl);
        const mod = parsed.protocol === 'https:' ? https : http;

        const req = mod.request({
            method: 'GET',
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Connection': 'keep-alive',
                'Content-Length': '0',
            },
            timeout: timeoutMs,
        }, (response) => {
            // Follow redirects (301, 302, 307, 308)
            if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
                rawGet(response.headers.location, timeoutMs).then(resolve).catch(reject);
                return;
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                resolve({
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    status: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                });
            });
            response.on('error', reject);
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
        req.end();
    });
}

/**
 * Rewrites URLs inside an m3u8 playlist so that all segment/sub-playlist
 * URLs are routed through our Vercel proxy.
 */
function rewriteM3u8(content, encodedServer) {
    const proxyPrefix = `/api/proxy/s/${encodedServer}`;

    return content.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;

        if (t.startsWith('http://') || t.startsWith('https://')) {
            try {
                const url = new URL(t);
                const enc = Buffer.from(url.origin).toString('base64').replace(/=+$/, '');
                return `/api/proxy/s/${enc}${url.pathname}${url.search}`;
            } catch (_) { return line; }
        }

        if (t.startsWith('/')) return `${proxyPrefix}${t}`;

        return line;
    }).join('\n');
}

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const urlPath = req.url || '';

    // ── GENERIC STREAM PROXY: /api/proxy/s/<BASE64>/<path> ─────
    const m = urlPath.match(/\/api\/proxy\/s\/([^\/]+)\/(.+)/);

    if (m) {
        const [, encodedServer, remotePath] = m;
        let server;
        try {
            server = Buffer.from(encodedServer, 'base64').toString('utf-8');
        } catch (_) {
            return res.status(400).json({ error: 'Bad server encoding' });
        }

        const targetUrl = `${server}/${remotePath}`;

        try {
            const upstream = await rawGet(targetUrl);

            if (!upstream.ok) {
                return res.status(upstream.status).end();
            }

            const ct = upstream.headers['content-type'] || '';
            res.setHeader('Content-Type', ct || 'application/octet-stream');

            const isPlaylist =
                remotePath.endsWith('.m3u8') ||
                ct.includes('mpegurl');

            if (isPlaylist) {
                const text = upstream.body.toString('utf-8');
                return res.status(200).send(rewriteM3u8(text, encodedServer));
            } else {
                if (upstream.headers['content-length']) {
                    res.setHeader('Content-Length', upstream.headers['content-length']);
                }
                return res.status(200).send(upstream.body);
            }
        } catch (err) {
            return res.status(504).json({ error: err.message || 'Proxy error' });
        }
    }

    // ── IPTV API PROXY ─────────────────────────────────────────
    const { action, username, password, category_id, stream_id, server } = req.query;
    const baseUrl = (server ? decodeURIComponent(server) : 'http://moontools.me:8080').replace(/\/+$/, '');

    let targetUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(username || '')}&password=${encodeURIComponent(password || '')}`;
    if (action)      targetUrl += `&action=${encodeURIComponent(action)}`;
    if (category_id) targetUrl += `&category_id=${encodeURIComponent(category_id)}`;
    if (stream_id)   targetUrl += `&stream_id=${encodeURIComponent(stream_id)}`;

    try {
        const upstream = await rawGet(targetUrl, 12000);
        if (!upstream.ok) {
            return res.status(upstream.status).json({ error: `HTTP ${upstream.status}` });
        }
        return res.status(200).json(JSON.parse(upstream.body.toString('utf-8')));
    } catch (e) {
        return res.status(500).json({ error: e.message || 'Internal error' });
    }
}
