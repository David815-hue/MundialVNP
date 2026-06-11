/* ==========================================================================
   CineRide Live TV - World Cup 2026 Edition
   Main JavaScript Application Logic
   ========================================================================== */

   document.addEventListener('DOMContentLoaded', () => {
    // Default IPTV Server Credentials (MoonTools)
    const DEFAULT_SERVER = 'http://moontools.me:8080';
    const DEFAULT_USER = 'chrisquint';
    const DEFAULT_PASS = 'sWSACrWGMY';

    // Application State
    let categories = [];
    let channels = [];
    let favorites = [];
    let selectedCategoryId = 'all';
    let searchQuery = '';
    
    // DOM Elements
    const categoryList = document.getElementById('category-list');
    const categoryCount = document.getElementById('category-count');
    const channelsGrid = document.getElementById('channels-grid');
    const channelCount = document.getElementById('channel-count');
    const currentCategoryTitle = document.getElementById('current-category-title');
    const searchInput = document.getElementById('search-input');
    
    const settingsModal = document.getElementById('settings-modal');
    const serverSettingsBtn = document.getElementById('server-settings-btn');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    const testConnectionBtn = document.getElementById('test-connection-btn');
    
    const settingsServerInput = document.getElementById('settings-server');
    const settingsUserInput = document.getElementById('settings-user');
    const settingsPassInput = document.getElementById('settings-pass');
    
    const modalError = document.getElementById('modal-error');
    const modalSuccess = document.getElementById('modal-success');
    
    // Cinema Mode Elements
    const cinemaModeBtn = document.getElementById('cinema-mode-btn');
    const cinemaCloseFloating = document.getElementById('cinema-close-floating');

    // Load Saved Credentials
    const getCredentials = () => {
        return {
            server: localStorage.getItem('mtv_server') || DEFAULT_SERVER,
            username: localStorage.getItem('mtv_user') || DEFAULT_USER,
            password: localStorage.getItem('mtv_pass') || DEFAULT_PASS
        };
    };

    // Load Favorites from localStorage
    const loadFavorites = () => {
        try {
            favorites = JSON.parse(localStorage.getItem('mtv_favorites') || '[]');
        } catch (_) {
            favorites = [];
        }
    };

    const saveFavorites = () => {
        localStorage.setItem('mtv_favorites', JSON.stringify(favorites));
    };

    const isFavorite = (streamId) => {
        return favorites.includes(String(streamId));
    };

    const toggleFavorite = (streamId) => {
        const id = String(streamId);
        if (favorites.includes(id)) {
            favorites = favorites.filter(f => f !== id);
        } else {
            favorites.push(id);
        }
        saveFavorites();
        renderChannels();
    };

    // Populate Settings Modal Inputs
    const populateSettingsInputs = () => {
        const creds = getCredentials();
        settingsServerInput.value = creds.server;
        settingsUserInput.value = creds.username;
        settingsPassInput.value = creds.password;
    };

    // Helper: Determine API endpoint based on Vercel vs Local context
    const getApiUrl = (action, params = {}) => {
        const creds = getCredentials();
        const isLocal = window.location.protocol === 'file:' || 
                        window.location.hostname === 'localhost' || 
                        window.location.hostname === '127.0.0.1';

        const serverParam = encodeURIComponent(creds.server);
        const userParam = encodeURIComponent(creds.username);
        const passParam = encodeURIComponent(creds.password);

        if (isLocal) {
            // Local development or file protocol: fetch direct to bypass CORS if server supports it
            let url = `${creds.server}/player_api.php?username=${userParam}&password=${passParam}`;
            if (action) url += `&action=${action}`;
            for (const [key, val] of Object.entries(params)) {
                url += `&${key}=${encodeURIComponent(val)}`;
            }
            return url;
        } else {
            // Deployed environment: Route through Vercel Serverless Function Proxy
            let url = `/api/proxy?username=${userParam}&password=${passParam}&server=${serverParam}`;
            if (action) url += `&action=${action}`;
            for (const [key, val] of Object.entries(params)) {
                url += `&${key}=${encodeURIComponent(val)}`;
            }
            return url;
        }
    };

    // Fetch API Data
    const fetchApi = async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    };

    // Helper to identify adult content (to filter out)
    const isAdultContent = (text) => {
        if (!text) return false;
        const lower = text.toLowerCase();
        return lower.includes('adult') || 
               lower.includes('xxx') || 
               lower.includes('18+') || 
               lower.includes('erotic') ||
               lower.includes('erótic') || 
               lower.includes('forbiden') ||
               lower.includes('sensual') ||
               lower.includes('playboy') ||
               lower.includes('venus') ||
               lower.includes('sextet');
    };

    // Helper to identify World Cup/Soccer related content
    const isWorldCupContent = (text) => {
        if (!text) return false;
        const lower = text.toLowerCase();
        return lower.includes('mundial') || 
               lower.includes('fifa') || 
               lower.includes('world cup') ||
               lower.includes('fútbol') ||
               lower.includes('futbol');
    };

    // Initialize Application
    const initApp = async () => {
        loadFavorites();
        populateSettingsInputs();
        
        try {
            // 1. Fetch Categories
            categoryList.innerHTML = '<div class="sidebar-skeleton"></div>';
            const categoriesData = await fetchApi(getApiUrl('get_live_categories'));
            const rawCategories = Array.isArray(categoriesData) ? categoriesData : [];
            
            // Filter to only keep World Cup related categories (and exclude any adult terms)
            categories = rawCategories.filter(cat => 
                isWorldCupContent(cat.category_name) && !isAdultContent(cat.category_name)
            );

            // Default to 'Copa Mundial FIFA' if it exists, otherwise to first category, otherwise to favorites
            if (categories.length > 0) {
                const defaultCat = categories.find(cat => 
                    (cat.category_name || '').toLowerCase().includes('copa mundial fifa')
                ) || categories[0];
                selectedCategoryId = String(defaultCat.category_id);
                currentCategoryTitle.textContent = defaultCat.category_name;
            } else {
                selectedCategoryId = 'favs';
                currentCategoryTitle.textContent = 'Mis Favoritos';
            }
            
            // Render category selector
            renderCategories();

            // 2. Fetch All Channels
            channelsGrid.innerHTML = '<div class="grid-skeleton"></div>';
            const channelsData = await fetchApi(getApiUrl('get_live_streams'));
            const rawChannels = Array.isArray(channelsData) ? channelsData : [];
            
            // Get set of valid category IDs to filter channels
            const validCategoryIds = new Set(categories.map(cat => String(cat.category_id)));
            
            // Filter channels: must belong to a World Cup category and not contain adult words in name
            channels = rawChannels.filter(chan => {
                if (!validCategoryIds.has(String(chan.category_id))) return false;
                return !isAdultContent(chan.name);
            });

            // Render channels grid
            renderChannels();
        } catch (error) {
            console.error('Initialization error:', error);
            channelsGrid.innerHTML = `
                <div class="player-placeholder">
                    <div class="placeholder-content">
                        <span style="font-size:3rem;">⚠️</span>
                        <h3>Error de Conexión</h3>
                        <p>No se pudo conectar con el servidor IPTV. Por favor verifica tus ajustes de servidor.</p>
                        <button id="error-settings-btn" class="btn-primary" style="margin-top:10px; width:auto; padding: 10px 20px;">Abrir Ajustes</button>
                    </div>
                </div>
            `;
            document.getElementById('error-settings-btn')?.addEventListener('click', openSettings);
            categoryList.innerHTML = '<div class="cat-btn" style="text-align:center;color:var(--gold-trophy);">Error</div>';
            categoryCount.textContent = '0';
            channelCount.textContent = '0';
        }
    };

    // Render Categories in Sidebar
    const renderCategories = () => {
        categoryCount.textContent = categories.length;
        
        let html = `
            <button class="cat-btn ${selectedCategoryId === 'favs' ? 'active' : ''}" data-cat-id="favs">
                <span>⭐ Mis Favoritos</span>
            </button>
        `;

        categories.forEach(cat => {
            html += `
                <button class="cat-btn ${selectedCategoryId === String(cat.category_id) ? 'active' : ''}" data-cat-id="${cat.category_id}">
                    <span>⚽ ${cat.category_name}</span>
                </button>
            `;
        });

        categoryList.innerHTML = html;

        // Add Event Listeners to Category Buttons
        categoryList.querySelectorAll('.cat-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const button = e.currentTarget;
                selectedCategoryId = button.getAttribute('data-cat-id');
                
                // Update active state in UI
                categoryList.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
                button.classList.add('active');

                // Update category title and render
                if (selectedCategoryId === 'all') {
                    currentCategoryTitle.textContent = 'Todos los Canales';
                } else if (selectedCategoryId === 'favs') {
                    currentCategoryTitle.textContent = 'Mis Favoritos';
                } else {
                    const catObj = categories.find(c => String(c.category_id) === selectedCategoryId);
                    currentCategoryTitle.textContent = catObj ? catObj.category_name : 'Canales';
                }

                renderChannels();
                
                // Scroll to top of grid
                channelsGrid.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        });
    };

    // Render Channels Grid
    const renderChannels = () => {
        let filtered = channels;

        // Filter by Category
        if (selectedCategoryId === 'favs') {
            filtered = channels.filter(chan => isFavorite(chan.stream_id));
        } else if (selectedCategoryId !== 'all') {
            filtered = channels.filter(chan => String(chan.category_id) === selectedCategoryId);
        }

        // Filter by Search Query
        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            filtered = filtered.filter(chan => String(chan.name || '').toLowerCase().includes(query));
        }

        channelCount.textContent = filtered.length;

        if (filtered.length === 0) {
            channelsGrid.innerHTML = `
                <div class="player-placeholder" style="grid-column: 1 / -1; min-height: 200px; background: transparent;">
                    <div class="placeholder-content">
                        <span>⚽</span>
                        <h3>Sin canales</h3>
                        <p>No se encontraron canales en esta categoría.</p>
                    </div>
                </div>
            `;
            return;
        }

        let html = '';
        filtered.forEach(chan => {
            const isFav = isFavorite(chan.stream_id);
            const activeClass = window.activeStreamId === String(chan.stream_id) ? 'active' : '';
            const fallbackImg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect fill="#0a160e" width="40" height="40"/><text fill="#e5a00d" font-family="Arial,sans-serif" font-size="10" text-anchor="middle" x="20" y="24">TV</text></svg>');
            
            html += `
                <div class="channel-card ${activeClass}" data-stream-id="${chan.stream_id}">
                    <div class="channel-card-logo-wrap">
                        <img class="channel-card-logo" src="${chan.stream_icon || fallbackImg}" alt="" onerror="this.src='${fallbackImg}'">
                        <span class="channel-card-num">#${chan.num || chan.stream_id}</span>
                    </div>
                    <span class="channel-card-name" title="${chan.name}">${chan.name}</span>
                    <button class="channel-fav-star-btn ${isFav ? 'active' : ''}" style="position:absolute; top:6px; right:6px; background:none; border:none; cursor:pointer;" data-fav-id="${chan.stream_id}">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="${isFav ? 'var(--gold-trophy)' : 'none'}" stroke="${isFav ? 'var(--gold-trophy)' : 'rgba(255,255,255,0.4)'}" stroke-width="2.5">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                    </button>
                </div>
            `;
        });

        channelsGrid.innerHTML = html;

        // Add click events to channel cards
        channelsGrid.querySelectorAll('.channel-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Ignore click if it's the favorite button
                if (e.target.closest('.channel-fav-star-btn')) return;

                const streamId = card.getAttribute('data-stream-id');
                const chan = channels.find(c => String(c.stream_id) === streamId);
                if (chan) {
                    playChannel(chan);
                }
            });
        });

        // Add click events to favorite stars
        channelsGrid.querySelectorAll('.channel-fav-star-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const streamId = btn.getAttribute('data-fav-id');
                toggleFavorite(streamId);
            });
        });
    };

    // Play Selected Channel
    const playChannel = (chan) => {
        const video = document.getElementById('video-player');
        const placeholder = document.getElementById('player-placeholder');
        const infoPanel = document.getElementById('player-channel-info');
        
        window.activeStreamId = String(chan.stream_id);
        
        // Highlight active card
        document.querySelectorAll('.channel-card').forEach(card => {
            if (card.getAttribute('data-stream-id') === window.activeStreamId) {
                card.classList.add('active');
            } else {
                card.classList.remove('active');
            }
        });

        const creds = getCredentials();
        
        // Stream format: http://domain:port/live/username/password/stream_id.m3u8
        const streamUrl = `${creds.server}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${chan.stream_id}.m3u8`;

        // Hide placeholder and show info
        placeholder.style.opacity = '0';
        setTimeout(() => {
            placeholder.style.display = 'none';
        }, 300);

        infoPanel.style.display = 'block';
        document.getElementById('player-channel-name').textContent = chan.name;
        document.getElementById('player-channel-num').textContent = `Canal #${chan.num || chan.stream_id}`;
        document.getElementById('player-channel-icon').src = chan.stream_icon || '';

        // Initialize hls.js or Native Player
        if (Hls.isSupported()) {
            if (window.hls) {
                window.hls.destroy();
            }
            const hls = new Hls({
                maxMaxBufferLength: 15,
                liveSyncDurationCount: 3,
                enableWorker: true
            });
            hls.loadSource(streamUrl);
            hls.attachMedia(video);
            window.hls = hls;
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(e => console.warn('Autoplay prevented', e));
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.warn('Network error, retrying...');
                            hls.startLoad();
                             break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.warn('Media error, recovering...');
                            hls.recoverMediaError();
                            break;
                        default:
                            console.error('Fatal HLS error, destroying player', data);
                            hls.destroy();
                            break;
                    }
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari native support
            video.src = streamUrl;
            video.addEventListener('loadedmetadata', () => {
                video.play();
            });
        } else {
            alert('Este navegador no soporta streaming HLS (.m3u8). Intenta con Google Chrome o Safari.');
        }

        // Scroll player container into view on mobile
        if (window.innerWidth <= 880) {
            document.querySelector('.player-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    };

    // Live search input handler
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        renderChannels();
    });

    // --- Settings Modal Handlers ---
    const openSettings = () => {
        modalError.style.display = 'none';
        modalSuccess.style.display = 'none';
        populateSettingsInputs();
        settingsModal.style.display = 'flex';
    };

    const closeSettings = () => {
        settingsModal.style.display = 'none';
    };

    serverSettingsBtn.addEventListener('click', openSettings);
    closeModalBtn.addEventListener('click', closeSettings);
    
    // Close modal clicking outside
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettings();
    });

    // Test Connection Handler
    testConnectionBtn.addEventListener('click', async () => {
        modalError.style.display = 'none';
        modalSuccess.style.display = 'none';
        testConnectionBtn.disabled = true;
        testConnectionBtn.textContent = 'Probando...';

        const serverVal = settingsServerInput.value.trim().replace(/\/+$/, '');
        const userVal = settingsUserInput.value.trim();
        const passVal = settingsPassInput.value.trim();

        if (!serverVal || !userVal || !passVal) {
            modalError.textContent = 'Completa todos los campos para probar la conexión.';
            modalError.style.display = 'block';
            testConnectionBtn.disabled = false;
            testConnectionBtn.textContent = 'Probar Conexión';
            return;
        }

        const isLocal = window.location.protocol === 'file:' || 
                        window.location.hostname === 'localhost' || 
                        window.location.hostname === '127.0.0.1';

        let testUrl;
        if (isLocal) {
            testUrl = `${serverVal}/player_api.php?username=${encodeURIComponent(userVal)}&password=${encodeURIComponent(passVal)}`;
        } else {
            testUrl = `/api/proxy?username=${encodeURIComponent(userVal)}&password=${encodeURIComponent(passVal)}&server=${encodeURIComponent(serverVal)}`;
        }

        try {
            const data = await fetchApi(testUrl);
            if (data.user_info) {
                const info = data.user_info;
                modalSuccess.textContent = `¡Conectado! Cuenta: ${info.status}. Expira: ${info.exp_date ? new Date(parseInt(info.exp_date) * 1000).toLocaleDateString() : 'N/A'}`;
                modalSuccess.style.display = 'block';
            } else {
                modalError.textContent = 'Credenciales inválidas o el servidor no respondió correctamente.';
                modalError.style.display = 'block';
            }
        } catch (err) {
            modalError.textContent = `Error de conexión: ${err.message || 'Servidor inalcanzable'}`;
            modalError.style.display = 'block';
        } finally {
            testConnectionBtn.disabled = false;
            testConnectionBtn.textContent = 'Probar Conexión';
        }
    });

    // Save Settings Handler
    saveSettingsBtn.addEventListener('click', () => {
        const serverVal = settingsServerInput.value.trim().replace(/\/+$/, '');
        const userVal = settingsUserInput.value.trim();
        const passVal = settingsPassInput.value.trim();

        if (!serverVal || !userVal || !passVal) {
            alert('Por favor completa todos los campos.');
            return;
        }

        localStorage.setItem('mtv_server', serverVal);
        localStorage.setItem('mtv_user', userVal);
        localStorage.setItem('mtv_pass', passVal);

        closeSettings();
        
        // Reload page to apply new server and credentials
        window.location.reload();
    });

    // --- Cinema Mode Handlers ---
    const toggleCinemaMode = () => {
        const isCinema = document.body.classList.toggle('cinema-active');
        const span = cinemaModeBtn.querySelector('span');
        if (span) {
            span.textContent = isCinema ? 'Encender Luces' : 'Apagar Luces';
        }
    };

    cinemaModeBtn.addEventListener('click', toggleCinemaMode);
    cinemaCloseFloating.addEventListener('click', toggleCinemaMode);

    // Escape Key Exit Handler
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('cinema-active')) {
            toggleCinemaMode();
        }
    });

    // Start App
    initApp();
});
