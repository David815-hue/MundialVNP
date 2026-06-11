/**
 * Cloudflare Worker – IPTV HLS Stream & API Proxy
 * 
 * Bypasses CORS and Mixed Content (HTTP/HTTPS) issues.
 * Routes streaming segments (.ts) and playlist files (.m3u8) transparently.
 * Can be deployed for FREE on Cloudflare Workers.
 * 
 * How to deploy:
 * 1. Go to Cloudflare Dashboard -> Workers & Pages -> Create a Worker.
 * 2. Paste this code.
 * 3. Deploy it and copy your Worker URL.
 * 4. Paste the URL into `app.js` (CLOUDFLARE_WORKER_URL).
 */

// URL-safe Base64 encoding/decoding helpers
function encodeTarget(url) {
    return btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeTarget(encoded) {
    let s = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
}

// Rewrite m3u8 playlist URLs to route through this worker
function rewriteM3u8(text, serverOrigin, workerOrigin) {
    return text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;

        let fullUrl;
        if (t.startsWith('http://') || t.startsWith('https://')) {
            fullUrl = t;
        } else if (t.startsWith('/')) {
            fullUrl = serverOrigin + t;
        } else {
            // Relative path – resolve using target origin
            fullUrl = serverOrigin + '/' + t;
        }

        return `${workerOrigin}/?t=${encodeTarget(fullUrl)}`;
    }).join('\n');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function corsHeaders(request) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
    };
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const workerOrigin = url.origin;

        // Handle CORS preflight (OPTIONS)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 200,
                headers: corsHeaders(request)
            });
        }

        const t = url.searchParams.get('t');

        // ── 1. STREAM & PLAYLIST PROXY (?t=BASE64_URL) ──
        if (t) {
            let targetUrl;
            try {
                targetUrl = decodeTarget(t);
            } catch (_) {
                return new Response('Bad target encoding', { status: 400, headers: corsHeaders(request) });
            }

            let targetOrigin;
            try {
                const u = new URL(targetUrl);
                targetOrigin = u.origin;
            } catch (_) {
                return new Response('Invalid target URL', { status: 400, headers: corsHeaders(request) });
            }

            try {
                // Fetch from upstream server
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

                // Read Content-Type header
                const contentType = resp.headers.get('content-type') || '';
                const isPlaylist = targetUrl.endsWith('.m3u8') || 
                                   contentType.includes('mpegurl') || 
                                   contentType.includes('application/x-mpegURL');

                if (isPlaylist) {
                    const text = await resp.text();
                    const rewrittenText = rewriteM3u8(text, targetOrigin, workerOrigin);
                    
                    return new Response(rewrittenText, {
                        status: 200,
                        headers: {
                            ...corsHeaders(request),
                            'Content-Type': 'application/vnd.apple.mpegurl',
                        }
                    });
                }

                // For video segments (.ts, etc.), stream response back
                return new Response(resp.body, {
                    status: resp.status,
                    statusText: resp.statusText,
                    headers: {
                        ...corsHeaders(request),
                        'Content-Type': contentType || 'application/octet-stream',
                        'Cache-Control': 'public, max-age=86400',
                    }
                });
            } catch (err) {
                return new Response(`Proxy error: ${err.message}`, { status: 502, headers: corsHeaders(request) });
            }
        }

        // ── 2. IPTV PLAYER API PROXY (for player_api.php) ──
        const action = url.searchParams.get('action');
        const username = url.searchParams.get('username');
        
        if (username || action) {
            const password = url.searchParams.get('password') || '';
            const category_id = url.searchParams.get('category_id');
            const stream_id = url.searchParams.get('stream_id');
            const serverParam = url.searchParams.get('server');

            const baseUrl = (serverParam ? decodeURIComponent(serverParam) : 'http://moontools.me:8080').replace(/\/+$/, '');
            let target = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
            if (action) target += `&action=${encodeURIComponent(action)}`;
            if (category_id) target += `&category_id=${encodeURIComponent(category_id)}`;
            if (stream_id) target += `&stream_id=${encodeURIComponent(stream_id)}`;

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

                const json = await resp.json();
                return new Response(JSON.stringify(json), {
                    status: 200,
                    headers: {
                        ...corsHeaders(request),
                        'Content-Type': 'application/json'
                    }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), {
                    status: 500,
                    headers: {
                        ...corsHeaders(request),
                        'Content-Type': 'application/json'
                    }
                });
            }
        }

        // ── 3. Fallback / Default response ──
        return new Response('IPTV HLS Proxy Worker is running. Ready for stream requests.', {
            status: 200,
            headers: {
                ...corsHeaders(request),
                'Content-Type': 'text/plain'
            }
        });
    }
};
