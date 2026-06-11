import http from 'http';
import https from 'https';
import { URL } from 'url';

// URL-safe base64 helpers
function encodeTarget(url) {
    return Buffer.from(url).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeTarget(encoded) {
    let s = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf-8');
}

// Rewrite m3u8 playlist URLs to pass back through the proxy
function rewriteM3u8(text, serverOrigin) {
    return text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;

        let fullUrl;
        if (t.startsWith('http://') || t.startsWith('https://')) {
            fullUrl = t;
        } else if (t.startsWith('/')) {
            fullUrl = serverOrigin + t;
        } else {
            fullUrl = serverOrigin + '/' + t;
        }

        return `/api/proxy?t=${encodeTarget(fullUrl)}`;
    }).join('\n');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
};

export default function handler(req, res) {
    // Handle OPTIONS request for CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, corsHeaders);
        res.end();
        return;
    }

    const host = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const reqUrl = new URL(req.url, `${protocol}://${host}`);

    const t = reqUrl.searchParams.get('t');

    // ── 1. STREAM & PLAYLIST PROXY (?t=BASE64_URL) ──
    if (t) {
        let targetUrl;
        try {
            targetUrl = decodeTarget(t);
        } catch (_) {
            res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad target encoding' }));
            return;
        }

        let targetOrigin;
        let isHttps = false;
        try {
            const u = new URL(targetUrl);
            targetOrigin = u.origin;
            isHttps = u.protocol === 'https:';
        } catch (_) {
            res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid target URL' }));
            return;
        }

        const client = isHttps ? https : http;

        const targetReq = client.request(targetUrl, {
            method: 'GET',
            headers: {
                'User-Agent': UA,
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': targetOrigin + '/',
                'Origin': targetOrigin,
                'Content-Length': '0', // Force Content-Length: 0 on TCP socket to satisfy strict Nginx servers (fix 411)
            }
        }, (targetRes) => {
            const status = targetRes.statusCode || 200;
            const ct = targetRes.headers['content-type'] || '';
            const isPlaylist = targetUrl.endsWith('.m3u8') || 
                               ct.includes('mpegurl') || 
                               ct.includes('application/x-mpegURL');

            if (isPlaylist) {
                let data = '';
                targetRes.on('data', chunk => {
                    data += chunk;
                });
                targetRes.on('end', () => {
                    const rewritten = rewriteM3u8(data, targetOrigin);
                    res.writeHead(200, {
                        ...corsHeaders,
                        'Content-Type': 'application/vnd.apple.mpegurl',
                    });
                    res.end(rewritten);
                });
            } else {
                // Stream binary video segments (.ts) directly to client
                res.writeHead(status, {
                    ...corsHeaders,
                    'Content-Type': ct || 'application/octet-stream',
                    'Cache-Control': 'public, max-age=86400',
                });
                targetRes.pipe(res);
            }
        });

        targetReq.on('error', (err) => {
            res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message, target: targetUrl }));
        });

        targetReq.end();
        return;
    }

    // ── 2. IPTV PLAYER API PROXY (for player_api.php) ──
    const action = reqUrl.searchParams.get('action');
    const username = reqUrl.searchParams.get('username') || '';
    const password = reqUrl.searchParams.get('password') || '';
    const category_id = reqUrl.searchParams.get('category_id');
    const stream_id = reqUrl.searchParams.get('stream_id');
    const serverParam = reqUrl.searchParams.get('server');

    const baseUrl = (serverParam ? decodeURIComponent(serverParam) : 'http://moontools.me:8080').replace(/\/+$/, '');
    let target = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    if (action) target += `&action=${encodeURIComponent(action)}`;
    if (category_id) target += `&category_id=${encodeURIComponent(category_id)}`;
    if (stream_id) target += `&stream_id=${encodeURIComponent(stream_id)}`;

    const isHttps = target.startsWith('https:');
    const client = isHttps ? https : http;

    const targetReq = client.request(target, {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Referer': baseUrl + '/',
            'Origin': baseUrl,
            'Content-Length': '0',
        }
    }, (targetRes) => {
        const status = targetRes.statusCode || 200;
        res.writeHead(status, {
            ...corsHeaders,
            'Content-Type': 'application/json',
        });
        targetRes.pipe(res);
    });

    targetReq.on('error', (err) => {
        res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    });

    targetReq.end();
}
