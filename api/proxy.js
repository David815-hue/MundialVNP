function rewriteM3u8(content, encodedServer, username, password) {
    const lines = content.split('\n');
    const base64Prefix = `/api/proxy/live/${encodedServer}/${username}/${password}`;
    
    const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            return line;
        }
        
        // If it's an absolute URL
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            try {
                const url = new URL(trimmed);
                const host = url.origin;
                const path = url.pathname + url.search;
                const newEncodedServer = Buffer.from(host).toString('base64').replace(/=+$/, '');
                return `/api/proxy/live/${newEncodedServer}/${username}/${password}${path}`;
            } catch (e) {
                return line;
            }
        }
        
        // If it's a root-relative path (starts with /)
        if (trimmed.startsWith('/')) {
            return `${base64Prefix}${trimmed}`;
        }
        
        // If it's a relative path, let the browser resolve it naturally
        return line;
    });
    
    return rewrittenLines.join('\n');
}

export default async function handler(req, res) {
    // Enable CORS for Vercel
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Check if it's a stream proxy request (e.g. /api/proxy/live/BASE64_SERVER/username/password/stream_path)
    const urlPath = req.url || '';
    const match = urlPath.match(/\/api\/proxy\/live\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)/);
    
    if (match) {
        const [_, encodedServer, username, password, filename] = match;
        let server;
        try {
            server = Buffer.from(encodedServer, 'base64').toString('utf-8');
        } catch (e) {
            res.status(400).json({ error: 'Invalid server encoding' });
            return;
        }

        const targetUrl = `${server}/live/${username}/${password}/${filename}`;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout

            const response = await fetch(targetUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                res.status(response.status).end();
                return;
            }

            const contentType = response.headers.get('content-type') || '';
            res.setHeader('Content-Type', contentType || 'application/octet-stream');

            const isPlaylist = filename.endsWith('.m3u8') || 
                               contentType.includes('mpegurl') || 
                               contentType.includes('x-mpegurl');

            if (isPlaylist) {
                // Read as text, rewrite URLs inside playlist to go through proxy
                const playlistText = await response.text();
                const rewritten = rewriteM3u8(playlistText, encodedServer, username, password);
                res.status(200).send(rewritten);
            } else {
                // Pipe binary data (e.g. TS segments)
                const contentLength = response.headers.get('content-length');
                if (contentLength) {
                    res.setHeader('Content-Length', contentLength);
                }
                const bodyBuffer = await response.arrayBuffer();
                res.status(200).send(Buffer.from(bodyBuffer));
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                res.status(504).json({ error: 'Stream fetch timed out' });
            } else {
                res.status(500).json({ error: err.message || 'Stream fetch error' });
            }
        }
        return;
    }

    // Existing API proxy logic for player_api.php
    const { action, username, password, category_id, stream_id, server } = req.query;

    const defaultServerUrl = 'http://moontools.me:8080';
    const serverUrl = (server ? decodeURIComponent(server) : defaultServerUrl).replace(/\/+$/, '');

    let targetUrl = `${serverUrl}/player_api.php?username=${encodeURIComponent(username || '')}&password=${encodeURIComponent(password || '')}`;
    
    if (action) targetUrl += `&action=${encodeURIComponent(action)}`;
    if (category_id) targetUrl += `&category_id=${encodeURIComponent(category_id)}`;
    if (stream_id) targetUrl += `&stream_id=${encodeURIComponent(stream_id)}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        const response = await fetch(targetUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            res.status(response.status).json({ error: `Server returned HTTP ${response.status}` });
            return;
        }

        const data = await response.json();
        res.status(200).json(data);
    } catch (e) {
        if (e.name === 'AbortError') {
            res.status(504).json({ error: 'Gateway Timeout: IPTV server took too long to respond.' });
        } else {
            res.status(500).json({ error: e.message || 'Internal Server Error' });
        }
    }
}
