// xROAD offline storage and background-map cache for the mobile PWA.
(function () {
    const DB_NAME = 'xrds-offline-v1';
    const DB_VERSION = 2;
    const STORE_NAME = 'projects';
    const NOTES_STORE_NAME = 'iphone_notes';
    const NOTES_PROJECT_INDEX = 'projectKey';
    const TILE_CACHE_NAME = 'xrds-gsi-tiles-v1';
    const TILE_TEMPLATE = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';

    let dbPromise = null;

    function keyFor(nendo, gyomu) {
        return `${String(nendo || '').trim()}::${String(gyomu || '').trim()}`;
    }

    function facilityRefFor(feature) {
        const props = feature?.properties || {};
        for (const key of ['shisetsu_id', 'RSDB_shisetsu_id', 'DPF_shisetsu_id']) {
            const value = String(props[key] ?? '').trim();
            if (value) return `id:${value}`;
        }
        const name = String(props.syogen_shisetsu_meisyou || props.DPF_title || '').trim();
        const coordinates = feature?.geometry?.coordinates;
        if (Array.isArray(coordinates) && coordinates.length >= 2) {
            const lng = Number(coordinates[0]);
            const lat = Number(coordinates[1]);
            if (Number.isFinite(lng) && Number.isFinite(lat)) {
                return `point:${name}|${lat.toFixed(7)}|${lng.toFixed(7)}`;
            }
        }
        return `feature:${name}|${JSON.stringify(feature?.geometry || null)}`;
    }

    function notesKeyFor(projectKey, facilityRef) {
        return [String(projectKey || '').trim(), String(facilityRef || '').trim()];
    }

    function openDb() {
        if (dbPromise) return dbPromise;
        if (!window.indexedDB) return Promise.reject(new Error('このブラウザは端末保存に対応していません。'));
        dbPromise = new Promise((resolve, reject) => {
            const request = window.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains(NOTES_STORE_NAME)) {
                    const notes = db.createObjectStore(NOTES_STORE_NAME, { keyPath: ['projectKey', 'facilityRef'] });
                    notes.createIndex(NOTES_PROJECT_INDEX, 'projectKey', { unique: false });
                } else {
                    const notes = request.transaction.objectStore(NOTES_STORE_NAME);
                    if (!notes.indexNames.contains(NOTES_PROJECT_INDEX)) {
                        notes.createIndex(NOTES_PROJECT_INDEX, 'projectKey', { unique: false });
                    }
                }
            };
            request.onblocked = () => reject(new Error('別のxROAD画面が端末保存領域を使用中です。画面を閉じて再試行してください。'));
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => {
                    db.close();
                    dbPromise = null;
                };
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error('端末保存領域を開けません。'));
        });
        dbPromise.catch(() => { dbPromise = null; });
        return dbPromise;
    }

    async function putProject(project) {
        const data = {
            key: keyFor(project.nendo, project.gyomu),
            nendo: String(project.nendo || '').trim(),
            gyomu: String(project.gyomu || '').trim(),
            features: Array.isArray(project.features) ? project.features : [],
            revision: project.revision || null,
            saved_at: new Date().toISOString(),
        };
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(data);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('業務を端末へ保存できません。'));
            tx.onabort = () => reject(tx.error || new Error('業務を端末へ保存できません。'));
        });
        return data;
    }

    async function getProject(nendo, gyomu) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(keyFor(nendo, gyomu));
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('端末保存データを読み込めません。'));
        });
    }

    async function listProjects() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
            request.onsuccess = () => resolve((request.result || []).sort((a, b) =>
                `${a.nendo} ${a.gyomu}`.localeCompare(`${b.nendo} ${b.gyomu}`, 'ja')));
            request.onerror = () => reject(request.error || new Error('端末保存一覧を読み込めません。'));
        });
    }

    async function removeProject(nendo, gyomu) {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(keyFor(nendo, gyomu));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('端末保存データを削除できません。'));
            tx.onabort = () => reject(tx.error || new Error('端末保存データを削除できません。'));
        });
    }

    async function getNote(projectKey, facilityRef) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const request = db.transaction(NOTES_STORE_NAME, 'readonly')
                .objectStore(NOTES_STORE_NAME).get(notesKeyFor(projectKey, facilityRef));
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('iPhoneメモを読み込めません。'));
        });
    }

    async function listNotes(projectKey) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const request = db.transaction(NOTES_STORE_NAME, 'readonly')
                .objectStore(NOTES_STORE_NAME).index(NOTES_PROJECT_INDEX).getAll(String(projectKey || '').trim());
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error('iPhoneメモ一覧を読み込めません。'));
        });
    }

    async function saveNote(note) {
        const projectKey = String(note?.projectKey || '').trim();
        const facilityRef = String(note?.facilityRef || '').trim();
        if (!projectKey || !facilityRef) throw new Error('メモの保存先を特定できません。');
        const text = String(note?.text ?? '');
        const displayName = String(note?.displayName || '').trim();
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(NOTES_STORE_NAME, 'readwrite');
            const store = tx.objectStore(NOTES_STORE_NAME);
            const getRequest = store.get(notesKeyFor(projectKey, facilityRef));
            let saved;
            getRequest.onsuccess = () => {
                const previous = getRequest.result;
                saved = {
                    projectKey,
                    facilityRef,
                    text,
                    displayName,
                    createdAt: previous?.createdAt || new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                store.put(saved);
            };
            getRequest.onerror = () => { try { tx.abort(); } catch (error) {} };
            tx.oncomplete = () => resolve(saved);
            tx.onerror = () => reject(tx.error || new Error('iPhoneメモを保存できません。'));
            tx.onabort = () => reject(tx.error || new Error('iPhoneメモを保存できません。'));
        });
    }

    async function deleteNote(projectKey, facilityRef) {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(NOTES_STORE_NAME, 'readwrite');
            tx.objectStore(NOTES_STORE_NAME).delete(notesKeyFor(projectKey, facilityRef));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('iPhoneメモを削除できません。'));
            tx.onabort = () => reject(tx.error || new Error('iPhoneメモを削除できません。'));
        });
    }

    function tileX(lng, zoom) {
        const world = 2 ** zoom;
        return Math.max(0, Math.min(world - 1, Math.floor(((lng + 180) / 360) * world)));
    }

    function tileY(lat, zoom) {
        const safeLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
        const radians = safeLat * Math.PI / 180;
        const world = 2 ** zoom;
        return Math.max(0, Math.min(world - 1, Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * world)));
    }

    function tileUrl(zoom, x, y) {
        return TILE_TEMPLATE.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
    }

    function collectTileUrls(features, options = {}) {
        const coordinates = (features || []).map(feature => feature?.geometry?.coordinates)
            .filter(coords => Array.isArray(coords) && coords.length >= 2)
            .map(coords => ({ lng: Number(coords[0]), lat: Number(coords[1]) }))
            .filter(point => Number.isFinite(point.lng) && Number.isFinite(point.lat));
        if (!coordinates.length) return [];

        const minZoom = Number.isInteger(options.minZoom) ? options.minZoom : 9;
        const maxZoom = Number.isInteger(options.maxZoom) ? options.maxZoom : 15;
        const maxTiles = Number.isInteger(options.maxTiles) ? options.maxTiles : 360;
        const padding = Number.isInteger(options.padding) ? options.padding : 1;
        const urls = [];

        for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
            const world = 2 ** zoom;
            const tiles = new Set();
            coordinates.forEach(point => {
                const centerX = tileX(point.lng, zoom);
                const centerY = tileY(point.lat, zoom);
                for (let dx = -padding; dx <= padding; dx += 1) {
                    for (let dy = -padding; dy <= padding; dy += 1) {
                        const x = Math.max(0, Math.min(world - 1, centerX + dx));
                        const y = Math.max(0, Math.min(world - 1, centerY + dy));
                        tiles.add(`${x}/${y}`);
                    }
                }
            });
            for (const pair of tiles) {
                if (urls.length >= maxTiles) return urls;
                const [x, y] = pair.split('/').map(Number);
                urls.push(tileUrl(zoom, x, y));
            }
        }
        return urls;
    }

    async function cacheProjectTiles(features, options = {}) {
        if (!window.caches || !window.fetch) return { requested: 0, cached: 0, failed: 0 };
        const urls = collectTileUrls(features, options);
        const cache = await window.caches.open(TILE_CACHE_NAME);
        let cached = 0;
        let failed = 0;
        for (const url of urls) {
            try {
                const response = await window.fetch(url, { mode: 'cors', cache: 'reload' });
                if (response.ok || response.type === 'opaque') {
                    await cache.put(url, response.clone());
                    cached += 1;
                } else {
                    failed += 1;
                }
            } catch (error) {
                failed += 1;
            }
        }
        return { requested: urls.length, cached, failed };
    }

    async function saveProjectForOffline(project) {
        const saved = await putProject(project);
        const tiles = await cacheProjectTiles(project.features, { minZoom: 9, maxZoom: 15, maxTiles: 360, padding: 1 });
        return { saved, tiles };
    }

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return { supported: false, reason: 'service-worker' };
        const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
        if (!window.isSecureContext && !localHost) return { supported: false, reason: 'https-required' };
        try {
            const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
            return { supported: true, registration };
        } catch (error) {
            return { supported: false, reason: error.message };
        }
    }

    window.xrdsOffline = {
        keyFor,
        facilityRefFor,
        notesKeyFor,
        getProject,
        listProjects,
        removeProject,
        getNote,
        listNotes,
        saveNote,
        deleteNote,
        saveProject: saveProjectForOffline,
        cacheProjectTiles,
        collectTileUrls,
        registerServiceWorker,
        isOnline: () => navigator.onLine !== false,
    };
})();