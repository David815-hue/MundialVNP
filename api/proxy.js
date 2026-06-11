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

    const { action, username, password, category_id, stream_id, server } = req.query;

    // Use default server if none provided in parameters
    const defaultServerUrl = 'http://moontools.me:8080';
    const serverUrl = (server ? decodeURIComponent(server) : defaultServerUrl).replace(/\/+$/, '');

    let targetUrl = `${serverUrl}/player_api.php?username=${encodeURIComponent(username || '')}&password=${encodeURIComponent(password || '')}`;
    
    if (action) targetUrl += `&action=${encodeURIComponent(action)}`;
    if (category_id) targetUrl += `&category_id=${encodeURIComponent(category_id)}`;
    if (stream_id) targetUrl += `&stream_id=${encodeURIComponent(stream_id)}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000); // 12 seconds timeout

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
