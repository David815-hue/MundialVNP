/**
 * Vercel Edge Function – HLS Stream Proxy
 * 
 * Uses query-parameter approach (like Cloudflare HLS-Proxy-Worker)
 * instead of path-based routing to avoid URL length/routing issues.
 * 
 * Usage:
 *   /api/proxy?t=BASE64(targetUrl)          → proxy any URL
 *   /api/proxy?action=...&username=...      → IPTV API proxy
 */
export const config = { runtime: 'edge' };

/* ── helpers ─────────────────────────────────────────────────── */
function cors(extra = {}) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        ...extra,
    };
}

function jsonResp(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: cors({ 'Content-Type': 'application/json' }),
    });
}

function encodeTarget(url) {
    // URL-safe base64
    return btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeTarget(encoded) {
    // Reverse URL-safe base64
    let s = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
}

/* ── rewrite m3u8 playlist URLs ─────────────────────────────── */
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
            // Relative path – can't resolve without base, skip
            return line;
        }

        return `/api/proxy?t=${encodeTarget(fullUrl)}`;
    }).join('\n');
}

/* ── upstream fetch headers ──────────────────────────────────── */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ── main handler ───────────────────────────────────────────── */
export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 200, headers: cors() });
    }

    const url = new URL(request.url);

    // ── STREAM/SEGMENT PROXY: ?t=BASE64_URL ─────────────────
    const t = url.searchParams.get('t');
    if (t) {
        let targetUrl;
        try {
            targetUrl = decodeTarget(t);
        } catch (_) {
            return jsonResp({ error: 'Bad target encoding' }, 400);
        }

        let targetOrigin;
        try {
            const u = new URL(targetUrl);
            targetOrigin = u.origin;
        } catch (_) {
            return jsonResp({ error: 'Invalid target URL' }, 400);
        }

        try {
            const resp = await fetch(targetUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': UA,
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': targetOrigin + '/',
                    'Origin': targetOrigin,
                },
                redirect: 'follow',
            });

            if (!resp.ok) {
                // Return diagnostic info
                return new Response(
                    `Upstream error: ${resp.status} ${resp.statusText}\nTarget: ${targetUrl}`,
                    { status: resp.status, headers: cors() }
                );
            }

            const ct = resp.headers.get('content-type') || '';
            const isPlaylist = targetUrl.endsWith('.m3u8') ||
                               ct.includes('mpegurl');

            if (isPlaylist) {
                const text = await resp.text();
                return new Response(rewriteM3u8(text, targetOrigin), {
                    status: 200,
                    headers: cors({ 'Content-Type': 'application/vnd.apple.mpegurl' }),
                });
            }

            // Binary (.ts segment, image, etc.) – stream through
            return new Response(resp.body, {
                status: 200,
                headers: cors({
                    'Content-Type': ct || 'application/octet-stream',
                }),
            });
        } catch (err) {
            return jsonResp({ error: err.message, target: targetUrl }, 502);
        }
    }

    // ── IPTV API PROXY (?action=...&username=...) ───────────
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
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json',
                'Referer': baseUrl + '/',
                'Origin': baseUrl,
            },
            redirect: 'follow',
        });
        if (!resp.ok) return jsonResp({ error: `HTTP ${resp.status}` }, resp.status);
        return jsonResp(await resp.json());
    } catch (e) {
        return jsonResp({ error: e.message }, 500);
    }
}
