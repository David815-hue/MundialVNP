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

function proxyUrlFor(url) {
    return `/api/proxy?t=${encodeTarget(url)}`;
}

// Rewrite m3u8 playlist URLs to pass back through the proxy
function rewriteM3u8(text, playlistUrl) {
    return text.split('\n').map(line => {
        const t = line.trim();
        if (!t) return line;

        if (t.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                try {
                    return `URI="${proxyUrlFor(new URL(uri, playlistUrl).toString())}"`;
                } catch (_) {
                    return match;
                }
            });
        }

        try {
            return proxyUrlFor(new URL(t, playlistUrl).toString());
        } catch (_) {
            return line;
        }
    }).join('\n');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 5;
const PLAYLIST_RETRIES = 2;
const UPSTREAM_TIMEOUT_MS = 4000;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
};

function requestTarget(targetUrl, redirectsLeft, onResponse, onError, timeoutMs = 6000) {
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch (err) {
        onError(err);
        return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    let completed = false;

    const targetReq = client.request(parsedUrl, {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': parsedUrl.origin + '/',
            'Origin': parsedUrl.origin,
            'Content-Length': '0',
        }
    }, (targetRes) => {
        if (completed) return;
        const status = targetRes.statusCode || 200;
        const location = targetRes.headers.location;

        if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
            completed = true;
            targetRes.resume();
            requestTarget(new URL(location, parsedUrl).toString(), redirectsLeft - 1, onResponse, onError, timeoutMs);
            return;
        }

        completed = true;
        onResponse(targetRes, parsedUrl.toString());
    });

    targetReq.on('error', (err) => {
        if (completed) return;
        completed = true;
        onError(err);
    });

    targetReq.setTimeout(timeoutMs, () => {
        if (completed) return;
        completed = true;
        targetReq.destroy(new Error('Connection timed out to IPTV server'));
        onError(new Error('Timeout'));
    });

    targetReq.end();
}

function fetchUpstreamWithRedirects(targetUrl, redirectsLeft = MAX_REDIRECTS, timeoutMs = UPSTREAM_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try {
            parsedUrl = new URL(targetUrl);
        } catch (err) {
            reject(err);
            return;
        }

        const client = parsedUrl.protocol === 'https:' ? https : http;
        let completed = false;

        const targetReq = client.request(parsedUrl, {
            method: 'GET',
            headers: {
                'User-Agent': UA,
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': parsedUrl.origin + '/',
                'Origin': parsedUrl.origin,
                'Content-Length': '0', // Force Content-Length: 0 on TCP socket to satisfy strict Nginx servers (fix 411)
            }
        }, (targetRes) => {
            if (completed) return;
            const status = targetRes.statusCode || 200;
            const location = targetRes.headers.location;

            if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
                completed = true;
                targetRes.resume();
                fetchUpstreamWithRedirects(new URL(location, parsedUrl).toString(), redirectsLeft - 1, timeoutMs)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            completed = true;
            resolve({ res: targetRes, finalUrl: parsedUrl.toString() });
        });

        targetReq.on('error', (err) => {
            if (completed) return;
            completed = true;
            reject(err);
        });

        targetReq.setTimeout(timeoutMs, () => {
            if (completed) return;
            completed = true;
            targetReq.destroy(new Error('Connection timed out to IPTV server'));
            reject(new Error('Timeout'));
        });

        targetReq.end();
    });
}

async function fetchPlaylistWithRetry(targetUrl) {
    let lastResult = null;

    for (let attempt = 1; attempt <= PLAYLIST_RETRIES; attempt += 1) {
        try {
            const { res: response, finalUrl } = await fetchUpstreamWithRedirects(targetUrl);
            
            const text = await new Promise((resolve, reject) => {
                let body = '';
                response.on('data', chunk => {
                    body += chunk;
                });
                response.on('end', () => {
                    resolve(body);
                });
                response.on('error', err => {
                    reject(err);
                });
            });

            lastResult = {
                attempt,
                status: response.statusCode || 200,
                finalUrl,
                text,
                contentType: response.headers['content-type'] || '',
            };

            if (lastResult.status === 200 && text.trimStart().startsWith('#EXTM3U')) {
                return lastResult;
            }
        } catch (err) {
            lastResult = {
                attempt,
                status: 500,
                finalUrl: targetUrl,
                text: err.message,
                contentType: 'text/plain',
            };
        }
    }

    return lastResult;
}

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

        try {
            new URL(targetUrl);
        } catch (_) {
            res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid target URL' }));
            return;
        }

        const initialPath = new URL(targetUrl).pathname.toLowerCase();
        if (initialPath.endsWith('.m3u8')) {
            fetchPlaylistWithRetry(targetUrl).then((playlistResult) => {
                if (!playlistResult || !playlistResult.text.trimStart().startsWith('#EXTM3U')) {
                    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Invalid or empty playlist from upstream',
                        target: targetUrl,
                        finalUrl: playlistResult?.finalUrl || null,
                        upstreamStatus: playlistResult?.status || null,
                        upstreamContentType: playlistResult?.contentType || null,
                        upstreamLength: playlistResult?.text.length || 0,
                        attempts: playlistResult?.attempt || PLAYLIST_RETRIES,
                        preview: playlistResult?.text.slice(0, 120) || '',
                    }));
                    return;
                }

                const rewritten = rewriteM3u8(playlistResult.text, playlistResult.finalUrl);
                res.writeHead(200, {
                    ...corsHeaders,
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Cache-Control': 'no-store',
                });
                res.end(rewritten);
            }).catch((err) => {
                res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message, target: targetUrl }));
            });
            return;
        }

        requestTarget(targetUrl, MAX_REDIRECTS, (targetRes, finalUrl) => {
            const status = targetRes.statusCode || 200;
            const ct = targetRes.headers['content-type'] || '';
            const contentType = String(ct).toLowerCase();
            const finalPath = new URL(finalUrl).pathname.toLowerCase();
            const targetPath = new URL(targetUrl).pathname.toLowerCase();
            const isPlaylist = finalPath.endsWith('.m3u8') ||
                               targetPath.endsWith('.m3u8') ||
                               contentType.includes('mpegurl') ||
                               contentType.includes('application/x-mpegurl');

            if (isPlaylist) {
                let data = '';
                targetRes.on('data', chunk => {
                    data += chunk;
                });
                targetRes.on('end', () => {
                    if (!data.trimStart().startsWith('#EXTM3U')) {
                        res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: 'Invalid or empty playlist from upstream',
                            target: targetUrl,
                            finalUrl,
                            upstreamStatus: status,
                            upstreamContentType: ct,
                            upstreamLength: data.length,
                            preview: data.slice(0, 120),
                        }));
                        return;
                    }

                    const rewritten = rewriteM3u8(data, finalUrl);
                    res.writeHead(200, {
                        ...corsHeaders,
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Cache-Control': 'no-store',
                    });
                    res.end(rewritten);
                });
            } else {
                // Stream binary video segments (.ts) directly to client
                const headers = {
                    ...corsHeaders,
                    'Content-Type': ct || 'application/octet-stream',
                    'Cache-Control': 'public, max-age=86400',
                };
                if (targetRes.headers['content-length']) {
                    headers['Content-Length'] = targetRes.headers['content-length'];
                }
                res.writeHead(status, headers);
                targetRes.pipe(res);
            }
        }, (err) => {
            res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message, target: targetUrl }));
        });
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
