/**
 * Vercel EDGE Function – runs on V8 (like Cloudflare Workers),
 * NOT on Node.js.  This avoids the header-stripping issue that
 * caused the IPTV server to return 411 "Length Required".
 */
export const config = { runtime: 'edge' };

/* ── rewrite m3u8 playlist URLs ─────────────────────────────── */
function rewriteM3u8(text, encodedServer) {
    const prefix = `/api/proxy/s/${encodedServer}`;
    return text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        if (t.startsWith('http://') || t.startsWith('https://')) {
            try {
                const u = new URL(t);
                const enc = btoa(u.origin).replace(/=+$/, '');
                return `/api/proxy/s/${enc}${u.pathname}${u.search}`;
            } catch (_) { return line; }
        }
        if (t.startsWith('/')) return `${prefix}${t}`;
        return line;
    }).join('\n');
}

/* ── headers we send to the IPTV server ─────────────────────── */
const UPSTREAM_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
};

/* ── main handler ───────────────────────────────────────────── */
export default async function handler(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── CORS preflight ──────────────────────────────────────
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,OPTIONS',
                'Access-Control-Allow-Headers': '*',
            },
        });
    }

    // ── STREAM PROXY: /api/proxy/s/<BASE64>/<remotePath> ────
    const m = path.match(/^\/api\/proxy\/s\/([^\/]+)\/(.+)/);

    if (m) {
        const [, enc, remotePath] = m;
        let server;
        try { server = atob(enc); }
        catch (_) {
            return json({ error: 'Bad server encoding' }, 400);
        }

        // Build target URL  (include query string if any)
        const qs = url.search || '';
        const targetUrl = `${server}/${remotePath}${qs}`;

        try {
            const resp = await fetch(targetUrl, {
                method: 'GET',
                headers: UPSTREAM_HEADERS,
                redirect: 'follow',
            });

            if (!resp.ok) {
                return new Response(`Upstream ${resp.status}`, {
                    status: resp.status,
                    headers: cors(),
                });
            }

            const ct = resp.headers.get('content-type') || '';
            const isPlaylist = remotePath.endsWith('.m3u8') ||
                               ct.includes('mpegurl');

            if (isPlaylist) {
                const text = await resp.text();
                return new Response(rewriteM3u8(text, enc), {
                    status: 200,
                    headers: {
                        ...cors(),
                        'Content-Type': ct || 'application/vnd.apple.mpegurl',
                    },
                });
            }

            // Binary segment (.ts) – stream it through
            return new Response(resp.body, {
                status: 200,
                headers: {
                    ...cors(),
                    'Content-Type': ct || 'video/mp2t',
                },
            });

        } catch (err) {
            return json({ error: err.message }, 502);
        }
    }

    // ── IPTV API PROXY (player_api.php) ─────────────────────
    const action      = url.searchParams.get('action');
    const username    = url.searchParams.get('username') || '';
    const password    = url.searchParams.get('password') || '';
    const category_id = url.searchParams.get('category_id');
    const stream_id   = url.searchParams.get('stream_id');
    const serverParam = url.searchParams.get('server');

    const baseUrl = (serverParam ? decodeURIComponent(serverParam) : 'http://moontools.me:8080').replace(/\/+$/, '');

    let target = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    if (action)      target += `&action=${encodeURIComponent(action)}`;
    if (category_id) target += `&category_id=${encodeURIComponent(category_id)}`;
    if (stream_id)   target += `&stream_id=${encodeURIComponent(stream_id)}`;

    try {
        const resp = await fetch(target, {
            headers: UPSTREAM_HEADERS,
            redirect: 'follow',
        });
        if (!resp.ok) return json({ error: `HTTP ${resp.status}` }, resp.status);
        const data = await resp.json();
        return json(data, 200);
    } catch (e) {
        return json({ error: e.message }, 500);
    }
}

/* ── helpers ─────────────────────────────────────────────────── */
function cors() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
    };
}
function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            ...cors(),
            'Content-Type': 'application/json',
        },
    });
}
