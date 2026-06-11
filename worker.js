/**
 * Cloudflare Worker - IPTV HLS Stream & API Proxy
 *
 * Routes streaming segments (.ts) and playlist files (.m3u8) through the
 * worker so HTTPS pages can request HTTP upstream media without browser
 * mixed-content/CORS failures.
 */

function encodeTarget(url) {
    return btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeTarget(encoded) {
    let s = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
}

function proxyUrlFor(url, workerOrigin) {
    return `${workerOrigin}/?t=${encodeTarget(url)}`;
}

function rewriteM3u8(text, playlistUrl, workerOrigin) {
    return text.split('\n').map(line => {
        const t = line.trim();
        if (!t) return line;

        if (t.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                try {
                    return `URI="${proxyUrlFor(new URL(uri, playlistUrl).toString(), workerOrigin)}"`;
                } catch (_) {
                    return match;
                }
            });
        }

        try {
            return proxyUrlFor(new URL(t, playlistUrl).toString(), workerOrigin);
        } catch (_) {
            return line;
        }
    }).join('\n');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 5;

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
    };
}

async function fetchUpstream(targetUrl, redirectsLeft = MAX_REDIRECTS) {
    const parsedUrl = new URL(targetUrl);
    const resp = await fetch(parsedUrl.toString(), {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': parsedUrl.origin + '/',
            'Origin': parsedUrl.origin,
        },
        redirect: 'manual',
    });

    const location = resp.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(resp.status) && location && redirectsLeft > 0) {
        return fetchUpstream(new URL(location, parsedUrl).toString(), redirectsLeft - 1);
    }

    return { resp, finalUrl: parsedUrl.toString() };
}

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const workerOrigin = url.origin;

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 200,
                headers: corsHeaders(),
            });
        }

        const t = url.searchParams.get('t');

        if (t) {
            let targetUrl;
            try {
                targetUrl = decodeTarget(t);
                new URL(targetUrl);
            } catch (_) {
                return new Response('Invalid target URL', { status: 400, headers: corsHeaders() });
            }

            try {
                const { resp, finalUrl } = await fetchUpstream(targetUrl);
                const contentType = resp.headers.get('content-type') || '';
                const normalizedContentType = contentType.toLowerCase();
                const finalPath = new URL(finalUrl).pathname.toLowerCase();
                const targetPath = new URL(targetUrl).pathname.toLowerCase();
                const isPlaylist = finalPath.endsWith('.m3u8') ||
                    targetPath.endsWith('.m3u8') ||
                    normalizedContentType.includes('mpegurl') ||
                    normalizedContentType.includes('application/x-mpegurl');

                if (isPlaylist) {
                    const text = await resp.text();
                    return new Response(rewriteM3u8(text, finalUrl, workerOrigin), {
                        status: 200,
                        headers: {
                            ...corsHeaders(),
                            'Content-Type': 'application/vnd.apple.mpegurl',
                            'Cache-Control': 'no-store',
                        },
                    });
                }

                const headers = {
                    ...corsHeaders(),
                    'Content-Type': contentType || 'application/octet-stream',
                    'Cache-Control': 'public, max-age=86400',
                };
                const contentLength = resp.headers.get('content-length');
                if (contentLength) headers['Content-Length'] = contentLength;

                return new Response(resp.body, {
                    status: resp.status,
                    statusText: resp.statusText,
                    headers,
                });
            } catch (err) {
                return new Response(`Proxy error: ${err.message}`, {
                    status: 502,
                    headers: corsHeaders(),
                });
            }
        }

        const action = url.searchParams.get('action');
        const username = url.searchParams.get('username');

        if (username || action) {
            const password = url.searchParams.get('password') || '';
            const category_id = url.searchParams.get('category_id');
            const stream_id = url.searchParams.get('stream_id');
            const serverParam = url.searchParams.get('server');

            const baseUrl = (serverParam ? decodeURIComponent(serverParam) : 'http://moontools.me:8080').replace(/\/+$/, '');
            let target = `${baseUrl}/player_api.php?username=${encodeURIComponent(username || '')}&password=${encodeURIComponent(password)}`;
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
                        ...corsHeaders(),
                        'Content-Type': 'application/json',
                    },
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), {
                    status: 500,
                    headers: {
                        ...corsHeaders(),
                        'Content-Type': 'application/json',
                    },
                });
            }
        }

        return new Response('IPTV HLS Proxy Worker is running. Ready for stream requests.', {
            status: 200,
            headers: {
                ...corsHeaders(),
                'Content-Type': 'text/plain',
            },
        });
    },
};
