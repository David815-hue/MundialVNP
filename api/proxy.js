/**
 * Rewrites URLs inside an m3u8 playlist so that all segment/sub-playlist
 * URLs are routed through our Vercel proxy instead of hitting the IPTV
 * server directly (which would be blocked by Mixed Content policy).
 */
function rewriteM3u8(content, encodedServer) {
    const lines = content.split('\n');
    const proxyPrefix = `/api/proxy/s/${encodedServer}`;

    const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();

        // Skip empty lines and HLS tags
        if (!trimmed || trimmed.startsWith('#')) return line;

        // Absolute URL → encode that specific origin
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            try {
                const url = new URL(trimmed);
                const enc = Buffer.from(url.origin).toString('base64').replace(/=+$/, '');
                return `/api/proxy/s/${enc}${url.pathname}${url.search}`;
            } catch (_) {
                return line;
            }
        }

        // Root-relative path (e.g. /hlsr/…) → prepend proxy prefix
        if (trimmed.startsWith('/')) {
            return `${proxyPrefix}${trimmed}`;
        }

        // Relative path → keep as-is; the browser will resolve it
        // relative to the current proxy URL which already has the right base
        return line;
    });

    return rewrittenLines.join('\n');
}

export default async function handler(req, res) {
    // ── CORS headers ───────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, ' +
        'Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const urlPath = req.url || '';

    // ── GENERIC STREAM PROXY ───────────────────────────────────────
    // Pattern: /api/proxy/s/<BASE64_SERVER>/<any path on remote server>
    const streamMatch = urlPath.match(/\/api\/proxy\/s\/([^\/]+)\/(.+)/);

    if (streamMatch) {
        const [, encodedServer, remotePath] = streamMatch;
        let server;
        try {
            // Support base64 with or without trailing '='
            server = Buffer.from(encodedServer, 'base64').toString('utf-8');
        } catch (_) {
            res.status(400).json({ error: 'Invalid server encoding' });
            return;
        }

        const targetUrl = `${server}/${remotePath}`;

        try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 15_000);

            const upstream = await fetch(targetUrl, { signal: ctrl.signal });
            clearTimeout(tid);

            if (!upstream.ok) {
                res.status(upstream.status).end();
                return;
            }

            const ct = upstream.headers.get('content-type') || '';
            res.setHeader('Content-Type', ct || 'application/octet-stream');

            const isPlaylist =
                remotePath.endsWith('.m3u8') ||
                ct.includes('mpegurl') ||
                ct.includes('x-mpegurl');

            if (isPlaylist) {
                const text = await upstream.text();
                res.status(200).send(rewriteM3u8(text, encodedServer));
            } else {
                const cl = upstream.headers.get('content-length');
                if (cl) res.setHeader('Content-Length', cl);
                const buf = await upstream.arrayBuffer();
                res.status(200).send(Buffer.from(buf));
            }
        } catch (err) {
            res.status(err.name === 'AbortError' ? 504 : 500)
               .json({ error: err.message || 'Stream proxy error' });
        }
        return;
    }

    // ── IPTV API PROXY (player_api.php) ────────────────────────────
    const { action, username, password, category_id, stream_id, server } = req.query;

    const defaultServer = 'http://moontools.me:8080';
    const serverUrl = (server ? decodeURIComponent(server) : defaultServer).replace(/\/+$/, '');

    let targetUrl =
        `${serverUrl}/player_api.php` +
        `?username=${encodeURIComponent(username || '')}` +
        `&password=${encodeURIComponent(password || '')}`;
    if (action)      targetUrl += `&action=${encodeURIComponent(action)}`;
    if (category_id) targetUrl += `&category_id=${encodeURIComponent(category_id)}`;
    if (stream_id)   targetUrl += `&stream_id=${encodeURIComponent(stream_id)}`;

    try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 12_000);

        const upstream = await fetch(targetUrl, { signal: ctrl.signal });
        clearTimeout(tid);

        if (!upstream.ok) {
            res.status(upstream.status).json({ error: `HTTP ${upstream.status}` });
            return;
        }
        res.status(200).json(await upstream.json());
    } catch (e) {
        res.status(e.name === 'AbortError' ? 504 : 500)
           .json({ error: e.message || 'Internal Server Error' });
    }
}
