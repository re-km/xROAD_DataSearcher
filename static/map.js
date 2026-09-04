// 地図管理ワークスペース: 全画面地図、業務単位の共有編集、詳細確認、QGIS出力
(function () {
    let leafletMap = null;
    let mapInitialized = false;
    let styleRules = null;
    let projectTreeData = [];
    let offlineProjects = [];
    let activeProjectKey = null;
    let activeFeature = null;
    let moveMode = false;
    let addPointMode = false;
    let leftPaneCollapsed = false;
    let rightPaneCollapsed = false;
    let aggregateLayer = null;
    let renderTimer = null;
    const projectLayers = {}; // key -> {nendo, gyomu, features, revision, visible, dirty, leafletGroup}
    const expandedProjectFacilities = new Set();
    const SCHEDULE_LABEL_ZOOM_THRESHOLD = 14;
    let scheduleState = { projectKey: null, baseRevision: null, sourceName: '', scheduleYear: '', workbookBase64: '', preview: null, decisions: {}, applyEquipment: true };
    const hanteiFilter = new Set(['1', '2', '3', '4', 'other']);
    const DISPLAY_SETTINGS_STORAGE_KEY = 'xrds-map-display-options-v1';
    const PRINT_PAPER_STORAGE_KEY = 'xrds-map-print-paper-v1';
    const PRINT_DISPLAY_SETTINGS_STORAGE_KEY = 'xrds-map-print-display-v1';
    const NEUTRAL_MAP_COLOR = { fill: 'rgba(255,255,255,.92)', text: '#1f2937', border: 'rgba(100,116,139,.9)' };
    const PIN_COLOR = '#000000';
    let displayOptions = loadDisplayOptions();
    let printMode = false;
    let printPaper = loadPrintPaper();
    let printDisplayOptions = loadPrintDisplayOptions();
    const printDirtyProjects = new Set();


    const MAX_INDIVIDUAL_MARKERS = 1200;
    const AGGREGATE_ZOOM_THRESHOLD = 12;
    const AGGREGATE_COUNT_THRESHOLD = 350;
    const AGGREGATE_CELL_SIZE = 42;
    const WORK_STATUS_OPTIONS = ['準備中', '準備完了', '社内踏査済', '点検済', '調査済', '完了'];
    const EQUIPMENT_OPTIONS = ['橋梁点検車', '中型橋梁点検車', '大型橋梁点検車', '施設点検車', '高所作業車'];
    const EQUIPMENT_BORDER_COLORS = {
        '橋梁点検車': '#63d6b5',
        '中型橋梁点検車': '#9acd32',
        '大型橋梁点検車': '#238636',
        '施設点検車': '#0b5d1e',
        '高所作業車': '#d8ccff',
    };
    const OTHER_EQUIPMENT_BORDER_COLOR = '#7e22ce';

    const XROAD_ATTRIBUTE_LABELS = {
        shisetsu_id: 'xROAD施設ID', DPF_title: '施設名', syogen_shisetsu_meisyou: '施設名',
        syogen_ichi_todofuken_meisyou: '都道府県', syogen_ichi_shikutyouson_meisyou: '市区町村',
        syogen_gyousei_kuiki_todoufuken_mei: '都道府県', syogen_gyousei_kuiki_shikuchouson_mei: '市区町村',
        syogen_ichi_ido: '緯度', syogen_ichi_keido: '経度', syogen_kanrisya_meisyou: '管理者',
        syogen_rosen_meisyou: '路線名', syogen_rosen_bangou: '路線番号', syogen_kasetsu_nendo: '架設年度',
        syogen_kyouchou: '橋長', syogen_fukuin: '幅員', tenken_kiroku_hantei_kubun: '判定区分',
        tenken_kiroku_tenken_nendo: '点検年度', RSDB_tenken_kiroku_hantei_kubun: '判定区分',
        kasetsu_nendo: '架設年度', kyouchou: '橋長', fukuin: '幅員',
    };
    const XROAD_ATTRIBUTE_TOKENS = {
        syogen: '諸元', shisetsu: '施設', meisyou: '名称', ichi: '所在地', gyousei: '行政', kuiki: '区域',
        todofuken: '都道府県', todoufuken: '都道府県', shikutyouson: '市区町村', shikuchouson: '市区町村',
        ido: '緯度', keido: '経度', kanrisya: '管理者', rosen: '路線', bangou: '番号', kasetsu: '架設',
        nendo: '年度', kyouchou: '橋長', fukuin: '幅員', tenken: '点検', kiroku: '記録', hantei: '判定', kubun: '区分',
    };
    const XROAD_GROUP_LABELS = { basic: '基本情報', location: '所在地', management: '管理・路線', specifications: '諸元', inspection: '点検', other: 'その他' };
    const XROAD_GROUP_ORDER = ['basic', 'location', 'management', 'specifications', 'inspection', 'other'];
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }
    function loadDisplayOptions() {
        const defaults = { hanteiColors: true, equipmentBorders: true };
        try {
            const raw = window.localStorage?.getItem(DISPLAY_SETTINGS_STORAGE_KEY);
            const saved = raw ? JSON.parse(raw) : {};
            return { hanteiColors: saved.hanteiColors !== false, equipmentBorders: saved.equipmentBorders !== false };
        } catch (error) {
            return defaults;
        }
    }
    function persistDisplayOptions() {
        try { window.localStorage?.setItem(DISPLAY_SETTINGS_STORAGE_KEY, JSON.stringify(displayOptions)); } catch (error) {}
    }
    function loadPrintPaper() {
        try { return window.localStorage?.getItem(PRINT_PAPER_STORAGE_KEY) === 'A3' ? 'A3' : 'A4'; } catch (error) { return 'A4'; }
    }
    function persistPrintPaper() {
        try { window.localStorage?.setItem(PRINT_PAPER_STORAGE_KEY, printPaper); } catch (error) {}
    }
    function loadPrintDisplayOptions() {
        const defaults = { header: true, paneTabs: false };
        try {
            const raw = window.localStorage?.getItem(PRINT_DISPLAY_SETTINGS_STORAGE_KEY);
            const saved = raw ? JSON.parse(raw) : {};
            return { header: saved.header !== false, paneTabs: saved.paneTabs === true };
        } catch (error) {
            return defaults;
        }
    }
    function persistPrintDisplayOptions() {
        try { window.localStorage?.setItem(PRINT_DISPLAY_SETTINGS_STORAGE_KEY, JSON.stringify(printDisplayOptions)); } catch (error) {}
    }
    function getPrintLabelAnchor(feature) {
        const raw = feature?.properties?.XRDS_print_label_anchor;
        if (!Array.isArray(raw) || raw.length < 2) return null;
        const lng = Number(raw[0]);
        const lat = Number(raw[1]);
        return Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
            ? { lng, lat }
            : null;
    }
    function getEquipmentBorderColor(value) {
        const equipment = String(value ?? '').trim();
        if (!equipment) return null;
        return EQUIPMENT_BORDER_COLORS[equipment] || OTHER_EQUIPMENT_BORDER_COLOR;
    }
    function renderWorkStatusOptions(currentValue) {
        const current = String(currentValue ?? '');
        const legacy = current && !WORK_STATUS_OPTIONS.includes(current)
            ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（旧設定）</option>`
            : '';
        return `<option value="" ${current ? '' : 'selected'}>未設定</option>${legacy}${WORK_STATUS_OPTIONS.map(value =>
            `<option value="${escapeHtml(value)}" ${current === value ? 'selected' : ''}>${escapeHtml(value)}</option>`
        ).join('')}`;
    }
    function renderEquipmentSelectOptions(currentValue) {
        const current = String(currentValue ?? '').trim();
        const custom = Boolean(current) && !EQUIPMENT_OPTIONS.includes(current);
        return `<option value="" ${current ? '' : 'selected'}>未選択</option>${EQUIPMENT_OPTIONS.map(value =>
            `<option value="${escapeHtml(value)}" ${current === value ? 'selected' : ''}>${escapeHtml(value)}</option>`
        ).join('')}<option value="__other__" ${custom ? 'selected' : ''}>その他（自由入力）</option>`;
    }
    function renderEquipmentLegend() {
        const standard = EQUIPMENT_OPTIONS.map(value =>
            `<span><i style="border-color:${EQUIPMENT_BORDER_COLORS[value]};"></i>${escapeHtml(value)}</span>`
        ).join('');
        return `<div class="map-equipment-legend">${standard}<span><i style="border-color:${OTHER_EQUIPMENT_BORDER_COLOR};"></i>その他（自由入力）</span></div>`;
    }
    function projectKey(nendo, gyomu) { return `${nendo}::${gyomu}`; }
    function getHanteiKey(props) {
        const raw = props && props.RSDB_tenken_kiroku_hantei_kubun;
        const value = raw === undefined || raw === null ? '' : String(raw).trim();
        return ['1', '2', '3', '4'].includes(value) ? value : 'other';
    }
    function getColorFor(key) {
        if (!displayOptions.hanteiColors) return NEUTRAL_MAP_COLOR;
        const fallback = { fill: 'rgba(150,150,150,.8)', text: '#111', border: 'rgba(80,80,80,.9)' };
        return (styleRules && (styleRules[key] || styleRules.other)) || fallback;
    }
    function getCoordinates(feature) {
        const coords = feature && feature.geometry && feature.geometry.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) return null;
        const lng = Number(coords[0]); const lat = Number(coords[1]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }
    function cloneFeature(feature) {
        return typeof structuredClone === 'function'
            ? structuredClone(feature)
            : JSON.parse(JSON.stringify(feature));
    }
    function getSelectedSearchFeatures() {
        if (Array.isArray(window.__pendingMapFeatures)) return window.__pendingMapFeatures;
        const live = typeof window.collectSelectedFeatures === 'function'
            ? window.collectSelectedFeatures()
            : [];
        window.__pendingMapFeatures = live.map(cloneFeature);
        return window.__pendingMapFeatures;
    }
    function getPendingSearchCount() {
        return Array.isArray(window.__pendingMapFeatures) ? window.__pendingMapFeatures.length : 0;
    }
    function featureIdentity(feature) {
        const props = feature?.properties || {};
        const id = props.shisetsu_id || props.RSDB_shisetsu_id || props.DPF_shisetsu_id;
        if (id !== undefined && id !== null && String(id).trim()) return `id:${String(id).trim()}`;
        const name = props.syogen_shisetsu_meisyou || props.DPF_title || '';
        const coord = getCoordinates(feature);
        return coord ? `point:${name}|${coord.lat.toFixed(7)}|${coord.lng.toFixed(7)}` : `feature:${name}|${JSON.stringify(feature?.geometry || null)}`;
    }
    let mobileNoteRenderToken = 0;
    function mobileNoteKey(project, feature) {
        const localProjectKey = window.xrdsOffline?.keyFor
            ? window.xrdsOffline.keyFor(project.nendo, project.gyomu)
            : projectKey(project.nendo, project.gyomu);
        const facilityRef = window.xrdsOffline?.facilityRefFor
            ? window.xrdsOffline.facilityRefFor(feature)
            : featureIdentity(feature);
        return { projectKey: localProjectKey, facilityRef };
    }
    function formatMobileNoteTime(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '';
        try {
            return date.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
        } catch (error) {
            return date.toLocaleString('ja-JP');
        }
    }
    function renderMobileNotePanel() {
        return `<section class="map-mobile-note">
          <h4>iPhoneメモ <span>このiPhoneだけ</span></h4>
          <p class="map-mobile-note-help">現場メモはPC共有データへ送信しません。通信がなくても保存できます。</p>
          <textarea id="map-mobile-note" maxlength="4000" placeholder="確認したこと、補足などを入力"></textarea>
          <div class="map-inline-actions"><button type="button" class="map-mini-btn primary" data-detail-action="save-mobile-note">メモを保存</button><button type="button" class="map-mini-btn" data-detail-action="delete-mobile-note">メモを削除</button></div>
          <p class="map-mobile-note-status" id="map-mobile-note-status" role="status">読み込み中...</p>
        </section>`;
    }
    function setMobileNoteStatus(message, isError = false) {
        const statusElement = document.getElementById('map-mobile-note-status');
        if (!statusElement) return;
        statusElement.textContent = message;
        statusElement.classList.toggle('error', Boolean(isError));
    }
    function setMobileNoteButtonsDisabled(disabled) {
        document.querySelectorAll('[data-detail-action="save-mobile-note"], [data-detail-action="delete-mobile-note"]').forEach(button => { button.disabled = disabled; });
    }
    async function hydrateMobileNotePanel(project, feature, token) {
        const noteApi = window.xrdsOffline;
        if (!noteApi?.getNote) {
            setMobileNoteStatus('この持ち出し版はメモ機能を利用できません。最新版を読み込んでください。', true);
            return;
        }
        try {
            const key = mobileNoteKey(project, feature);
            const note = await noteApi.getNote(key.projectKey, key.facilityRef);
            if (token !== mobileNoteRenderToken || activeFeature?.project !== project || activeFeature?.feature !== feature) return;
            const textarea = document.getElementById('map-mobile-note');
            const deleteButton = document.querySelector('[data-detail-action="delete-mobile-note"]');
            if (textarea) textarea.value = note?.text || '';
            if (deleteButton) deleteButton.disabled = !note;
            setMobileNoteStatus(note ? `最終保存: ${formatMobileNoteTime(note.updatedAt)}` : 'まだ保存されていません。');
        } catch (error) {
            if (token === mobileNoteRenderToken) setMobileNoteStatus(`メモを読み込めません: ${error.message}`, true);
        }
    }
    async function saveMobileNote(project) {
        if (!activeFeature || activeFeature.project !== project) return;
        const textarea = document.getElementById('map-mobile-note');
        if (!textarea) return;
        if (!textarea.value.trim()) {
            alert('内容が空です。削除する場合は「メモを削除」を押してください。');
            return;
        }
        if (!window.xrdsOffline?.saveNote) {
            setMobileNoteStatus('この持ち出し版はメモ機能を利用できません。最新版を読み込んでください。', true);
            return;
        }
        const key = mobileNoteKey(project, activeFeature.feature);
        setMobileNoteButtonsDisabled(true);
        try {
            const saved = await window.xrdsOffline.saveNote({
                projectKey: key.projectKey,
                facilityRef: key.facilityRef,
                text: textarea.value,
                displayName: getFeatureDisplayName(activeFeature.feature, activeFeature.index),
            });
            setMobileNoteStatus(`保存しました: ${formatMobileNoteTime(saved?.updatedAt)}`);
            const deleteButton = document.querySelector('[data-detail-action="delete-mobile-note"]');
            if (deleteButton) deleteButton.disabled = false;
            renderProjectTree();
        } catch (error) {
            setMobileNoteStatus(`メモを保存できません: ${error.message}`, true);
        } finally {
            const saveButton = document.querySelector('[data-detail-action="save-mobile-note"]');
            if (saveButton) saveButton.disabled = false;
        }
    }
    async function deleteMobileNote(project) {
        if (!activeFeature || activeFeature.project !== project || !window.xrdsOffline?.deleteNote) return;
        if (!confirm('このiPhoneメモを削除しますか？')) return;
        const key = mobileNoteKey(project, activeFeature.feature);
        setMobileNoteButtonsDisabled(true);
        let deleted = false;
        try {
            await window.xrdsOffline.deleteNote(key.projectKey, key.facilityRef);
            deleted = true;
            const textarea = document.getElementById('map-mobile-note');
            if (textarea) textarea.value = '';
            setMobileNoteStatus('メモを削除しました。');
            renderProjectTree();
        } catch (error) {
            setMobileNoteStatus(`メモを削除できません: ${error.message}`, true);
        } finally {
            const saveButton = document.querySelector('[data-detail-action="save-mobile-note"]');
            if (saveButton) saveButton.disabled = false;
            const deleteButton = document.querySelector('[data-detail-action="delete-mobile-note"]');
            if (deleteButton) deleteButton.disabled = !deleted;
        }
    }
    function isOriginalValueEmpty(value) {
        return value === null || value === undefined
            || (typeof value === 'string' && !value.trim())
            || (Array.isArray(value) && value.length === 0);
    }
    function attributeLabel(key) {
        if (XROAD_ATTRIBUTE_LABELS[key]) return XROAD_ATTRIBUTE_LABELS[key];
        return key.split('_').map(token => XROAD_ATTRIBUTE_TOKENS[token] || token).join('・');
    }
    function attributeGroup(key) {
        if (key === 'shisetsu_id' || key === 'DPF_title' || key.includes('_shisetsu_')) return 'basic';
        if (/(?:_ichi_|gyousei_kuiki|todofuken|todoufuken|shikutyouson|shikuchouson|_ido$|_keido$)/.test(key)) return 'location';
        if (/(?:kanrisya|rosen)/.test(key)) return 'management';
        if (/^(?:tenken_|RSDB_tenken_)/.test(key)) return 'inspection';
        if (key.startsWith('syogen_') || ['kasetsu_nendo', 'kyouchou', 'fukuin'].includes(key)) return 'specifications';
        return 'other';
    }
    function formatOriginalValue(key, value) {
        let text;
        if (Array.isArray(value) || (value && typeof value === 'object')) text = JSON.stringify(value, null, 2);
        else if (typeof value === 'boolean') text = value ? 'はい' : 'いいえ';
        else text = String(value);
        if (/(?:kyouchou|fukuin)$/.test(key) && text && !/[a-zA-Zｍmメートル]/.test(text)) return `${text} m`;
        return text;
    }
    function getOriginalAttributeEntries(props) {
        const aliases = { DPF_title: 'syogen_shisetsu_meisyou', RSDB_tenken_kiroku_hantei_kubun: 'tenken_kiroku_hantei_kubun', kasetsu_nendo: 'syogen_kasetsu_nendo', kyouchou: 'syogen_kyouchou', fukuin: 'syogen_fukuin' };
        return Object.entries(props || {})
            .filter(([key, value]) => !key.startsWith('XRDS_') && !isOriginalValueEmpty(value))
            .filter(([key]) => !(aliases[key] && !isOriginalValueEmpty(props[aliases[key]])))
            .map(([key, value]) => ({ key, value, label: attributeLabel(key), group: attributeGroup(key), formatted: formatOriginalValue(key, value) }))
            .sort((a, b) => {
                const groupDiff = XROAD_GROUP_ORDER.indexOf(a.group) - XROAD_GROUP_ORDER.indexOf(b.group);
                return groupDiff || a.label.localeCompare(b.label, 'ja');
            });
    }
    function renderOriginalAttributes(props) {
        const entries = getOriginalAttributeEntries(props);
        if (!entries.length) return '<section class="xrds-original"><h4>xROAD原本属性</h4><p class="map-detail-empty">表示できる原本属性がありません。</p></section>';
        const groups = new Map(XROAD_GROUP_ORDER.map(group => [group, []]));
        entries.forEach(entry => groups.get(entry.group).push(entry));
        const groupHtml = XROAD_GROUP_ORDER.map(group => {
            const groupEntries = groups.get(group);
            if (!groupEntries.length) return '';
            const rows = groupEntries.map(entry => {
                const search = `${entry.label} ${entry.key} ${entry.formatted}`.normalize('NFKC').toLowerCase();
                const valueClass = entry.formatted.includes('\n') ? ' multiline' : '';
                return `<div class="xrds-attr-row" data-attribute-search="${escapeHtml(search)}"><div><div class="xrds-attr-label">${escapeHtml(entry.label)}</div><div class="xrds-attr-key">${escapeHtml(entry.key)}</div></div><div class="xrds-attr-value${valueClass}">${escapeHtml(entry.formatted)}</div></div>`;
            }).join('');
            return `<details class="xrds-attr-group" ${group === 'other' ? '' : 'open'}><summary>${escapeHtml(XROAD_GROUP_LABELS[group])}<span>${groupEntries.length}項目</span></summary>${rows}</details>`;
        }).join('');
        const originalObject = Object.fromEntries(entries.map(entry => [entry.key, entry.value]));
        return `<section class="xrds-original"><h4>xROAD原本属性 <span>${entries.length}項目</span></h4><input type="search" id="xrds-attribute-filter" placeholder="属性名・値・元キーを絞り込み">${groupHtml}<details class="xrds-raw-json"><summary>原本JSONを確認</summary><pre>${escapeHtml(JSON.stringify(originalObject, null, 2))}</pre></details></section>`;
    }
    function filterOriginalAttributes(event) {
        if (event.target.id !== 'xrds-attribute-filter') return;
        const query = event.target.value.normalize('NFKC').trim().toLowerCase();
        const panel = event.target.closest('.xrds-original');
        panel?.querySelectorAll('.xrds-attr-row').forEach(row => {
            row.hidden = Boolean(query) && !row.dataset.attributeSearch.includes(query);
        });
        panel?.querySelectorAll('.xrds-attr-group').forEach(group => {
            group.hidden = !group.querySelector('.xrds-attr-row:not([hidden])');
        });
    }    function status(message) {
        const el = document.getElementById('map-canvas-status');
        if (el) el.textContent = message;
        const toolbar = document.getElementById('map-workspace-status');
        if (toolbar) { toolbar.textContent = message; toolbar.title = message; }
    }
    function renderOfflineStatus() {
        const element = document.getElementById('map-offline-status');
        if (!element) return;
        const online = typeof navigator === 'undefined' || navigator.onLine !== false;
        const deviceLabel = window.XRDS_MOBILE_MODE ? 'iPhone内保存' : 'PCブラウザ内保存';
        element.textContent = (online ? 'オンライン' : 'オフライン') + ' / ' + deviceLabel + ': ' + offlineProjects.length + '業務';
        element.classList.toggle('map-offline-badge', !online || offlineProjects.length > 0);
    }
    function setPaneCollapsed(side, collapsed) {
        const workspace = document.getElementById('tab-content-map');
        if (!workspace) return;
        if (side === 'left') leftPaneCollapsed = collapsed; else rightPaneCollapsed = collapsed;
        workspace.classList.toggle('map-left-collapsed', leftPaneCollapsed);
        workspace.classList.toggle('map-right-collapsed', rightPaneCollapsed);
        updatePaneToggleButtons();
        setTimeout(() => {
            leafletMap?.invalidateSize();
            scheduleRenderVisibleMarkers();
        }, 80);
    }
    function updatePaneToggleButtons() {
        const leftButton = document.getElementById('map-toggle-left-btn');
        const rightButton = document.getElementById('map-toggle-right-btn');
        if (leftButton) {
            leftButton.textContent = leftPaneCollapsed ? '›' : '‹';
            leftButton.setAttribute('aria-pressed', String(leftPaneCollapsed));
            leftButton.setAttribute('aria-label', leftPaneCollapsed ? '左パネルを開く' : '左パネルを隠す');
            leftButton.title = leftButton.getAttribute('aria-label');
        }
        if (rightButton) {
            rightButton.textContent = rightPaneCollapsed ? '‹' : '›';
            rightButton.setAttribute('aria-pressed', String(rightPaneCollapsed));
            rightButton.setAttribute('aria-label', rightPaneCollapsed ? '右パネルを開く' : '右パネルを隠す');
            rightButton.title = rightButton.getAttribute('aria-label');
        }
    }
    function bindPaneToggleEvents() {
        const leftButton = document.getElementById('map-toggle-left-btn');
        const rightButton = document.getElementById('map-toggle-right-btn');
        if (leftButton) leftButton.onclick = () => setPaneCollapsed('left', !leftPaneCollapsed);
        if (rightButton) rightButton.onclick = () => setPaneCollapsed('right', !rightPaneCollapsed);
        if (!mapInitialized && window.matchMedia?.('(max-width: 720px)').matches) {
            rightPaneCollapsed = true;
            document.getElementById('tab-content-map')?.classList.add('map-right-collapsed');
        }
        updatePaneToggleButtons();
    }
    async function ensureStyleRules() {
        if (!styleRules) {
            try {
                const response = await fetch('/api/style');
                if (!response.ok) throw new Error(await response.text());
                styleRules = await response.json();
            } catch (error) {
                styleRules = {};
            }
        }
    }
    function onMapClick(event) {
        const project = activeProjectKey && projectLayers[activeProjectKey];
        if (addPointMode) {
            addPointMode = false;
            moveMode = false;
            if (!project) {
                status('空の地点を追加する業務が選択されていません。');
                return;
            }
            const lat = Number(event.latlng?.lat);
            const lng = Number(event.latlng?.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                status('クリックした位置を取得できませんでした。');
                return;
            }
            const feature = {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lng, lat] },
                properties: {},
            };
            project.features.push(feature);
            project.dirty = true;
            if (!project.visible) {
                project.visible = true;
                project.leafletGroup.addTo(leafletMap);
            }
            activeFeature = {
                project,
                index: project.features.length - 1,
                feature,
                coord: { lat, lng },
            };
            renderVisibleMarkers();
            renderDetail();
            status('属性が空の地点を追加しました。右ペインで入力し、「この業務を保存」を押してください。');
            return;
        }
        if (!moveMode || !activeFeature) return;
        const { project: moveProject, index } = activeFeature;
        const feature = moveProject.features[index];
        const properties = feature.properties || (feature.properties = {});
        const previous = feature.geometry.coordinates;
        if (!Array.isArray(properties.XRDS_original_coordinates)) {
            properties.XRDS_original_coordinates = [...previous];
        }
        feature.geometry.coordinates = [event.latlng.lng, event.latlng.lat];
        moveProject.dirty = true;
        moveMode = false;
        status('地点を移動しました。「この業務を保存」で共有データへ反映します。');
        renderVisibleMarkers();
        renderDetail();
    }
    async function initLeafletMap() {
        await ensureStyleRules();
        leafletMap = L.map('leaflet-map', { preferCanvas: true }).setView([35.68, 139.76], 6);
        leafletMap.createPane('xrds-leader-pane');
        leafletMap.getPane('xrds-leader-pane').style.zIndex = '350';
        leafletMap.getPane('xrds-leader-pane').style.pointerEvents = 'none';
        const attribution = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
        const pale = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { attribution, maxZoom: 18, crossOrigin: true });
        const standard = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', { attribution, maxZoom: 18, crossOrigin: true });
        const photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', { attribution, maxZoom: 18, crossOrigin: true });
        pale.addTo(leafletMap);
        L.control.layers({ '淡色地図': pale, '標準地図': standard, '航空写真': photo }, {}, { collapsed: true }).addTo(leafletMap);
        aggregateLayer = L.layerGroup().addTo(leafletMap);
        leafletMap.on('moveend', scheduleRenderVisibleMarkers);
        leafletMap.on('zoomend', scheduleRenderVisibleMarkers);
        leafletMap.on('click', onMapClick);
        bindWorkspaceEvents();
    }
    function bindWorkspaceEvents() {
        document.getElementById('map-project-search')?.addEventListener('input', renderProjectTree);
        document.getElementById('map-create-project-btn')?.addEventListener('click', createProject);
        document.getElementById('map-back-btn')?.addEventListener('click', () => switchTab('file'));
        bindPaneToggleEvents();
        renderOfflineStatus();
        window.addEventListener('online', renderOfflineStatus);
        window.addEventListener('offline', renderOfflineStatus);
        document.getElementById('project-tree')?.addEventListener('click', onProjectTreeClick);
        document.getElementById('hantei-filter')?.addEventListener('change', event => {
            if (!event.target.classList.contains('hantei-cb')) return;
            if (event.target.checked) hanteiFilter.add(event.target.value); else hanteiFilter.delete(event.target.value);
            renderVisibleMarkers();
        });
        const labelColorToggle = document.getElementById('map-label-color-toggle');
        const equipmentBorderToggle = document.getElementById('map-equipment-border-toggle');
        if (labelColorToggle) { labelColorToggle.checked = displayOptions.hanteiColors; labelColorToggle.addEventListener('change', onMapDisplayOptionChange); }
        if (equipmentBorderToggle) { equipmentBorderToggle.checked = displayOptions.equipmentBorders; equipmentBorderToggle.addEventListener('change', onMapDisplayOptionChange); }
        const printPaperSelect = document.getElementById('map-print-paper');
        if (printPaperSelect) { printPaperSelect.value = printPaper; printPaperSelect.addEventListener('change', onPrintPaperChange); }
        const printHeaderToggle = document.getElementById('map-print-header-toggle');
        const printPaneTabsToggle = document.getElementById('map-print-pane-tabs-toggle');
        if (printHeaderToggle) { printHeaderToggle.checked = printDisplayOptions.header; printHeaderToggle.addEventListener('change', onPrintDisplayOptionChange); }
        if (printPaneTabsToggle) { printPaneTabsToggle.checked = printDisplayOptions.paneTabs; printPaneTabsToggle.addEventListener('change', onPrintDisplayOptionChange); }
        document.getElementById('map-print-mode-btn')?.addEventListener('click', () => setPrintMode(true));
        document.getElementById('map-print-auto-btn')?.addEventListener('click', resetPrintLabelAnchors);
        document.getElementById('map-print-save-btn')?.addEventListener('click', savePrintLayouts);
        document.getElementById('map-print-btn')?.addEventListener('click', printCurrentMap);
        document.getElementById('map-print-jpeg-btn')?.addEventListener('click', exportCurrentMapJpeg);
        document.getElementById('map-print-exit-btn')?.addEventListener('click', () => setPrintMode(false));
        window.addEventListener?.('beforeprint', beforePrint);
        window.addEventListener?.('afterprint', afterPrint);
        updatePrintControls();
        document.getElementById('map-detail-panel')?.addEventListener('click', onDetailClick);
        document.getElementById('map-detail-panel')?.addEventListener('input', filterOriginalAttributes);
        document.getElementById('map-detail-panel')?.addEventListener('change', onDetailChange);
        document.getElementById('map-detail-panel')?.addEventListener('keydown', onDetailKeydown);
    }
    function onMapDisplayOptionChange(event) {
        const id = event.target?.id;
        if (id === 'map-label-color-toggle') displayOptions.hanteiColors = Boolean(event.target.checked);
        else if (id === 'map-equipment-border-toggle') displayOptions.equipmentBorders = Boolean(event.target.checked);
        else return;
        persistDisplayOptions();
        renderVisibleMarkers();
        updatePrintHeader();
    }
    function applyPrintDisplayOptions() {
        const body = document.body;
        if (!body) return;
        body.classList.toggle('xrds-print-hide-header', printMode && !printDisplayOptions.header);
        body.classList.toggle('xrds-print-show-pane-tabs', printMode && printDisplayOptions.paneTabs);
    }
    function onPrintDisplayOptionChange(event) {
        const id = event.target?.id;
        if (id === 'map-print-header-toggle') printDisplayOptions.header = Boolean(event.target.checked);
        else if (id === 'map-print-pane-tabs-toggle') printDisplayOptions.paneTabs = Boolean(event.target.checked);
        else return;
        persistPrintDisplayOptions();
        applyPrintDisplayOptions();
        updatePrintControls();
        updatePrintHeader();
    }
    function onPrintPaperChange(event) {
        printPaper = event.target?.value === 'A3' ? 'A3' : 'A4';
        persistPrintPaper();
        applyPrintPageSize();
        updatePrintHeader();
    }
    const PRINT_OUTPUT_SPECS = Object.freeze({
        A4: { cssWidth: '297mm', cssHeight: '210mm', widthMm: 297, heightMm: 210, widthPx: 2400, heightPx: 1697 },
        A3: { cssWidth: '420mm', cssHeight: '297mm', widthMm: 420, heightMm: 297, widthPx: 3394, heightPx: 2400 },
    });
    function getPrintPaperSpec(paper = printPaper) {
        return PRINT_OUTPUT_SPECS[paper] || PRINT_OUTPUT_SPECS.A4;
    }
    function mapRectToPrint(rect, mapRect, target) {
        const scaleX = target.width / mapRect.width;
        const scaleY = target.height / mapRect.height;
        return {
            left: target.left + (rect.left - mapRect.left) * scaleX,
            top: target.top + (rect.top - mapRect.top) * scaleY,
            width: rect.width * scaleX,
            height: rect.height * scaleY,
        };
    }
    function cssNumber(value, fallback = 0) {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    function drawRoundedRect(context, left, top, width, height, radius) {
        const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
        context.beginPath();
        context.moveTo(left + safeRadius, top);
        context.arcTo(left + width, top, left + width, top + height, safeRadius);
        context.arcTo(left + width, top + height, left, top + height, safeRadius);
        context.arcTo(left, top + height, left, top, safeRadius);
        context.arcTo(left, top, left + width, top, safeRadius);
        context.closePath();
    }
    function drawPrintTiles(context, mapContainer, mapRect, target) {
        const tiles = [...mapContainer.querySelectorAll('img.leaflet-tile')].filter(tile => tile.complete && tile.naturalWidth > 0);
        const scaleX = target.width / mapRect.width;
        const scaleY = target.height / mapRect.height;
        tiles.forEach(tile => {
            const rect = tile.getBoundingClientRect();
            try {
                context.drawImage(tile, target.left + (rect.left - mapRect.left) * scaleX, target.top + (rect.top - mapRect.top) * scaleY, rect.width * scaleX, rect.height * scaleY);
            } catch (error) {
                throw new Error('地図タイルをJPEGに含められません。地図を再読み込みしてから、もう一度お試しください。');
            }
        });
    }
    function drawPrintVectorLayers(context, mapContainer, mapRect, target) {
        const scaleX = target.width / mapRect.width;
        const scaleY = target.height / mapRect.height;
        const canvases = [...mapContainer.querySelectorAll('.leaflet-pane canvas')]
            .map(canvas => ({
                canvas,
                rect: canvas.getBoundingClientRect(),
                zIndex: cssNumber(window.getComputedStyle?.(canvas.parentElement)?.zIndex, 0),
            }))
            .filter(item => item.rect.width > 0 && item.rect.height > 0)
            .sort((a, b) => a.zIndex - b.zIndex);
        canvases.forEach(({ canvas, rect }) => {
            const style = window.getComputedStyle?.(canvas);
            context.save();
            context.globalAlpha = cssNumber(style?.opacity, 1);
            context.drawImage(
                canvas,
                target.left + (rect.left - mapRect.left) * scaleX,
                target.top + (rect.top - mapRect.top) * scaleY,
                rect.width * scaleX,
                rect.height * scaleY
            );
            context.restore();
        });
        if (typeof Path2D !== 'function') return;
        mapContainer.querySelectorAll('.leaflet-pane svg').forEach(svg => {
            const svgRect = svg.getBoundingClientRect();
            svg.querySelectorAll('path').forEach(path => {
                const definition = path.getAttribute('d');
                if (!definition) return;
                let shape;
                try { shape = new Path2D(definition); } catch (error) { return; }
                const style = window.getComputedStyle?.(path);
                context.save();
                context.translate(target.left + (svgRect.left - mapRect.left) * scaleX, target.top + (svgRect.top - mapRect.top) * scaleY);
                context.scale(scaleX, scaleY);
                context.globalAlpha = cssNumber(style?.opacity, 1);
                context.lineWidth = cssNumber(style?.strokeWidth, 1);
                if (style?.fill && style.fill !== 'none' && style.fill !== 'transparent') { context.fillStyle = style.fill; context.fill(shape); }
                if (style?.stroke && style.stroke !== 'none' && style.stroke !== 'transparent') { context.strokeStyle = style.stroke; context.stroke(shape); }
                context.restore();
            });
        });
    }
    function drawPrintLabel(context, label, mapRect, target) {
        const rect = label.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const destination = mapRectToPrint(rect, mapRect, target);
        const style = window.getComputedStyle?.(label) || {};
        const scaleX = target.width / mapRect.width;
        const scaleY = target.height / mapRect.height;
        drawRoundedRect(context, destination.left, destination.top, destination.width, destination.height, 5 * Math.min(scaleX, scaleY));
        context.fillStyle = style.backgroundColor || '#ffffff';
        context.fill();
        context.lineWidth = Math.max(1, cssNumber(style.borderTopWidth, 1) * Math.min(scaleX, scaleY));
        context.strokeStyle = style.borderTopColor || '#64748b';
        context.stroke();
        const paddingLeft = cssNumber(style.paddingLeft, 7) * scaleX;
        context.font = (style.fontWeight || '600') + ' ' + (cssNumber(style.fontSize, 12) * scaleY) + 'px ' + (style.fontFamily || 'sans-serif');
        context.textBaseline = 'middle';
        context.fillStyle = style.color || '#1f2937';
        const title = [...label.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent.trim()).join(' ') || label.textContent.trim();
        context.fillText(title, destination.left + paddingLeft, destination.top + destination.height / 2);
        const badge = label.querySelector('.xrds-schedule-badge');
        if (badge) {
            const badgeDestination = mapRectToPrint(badge.getBoundingClientRect(), mapRect, target);
            const badgeStyle = window.getComputedStyle?.(badge) || {};
            drawRoundedRect(context, badgeDestination.left, badgeDestination.top, badgeDestination.width, badgeDestination.height, 4 * Math.min(scaleX, scaleY));
            context.fillStyle = badgeStyle.backgroundColor || 'rgba(248,250,252,.9)';
            context.fill();
            context.lineWidth = Math.max(1, cssNumber(badgeStyle.borderTopWidth, 1) * Math.min(scaleX, scaleY));
            context.strokeStyle = badgeStyle.borderTopColor || '#64748b';
            context.stroke();
            context.font = (badgeStyle.fontWeight || '700') + ' ' + (cssNumber(badgeStyle.fontSize, 10) * scaleY) + 'px ' + (badgeStyle.fontFamily || 'sans-serif');
            context.fillStyle = badgeStyle.color || '#334155';
            context.fillText(badge.textContent.trim(), badgeDestination.left + 4 * scaleX, badgeDestination.top + badgeDestination.height / 2);
        }
    }
    function drawPrintHeader(context, target) {
        if (!printDisplayOptions.header) return;
        const spec = getPrintPaperSpec();
        const headerHeight = target.width / spec.widthMm * 9;
        const header = document.getElementById('map-print-header');
        const title = header?.querySelector('strong')?.textContent?.trim() || '地図管理';
        const detail = header?.querySelector('span')?.textContent?.trim() || ('表示中の業務なし / ' + printPaper + '横');
        context.fillStyle = '#ffffff';
        context.fillRect(target.left, target.top, target.width, headerHeight);
        context.textBaseline = 'middle';
        context.fillStyle = '#111827';
        context.font = '700 ' + (target.width / spec.widthMm * 11) + 'px sans-serif';
        context.fillText(title, target.left, target.top + headerHeight * .42);
        context.fillStyle = '#475569';
        context.font = '400 ' + (target.width / spec.widthMm * 9) + 'px sans-serif';
        const detailWidth = context.measureText(detail).width;
        context.fillText(detail, target.left + target.width - detailWidth, target.top + headerHeight * .42);
    }
    function drawPrintPaneTabs(context, mapContainer, mapRect, target) {
        if (!printDisplayOptions.paneTabs) return;
        const buttons = mapContainer.parentElement?.querySelectorAll('.map-pane-toggle') || [];
        const scaleX = target.width / mapRect.width;
        const scaleY = target.height / mapRect.height;
        [...buttons].forEach(button => {
            const rect = button.getBoundingClientRect();
            const destination = mapRectToPrint(rect, mapRect, target);
            const style = window.getComputedStyle?.(button) || {};
            drawRoundedRect(context, destination.left, destination.top, destination.width, destination.height, 9 * Math.min(scaleX, scaleY));
            context.fillStyle = style.backgroundColor || 'rgba(255,255,255,.96)';
            context.fill();
            context.lineWidth = Math.max(1, cssNumber(style.borderTopWidth, 1) * Math.min(scaleX, scaleY));
            context.strokeStyle = style.borderTopColor || '#b8c5d8';
            context.stroke();
            context.fillStyle = style.color || '#334155';
            context.font = (cssNumber(style.fontSize, 25) * scaleY) + 'px sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(button.textContent.trim(), destination.left + destination.width / 2, destination.top + destination.height / 2);
            context.textAlign = 'start';
        });
    }
    function waitForPrintTiles(mapContainer) {
        const pending = [...mapContainer.querySelectorAll('img.leaflet-tile')]
            .filter(tile => !tile.complete)
            .map(tile => new Promise(resolve => {
                const finish = () => resolve();
                tile.addEventListener('load', finish, { once: true });
                tile.addEventListener('error', finish, { once: true });
                window.setTimeout(finish, 1500);
            }));
        return Promise.all(pending);
    }
    function waitForLeafletPaint() {
        const requestFrame = window.requestAnimationFrame;
        if (typeof requestFrame !== 'function') {
            return new Promise(resolve => window.setTimeout(resolve, 32));
        }
        return new Promise(resolve => requestFrame(() => requestFrame(resolve)));
    }
    async function renderPrintJpegCanvas() {
        const mapContainer = leafletMap?.getContainer?.() || document.getElementById('leaflet-map');
        if (!mapContainer) throw new Error('地図表示が見つかりません。');
        const mapRect = mapContainer.getBoundingClientRect();
        if (!mapRect.width || !mapRect.height) throw new Error('地図表示のサイズを取得できません。');
        await waitForPrintTiles(mapContainer);
        const spec = getPrintPaperSpec();
        const canvas = document.createElement('canvas');
        canvas.width = spec.widthPx;
        canvas.height = spec.heightPx;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('JPEG出力用のキャンバスを作成できません。');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const margin = canvas.width * 10 / spec.widthMm;
        const target = { left: margin, top: margin, width: canvas.width - margin * 2, height: canvas.height - margin * 2 };
        drawPrintTiles(context, mapContainer, mapRect, target);
        drawPrintVectorLayers(context, mapContainer, mapRect, target);
        mapContainer.querySelectorAll('.xrds-label-text').forEach(label => drawPrintLabel(context, label, mapRect, target));
        drawPrintHeader(context, target);
        drawPrintPaneTabs(context, mapContainer, mapRect, target);
        return canvas;
    }
    function canvasToJpeg(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEGデータを作成できません。')), 'image/jpeg', .92);
        });
    }
    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    async function exportCurrentMapJpeg() {
        if (!printMode) setPrintMode(true);
        const button = document.getElementById('map-print-jpeg-btn');
        if (button) { button.disabled = true; button.textContent = 'JPEG作成中...'; }
        try {
            beforePrint();
            await waitForLeafletPaint();
            const canvas = await renderPrintJpegCanvas();
            const blob = await canvasToJpeg(canvas);
            const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            downloadBlob(blob, '地図_' + printPaper + '_' + stamp + '.jpg');
            status(printPaper + '横のJPEGを出力しました。');
        } catch (error) {
            alert('JPEG出力に失敗しました。' + String.fromCharCode(10) + error.message);
        } finally {
            updatePrintControls();
        }
    }
    function applyPrintPageSize() {
        const style = document.getElementById('xrds-print-page-style');
        if (style) { style.textContent = '@page { margin: 0; } @media print { body.xrds-print-mode .map-workspace-canvas { height: 100vh !important; min-height: 100vh !important; } }'; }
    }
    function updatePrintHeader() {
        const header = document.getElementById('map-print-header');
        if (!header) return;
        const names = Object.values(projectLayers).filter(project => project.visible).map(project => project.gyomu).join(' / ');
        header.innerHTML = '<strong>地図管理</strong><span>' + escapeHtml(names || '表示中の業務なし') + ' / ' + printPaper + '横</span>';
    }
    function updatePrintControls() {
        const paperWrap = document.getElementById('map-print-paper-wrap');
        const autoButton = document.getElementById('map-print-auto-btn');
        const saveButton = document.getElementById('map-print-save-btn');
        const printButton = document.getElementById('map-print-btn');
        const jpegButton = document.getElementById('map-print-jpeg-btn');
        const exitButton = document.getElementById('map-print-exit-btn');
        const headerWrap = document.getElementById('map-print-header-wrap');
        const paneTabsWrap = document.getElementById('map-print-pane-tabs-wrap');
        const printHelp = document.getElementById('map-print-help');
        if (paperWrap) paperWrap.hidden = !printMode;
        if (autoButton) autoButton.hidden = !printMode;
        if (saveButton) saveButton.hidden = !printMode;
        if (printButton) printButton.hidden = !printMode;
        if (exitButton) exitButton.hidden = !printMode;
        if (jpegButton) jpegButton.hidden = !printMode;
        if (headerWrap) headerWrap.hidden = !printMode;
        if (paneTabsWrap) paneTabsWrap.hidden = !printMode;
        if (printHelp) printHelp.hidden = !printMode;
        const printHeaderToggle = document.getElementById('map-print-header-toggle');
        const printPaneTabsToggle = document.getElementById('map-print-pane-tabs-toggle');
        if (printHeaderToggle) printHeaderToggle.checked = printDisplayOptions.header;
        if (printPaneTabsToggle) printPaneTabsToggle.checked = printDisplayOptions.paneTabs;
        const paperSelect = document.getElementById('map-print-paper');
        if (paperSelect) paperSelect.value = printPaper;
    }
    function setPrintMode(enabled) {
        printMode = Boolean(enabled);
        document.body?.classList.toggle('xrds-print-mode', printMode);
        applyPrintDisplayOptions();
        document.getElementById('tab-content-map')?.classList.toggle('map-print-mode', printMode);
        applyPrintPageSize();
        updatePrintControls();
        updatePrintHeader();
        if (leafletMap) {
            leafletMap.invalidateSize({ pan: false });
            renderVisibleMarkers();
        }
        status(printMode ? '印刷モードです。ラベルをドラッグして配置し、「印刷位置を保存」してください。' : '通常の地図表示に戻りました。');
    }
    function beforePrint() {
        applyPrintDisplayOptions();
        if (!printMode) return;
        applyPrintPageSize();
        leafletMap?.invalidateSize({ pan: false });
        updatePrintHeader();
        renderVisibleMarkers();
    }
    function afterPrint() {
        if (!printMode) return;
        setTimeout(() => {
            leafletMap?.invalidateSize({ pan: false });
            renderVisibleMarkers();
        }, 50);
    }
    function printCurrentMap() {
        if (!printMode) setPrintMode(true);
        applyPrintPageSize();
        setTimeout(() => window.print(), 50);
    }
    function resetPrintLabelAnchors() {
        if (!printMode) return;
        const targets = Object.values(projectLayers).filter(project => project.visible);
        const anchoredCount = targets.reduce((count, project) => count + project.features.filter(feature => getPrintLabelAnchor(feature)).length, 0);
        if (!anchoredCount) { status('自動配置へ戻すラベルはありません。'); return; }
        if (!confirm('表示中の業務に保存された印刷位置をすべて自動配置へ戻しますか？')) return;
        let cleared = 0;
        targets.forEach(project => project.features.forEach(feature => {
            if (!getPrintLabelAnchor(feature)) return;
            delete feature.properties.XRDS_print_label_anchor;
            project.dirty = true;
            printDirtyProjects.add(project);
            cleared++;
        }));
        renderVisibleMarkers();
        renderProjectTree();
        updatePrintControls();
        status(cleared + '件のラベルを自動配置へ戻しました。保存すると共有データへ反映されます。');
    }
    async function savePrintLayouts() {
        const targets = [...printDirtyProjects].filter(project => project.dirty);
        if (!targets.length) { status('保存する印刷位置はありません。'); return; }
        try {
            for (const project of targets) {
                const saved = await saveProject(project);
                if (saved === false) return;
            }
            status('印刷位置を保存しました。');
        } catch (error) {
            alert('印刷位置を保存できません: ' + error.message);
        }
    }
    async function onProjectTreeClick(event) {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const row = button.closest('[data-project-key]');
        if (!row) return;
        const [nendo, gyomu] = row.dataset.projectKey.split('::');
        const key = projectKey(nendo, gyomu);
        moveMode = false;
        addPointMode = false;
        if (button.dataset.action === 'toggle-facilities') {
            if (expandedProjectFacilities.has(key)) {
                expandedProjectFacilities.delete(key);
            } else {
                if (!projectLayers[key]) await ensureProjectLoaded(nendo, gyomu);
                expandedProjectFacilities.add(key);
            }
            renderProjectTree();
            return;
        }
        if (button.dataset.action === 'offline-save') {
            try {
                const project = await ensureProjectLoaded(nendo, gyomu);
                if (isBrowserOffline()) throw new Error('端末保存の更新にはオンライン接続が必要です。');
                if (!window.xrdsOffline?.saveProject) throw new Error('端末保存に対応していないブラウザです。');
                const result = await window.xrdsOffline.saveProject(project);
                project.offlineAvailable = true;
                project.offlineReadOnly = false;
                await refreshProjectTree();
                renderProjectTree();
                status('「' + gyomu + '」を端末へ保存しました（背景地図 ' + result.tiles.cached + '/' + result.tiles.requested + '枚）。');
            } catch (error) { alert('端末保存できません: ' + error.message); }
            return;
        }
        if (button.dataset.action === 'delete-facility') {
            await deleteFacility(nendo, gyomu, Number(button.dataset.featureIndex));
            return;
        }
        if (button.dataset.action === 'jump-facility') {
            const project = projectLayers[key] || await ensureProjectLoaded(nendo, gyomu);
            const index = Number(button.dataset.featureIndex);
            const feature = Number.isInteger(index) ? project.features[index] : null;
            const coord = getCoordinates(feature);
            if (!feature || !coord) {
                alert('この施設には有効な緯度・経度がありません。');
                return;
            }
            activeProjectKey = key;
            activeFeature = { project, index, feature, coord };
            if (!project.visible) {
                project.visible = true;
                if (leafletMap) project.leafletGroup.addTo(leafletMap);
            }
            if (leafletMap) leafletMap.setView([coord.lat, coord.lng], Math.max(leafletMap.getZoom(), 16));
            renderProjectTree();
            renderVisibleMarkers();
            renderDetail();
            status(`「${getFeatureDisplayName(feature, index)}」へ移動しました。`);
            return;
        }
        if (button.dataset.action === 'show') {
            const project = await ensureProjectLoaded(nendo, gyomu);
            project.visible = !project.visible;
            if (project.visible) project.leafletGroup.addTo(leafletMap); else leafletMap.removeLayer(project.leafletGroup);
            activeProjectKey = key;
            renderProjectTree(); renderVisibleMarkers(); fitToVisible(); renderDetail();
        } else if (button.dataset.action === 'edit') {
            const project = await ensureProjectLoaded(nendo, gyomu);
            activeProjectKey = key;
            activeFeature = null;
            if (!project.visible) { project.visible = true; project.leafletGroup.addTo(leafletMap); }
            renderProjectTree(); renderVisibleMarkers(); renderDetail();
            const pendingCount = getPendingSearchCount();
            status(pendingCount ? `「${gyomu}」へ${pendingCount}件を追加できます。右の追加ボタンを押してください。` : `「${gyomu}」を編集中です。地点を選択して属性を編集できます。`);
        } else if (button.dataset.action === 'zip') {
            const project = await ensureProjectLoaded(nendo, gyomu);
            exportProjectZip(project);
        } else if (button.dataset.action === 'delete-project') {
            await deleteProject(nendo, gyomu, row.dataset.revision);
        }
    }

    function isBrowserOffline() {
        return typeof navigator !== 'undefined' && navigator.onLine === false;
    }
    function hydrateProject(nendo, gyomu, data, readOnly) {
        const key = projectKey(nendo, gyomu);
        const cached = projectLayers[key];
        const meta = data?.xrds_meta || {};
        if (cached) {
            cached.features = Array.isArray(data?.features) ? data.features : [];
            cached.revision = meta.revision ?? cached.revision ?? null;
            cached.scheduleActiveImportId = meta.schedule_active_import_id ?? null;
            cached.scheduleImports = Array.isArray(meta.schedule_imports) ? meta.schedule_imports : [];
            cached.offlineReadOnly = Boolean(readOnly);
            cached.offlineAvailable = Boolean(cached.offlineAvailable || readOnly);
            cached.dirty = false;
            if (activeFeature?.project === cached) activeFeature = null;
            return cached;
        }
        projectLayers[key] = {
            nendo, gyomu, features: Array.isArray(data?.features) ? data.features : [],
            revision: meta.revision ?? null, visible: false, dirty: false,
            offlineAvailable: Boolean(readOnly), offlineReadOnly: Boolean(readOnly),
            scheduleActiveImportId: meta.schedule_active_import_id ?? null,
            scheduleImports: Array.isArray(meta.schedule_imports) ? meta.schedule_imports : [],
            leafletGroup: L.layerGroup(),
        };
        return projectLayers[key];
    }
    async function loadOfflineProject(nendo, gyomu) {
        if (!window.xrdsOffline?.getProject) return null;
        try { return await window.xrdsOffline.getProject(nendo, gyomu); } catch (error) { return null; }
    }
    function mergeProjectTrees(serverTree, cachedProjects) {
        const merged = (serverTree || []).map(year => ({
            nendo: year.nendo,
            projects: (year.projects || []).map(project => ({ ...project })),
        }));
        (cachedProjects || []).forEach(local => {
            let year = merged.find(item => item.nendo === local.nendo);
            if (!year) { year = { nendo: local.nendo, projects: [] }; merged.push(year); }
            let project = year.projects.find(item => item.gyomu === local.gyomu);
            if (!project) {
                project = { gyomu: local.gyomu, count: local.features?.length || 0, revision: local.revision, offline: true };
                year.projects.push(project);
            } else {
                project.offline = true;
            }
            project.offline_saved_at = local.saved_at || '';
        });
        return merged.sort((a, b) => String(a.nendo).localeCompare(String(b.nendo), 'ja'));
    }
    async function ensureProjectLoaded(nendo, gyomu) {
        const key = projectKey(nendo, gyomu);
        const cached = projectLayers[key];
        if (cached?.dirty) return cached;
        const local = await loadOfflineProject(nendo, gyomu);
        if (isBrowserOffline() && local) return hydrateProject(nendo, gyomu, local, true);
        try {
            const response = await fetch('/api/projects/load?nendo=' + encodeURIComponent(nendo) + '&gyomu=' + encodeURIComponent(gyomu));
            if (!response.ok) throw new Error(await response.text());
            return hydrateProject(nendo, gyomu, await response.json(), false);
        } catch (error) {
            if (local) return hydrateProject(nendo, gyomu, local, true);
            throw error;
        }
    }
    async function refreshProjectTree() {
        let serverTree = null;
        let serverError = null;
        try {
            const response = await fetch('/api/projects');
            if (!response.ok) throw new Error(await response.text());
            serverTree = (await response.json()).tree || [];
        } catch (error) {
            serverError = error;
        }
        try {
            offlineProjects = window.xrdsOffline?.listProjects ? await window.xrdsOffline.listProjects() : [];
        } catch (error) {
            offlineProjects = [];
        }
        if (serverTree === null && !offlineProjects.length) throw serverError || new Error('保存済み業務を読み込めません。');
        projectTreeData = mergeProjectTrees(serverTree || [], offlineProjects);
        populateDatalists(); renderProjectTree(); renderOfflineStatus();
        if (serverError && offlineProjects.length) status('サーバー未接続のため、端末保存業務を表示しています。');
    }
    function populateDatalists() {
        const years = document.getElementById('nendo-datalist');
        const names = document.getElementById('gyomu-datalist');
        if (years) years.innerHTML = [...new Set(projectTreeData.map(item => item.nendo))].map(value => `<option value="${escapeHtml(value)}">`).join('');
        if (names) names.innerHTML = [...new Set(projectTreeData.flatMap(item => item.projects.map(project => project.gyomu)))].map(value => `<option value="${escapeHtml(value)}">`).join('');
    }
    function getScheduleState(project) {
        const key = project ? projectKey(project.nendo, project.gyomu) : null;
        if (scheduleState.projectKey !== key) {
            scheduleState = { projectKey: key, baseRevision: project?.revision ?? null, sourceName: '', scheduleYear: String(project?.nendo || '').match(/\d{4}/)?.[0] || '', workbookBase64: '', preview: null, decisions: {}, applyEquipment: true };
        }
        return scheduleState;
    }
    function formatScheduleDate(value) {
        const date = String(value || '').slice(5).replace('-', '/');
        return date.replace(/^0/, '');
    }    function scheduleStatusPrefix(status) {
        return status === 'completed' ? '\u6e08' : status === 'reserve' ? '\u4e88\u5099' : status === 'unknown' ? '\u65e5\u6642\u78ba\u8a8d\u4e2d' : '\u70b9\u691c';
    }
    function getScheduleEvents(props) {
        return Array.isArray(props?.XRDS_inspection_schedule) ? props.XRDS_inspection_schedule.filter(event => event && event.date) : [];
    }
    function getScheduleInlineText(props) {
        if (!leafletMap || leafletMap.getZoom() < SCHEDULE_LABEL_ZOOM_THRESHOLD) return '';
        const seen = new Set();
        const parts = getScheduleEvents(props).slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).filter(event => {
            const key = `${event.date}|${event.status}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).map(event => `${scheduleStatusPrefix(event.status)} ${formatScheduleDate(event.date)}`);
        if (parts.length <= 3) return parts.join('\u30fb');
        return `${parts.slice(0, 3).join('\u30fb')} +${parts.length - 3}`;
    }
    function renderScheduleDetail(props) {
        const events = getScheduleEvents(props);
        if (!events.length) return '';
        const rows = events.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).map(event =>
            `<li><strong>${escapeHtml(formatScheduleDate(event.date))}</strong> ${escapeHtml(scheduleStatusPrefix(event.status))} <span>${escapeHtml(event.category || '')}</span></li>`
        ).join('');
        const inference = props?.XRDS_schedule_equipment_inference;
        const equipment = inference?.status === 'multiple' ? `\u8907\u6570\u6a5f\u6750: ${inference.categories.join(', ')}` : inference?.value ? `\u5de5\u7a0b\u8868\u63a8\u5b9a\u6a5f\u6750: ${inference.value}` : '';
        return `<section class="xrds-schedule-detail"><h4>\u70b9\u691c\u5de5\u7a0b\u8868</h4><ul>${rows}</ul>${equipment ? `<p class="xrds-schedule-equipment">${escapeHtml(equipment)}</p>` : ''}</section>`;
    }
    function scheduleLegendColor(fill) {
        const rgb = String(fill?.foreground?.rgb || '').replace(/^#/, '');
        return /^(?:[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/.test(rgb) ? `#${rgb.slice(-6)}` : '#e2e8f0';
    }
    function renderScheduleLegend(legend) {
        const items = (legend || []).map(item => `<span class="xrds-schedule-legend-item"><i style="background:${scheduleLegendColor(item.fill)}"></i>${escapeHtml(item.category || '')}</span>`).join('');
        return items ? `<div class="xrds-schedule-legend"><strong>Excel\u306e\u8272\u5206\u3051</strong>${items}</div>` : '';
    }
    function renderSchedulePreview(preview) {
        const summary = preview.summary || {};
        const rows = (preview.rows || []).map(row => {
            const match = row.match || {};
            const candidates = match.candidates || [];
            const inference = row.equipment_inference || {};
            const equipment = row.equipment_protected ? `\u624b\u52d5: ${row.existing_equipment} (\u5909\u66f4\u306a\u3057)` : inference.status === 'multiple' ? `\u8907\u6570: ${(inference.categories || []).join(', ')}` : inference.value || '-';
            let target = '';
            if (match.status === 'auto') target = `<span class="xrds-schedule-auto">${escapeHtml(match.feature_name || '')} (${escapeHtml(match.method || '')})</span>`;
            else if (match.status === 'confirm') target = `<select class="xrds-schedule-decision" data-schedule-row-key="${escapeHtml(row.source_key)}"><option value="">\u672a\u78ba\u5b9a</option>${candidates.map(candidate => `<option value="${escapeHtml(candidate.feature_id)}" ${getScheduleState().decisions[row.source_key] === candidate.feature_id ? 'selected' : ''}>${escapeHtml(candidate.feature_name)} (${Number(candidate.score || 0).toFixed(2)})</option>`).join('')}</select>`;
            else target = '<span class="xrds-schedule-unmatched">\u672a\u4e00\u81f4</span>';
            return `<tr><td>${escapeHtml(row.raw_name)}</td><td>${row.events.length}\u65e5</td><td>${target}</td><td>${escapeHtml(equipment)}</td></tr>`;
        }).join('');
        return `${renderScheduleLegend(preview.legend)}<p class="xrds-schedule-summary">\u81ea\u52d5\u4e00\u81f4 ${summary.auto_matches || 0}\u4ef6 / \u78ba\u8a8d ${summary.confirm_matches || 0}\u4ef6 / \u672a\u4e00\u81f4 ${summary.unmatched || 0}\u4ef6 / \u4e88\u5b9a\u65e5 ${summary.events || 0}\u4ef6</p><div class="xrds-schedule-table-wrap"><table class="xrds-schedule-table"><thead><tr><th>\u5de5\u7a0b\u8868\u540d</th><th>\u65e5\u6570</th><th>\u7167\u5408</th><th>\u6a5f\u6750\u63a8\u5b9a</th></tr></thead><tbody>${rows}</tbody></table></div>${(preview.warnings || []).map(warning => `<p class="xrds-schedule-warning">${escapeHtml(warning)}</p>`).join('')}`;
    }    function renderSchedulePanel(project) {
        const state = getScheduleState(project);
        const active = project?.scheduleActiveImportId;
        const preview = state.preview;
        return `<section class="map-schedule-panel"><h4>\u70b9\u691c\u5de5\u7a0b\u8868</h4><p class="map-field-help">Excel\u3092\u6574\u5f62\u305b\u305a\u8aad\u307f\u8fbc\u307f\u3001\u8272\u4ed8\u304d\u65e5\u4ed8\u3092\u6a4b\u3054\u3068\u306b\u7167\u5408\u3057\u307e\u3059\u3002\u5730\u56f3\u306e\u65e5\u4ed8\u306f\u30ba\u30fc\u30e014\u4ee5\u4e0a\u3067\u8868\u793a\u3057\u307e\u3059\u3002</p><label class="map-schedule-file-label">Excel<input id="map-schedule-file" type="file" accept=".xlsx,.xls" /></label><label>\u5e74<input id="map-schedule-year" type="text" inputmode="numeric" value="${escapeHtml(state.scheduleYear)}" placeholder="2026" /></label><div class="map-inline-actions"><button type="button" class="map-mini-btn" data-detail-action="schedule-preview">\u89e3\u6790\u30fb\u30d7\u30ec\u30d3\u30e5\u30fc</button>${active ? '<button type="button" class="map-mini-btn danger" data-detail-action="schedule-detach">\u5de5\u7a0b\u8868\u3092\u89e3\u9664</button>' : ''}</div>${preview ? `<div class="xrds-schedule-preview"><p><strong>${escapeHtml(preview.source?.file_name || state.sourceName)}</strong> / ${escapeHtml(preview.sheet_name || '')}</p>${renderSchedulePreview(preview)}<label class="map-schedule-equipment-check"><input id="map-schedule-apply-equipment" type="checkbox" ${state.applyEquipment ? 'checked' : ''}> \u5b89\u5168\u306b\u5224\u5b9a\u3067\u304d\u308b\u4f7f\u7528\u6a5f\u6750\u3092\u88dc\u5b8c</label><button type="button" class="map-mini-btn primary" data-detail-action="schedule-apply">\u78ba\u8a8d\u6e08\u307f\u306e\u7167\u5408\u3092\u53cd\u6620</button></div>` : active ? `<p class="map-field-help">\u73fe\u5728\u306e\u5de5\u7a0b\u8868\u3092\u53cd\u6620\u4e2d\u3067\u3059。\u540c\u3058Excel\u3092\u9078\u3076\u3068\u518d\u53d6\u8fbc\u3067\u304d\u307e\u3059\u3002</p>` : ''}</section>`;
    }
    async function fileToBase64(file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
        return btoa(binary);
    }
    async function previewSchedule(project) {
        const file = document.getElementById('map-schedule-file')?.files?.[0];
        const yearInput = document.getElementById('map-schedule-year');
        const year = String(yearInput?.value || '').trim();
        if (!file) { alert('\u5de5\u7a0b\u8868Excel\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002'); return; }
        if (!/^\d{4}$/.test(year)) { alert('\u5e74\u306f\u897f\u66a6\u0034\u6841\u3067\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002'); return; }
        const state = getScheduleState(project);
        try {
            state.sourceName = file.name; state.scheduleYear = year; state.workbookBase64 = await fileToBase64(file); state.baseRevision = project.revision;
            status('\u5de5\u7a0b\u8868\u3092\u89e3\u6790\u3057\u3066\u3044\u307e\u3059\u2026');
            const response = await fetch('/api/schedules/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nendo: project.nendo, gyomu: project.gyomu, schedule_year: year, source_name: file.name, workbook_base64: state.workbookBase64 }) });
            if (!response.ok) throw new Error(await response.text());
            state.preview = await response.json(); state.decisions = {};
            renderDetail(); status('\u5de5\u7a0b\u8868\u306e\u30d7\u30ec\u30d3\u30e5\u30fc\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f\u3002');
        } catch (error) { alert(`\u5de5\u7a0b\u8868\u3092\u89e3\u6790\u3067\u304d\u307e\u305b\u3093: ${error.message}`); }
    }
    async function applySchedule(project) {
        const state = getScheduleState(project);
        if (!state.preview || !state.workbookBase64) { alert('\u5148\u306b\u5de5\u7a0b\u8868\u3092\u30d7\u30ec\u30d3\u30e5\u30fc\u3057\u3066\u304f\u3060\u3055\u3044\u3002'); return; }
        try {
            const response = await fetch('/api/schedules/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nendo: project.nendo, gyomu: project.gyomu, schedule_year: state.scheduleYear, source_name: state.sourceName, workbook_base64: state.workbookBase64, import_id: state.preview.import_id, base_revision: state.baseRevision, decisions: state.decisions, apply_equipment: state.applyEquipment }) });
            if (response.status === 409) { alert('\u4ed6\u306e\u4eba\u304c\u66f4\u65b0\u3057\u305f\u305f\u3081\u3001\u5de5\u7a0b\u8868\u3092\u53cd\u6620\u3057\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u6700\u65b0\u30c7\u30fc\u30bf\u3092\u8aad\u307f\u76f4\u3057\u3066\u304f\u3060\u3055\u3044\u3002'); await refreshProjectTree(); return; }
            if (!response.ok) throw new Error(await response.text());
            const data = await response.json(); project.features = data.features || project.features; project.revision = data.revision; project.dirty = false; project.scheduleActiveImportId = data.import_id; state.preview = null; await refreshProjectTree(); renderVisibleMarkers(); renderDetail(); status('\u5de5\u7a0b\u8868\u3092\u53cd\u6620\u3057\u307e\u3057\u305f\u3002');
        } catch (error) { alert(`\u5de5\u7a0b\u8868\u3092\u53cd\u6620\u3067\u304d\u307e\u305b\u3093: ${error.message}`); }
    }
    async function detachSchedule(project) {
        if (!project.scheduleActiveImportId || !confirm('\u5de5\u7a0b\u8868\u7531\u6765\u306e\u65e5\u7a0b\u3068\u81ea\u52d5\u6a5f\u6750\u60c5\u5831\u3092\u89e3\u9664\u3057\u307e\u3059\u304b\uff1f')) return;
        try {
            const response = await fetch('/api/schedules/detach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nendo: project.nendo, gyomu: project.gyomu, import_id: project.scheduleActiveImportId, base_revision: project.revision }) });
            if (response.status === 409) { alert('\u4ed6\u306e\u4eba\u304c\u66f4\u65b0\u3057\u305f\u305f\u3081\u3001\u5de5\u7a0b\u8868\u3092\u89e3\u9664\u3057\u307e\u305b\u3093\u3067\u3057\u305f\u3002'); await refreshProjectTree(); return; }
            if (!response.ok) throw new Error(await response.text());
            const data = await response.json(); project.features = data.features || project.features; project.revision = data.revision; project.dirty = false; project.scheduleActiveImportId = null; getScheduleState(project).preview = null; await refreshProjectTree(); renderVisibleMarkers(); renderDetail(); status('\u5de5\u7a0b\u8868\u3092\u89e3\u9664\u3057\u307e\u3057\u305f\u3002');
        } catch (error) { alert(`\u5de5\u7a0b\u8868\u3092\u89e3\u9664\u3067\u304d\u307e\u305b\u3093: ${error.message}`); }
    }

    function getFeatureDisplayName(feature, index = 0) {
        const props = feature?.properties || {};
        const name = props.XRDS_display_name || props.DPF_title || props.syogen_shisetsu_meisyou;
        return String(name || `名称未設定 ${index + 1}`).trim();
    }
    function getGoogleMapsUrl(feature) {
        const coord = getCoordinates(feature);
        return coord
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${coord.lat},${coord.lng}`)}`
            : '';
    }
        function renderProjectFacilityList(project) {
        if (!project) return '<div class="map-project-facilities-empty">施設データを読み込めません。</div>';
        if (!project.features.length) return '<div class="map-project-facilities-empty">登録施設はありません。</div>';
        const mobileMode = Boolean(window.XRDS_MOBILE_MODE);
        return '<div class="map-project-facilities">' + project.features.map((feature, index) => {
            const name = getFeatureDisplayName(feature, index);
            const googleUrl = getGoogleMapsUrl(feature);
            const equipment = String(feature?.properties?.XRDS_equipment || '').trim();
            const equipmentColor = getEquipmentBorderColor(equipment);
            const workStatus = String(feature?.properties?.XRDS_work_status || '').trim();
            const statusBadge = workStatus ? '<span class="map-facility-status">進捗: ' + escapeHtml(workStatus) + '</span>' : '';
            const selected = activeFeature?.project === project && activeFeature.index === index ? ' active' : '';
            const google = googleUrl
                ? '<a class="map-google-btn" href="' + escapeHtml(googleUrl) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(name) + 'をGoogleマップで開く" aria-label="' + escapeHtml(name) + 'をGoogleマップで開く">G</a>'
                : '<span class="map-google-btn disabled" title="緯度・経度がありません" aria-label="Googleマップを開けません">G</span>';
            const equipmentMarker = equipmentColor
                ? '<i class="map-facility-equipment-marker" style="background-color:' + equipmentColor + ';" title="使用機材: ' + escapeHtml(equipment) + '"></i>'
                : '<i class="map-facility-equipment-marker empty" aria-hidden="true"></i>';
            const deleteButton = mobileMode ? '' : '<button type="button" class="map-facility-delete" data-action="delete-facility" data-feature-index="' + index + '" title="' + escapeHtml(name) + 'を業務から除外">削除</button>';
            return '<div class="map-facility-row' + selected + '">' +
                '<button type="button" class="map-facility-jump" data-action="jump-facility" data-feature-index="' + index + '" title="' + escapeHtml(name) + 'へ移動">' +
                equipmentMarker + '<span class="map-facility-index">' + (index + 1) + '.</span><span class="map-facility-name-wrap"><span class="map-facility-name">' + escapeHtml(name) + '</span>' + statusBadge + '</span></button>' +
                google + deleteButton + '</div>';
        }).join('') + '</div>';
    }function adjustActiveFeatureAfterRemoval(project, removedIndex) {
        if (!activeFeature || activeFeature.project !== project) return;
        if (activeFeature.index === removedIndex) {
            activeFeature = null;
            return;
        }
        if (activeFeature.index > removedIndex) {
            const nextIndex = activeFeature.index - 1;
            const nextFeature = project.features[nextIndex];
            activeFeature = nextFeature
                ? { project, index: nextIndex, feature: nextFeature, coord: getCoordinates(nextFeature) }
                : null;
        }
    }
    async function deleteFacility(nendo, gyomu, index) {
        const key = projectKey(nendo, gyomu);
        const project = projectLayers[key] || await ensureProjectLoaded(nendo, gyomu);
        const feature = project.features[index];
        if (!feature) return;
        const name = getFeatureDisplayName(feature, index);
        if (!confirm('「' + name + '」をこの業務から除外しますか？（保存するまで共有データは変わりません）')) return;
        project.features.splice(index, 1);
        project.dirty = true;
        adjustActiveFeatureAfterRemoval(project, index);
        renderProjectTree();
        renderVisibleMarkers();
        renderDetail();
        status('「' + name + '」を業務から除外しました。保存すると共有データへ反映されます。');
    }        function renderProjectTree() {
        const container = document.getElementById('project-tree');
        if (!container) return;
        const mobileMode = Boolean(window.XRDS_MOBILE_MODE);
        const query = (document.getElementById('map-project-search')?.value || '').trim().toLowerCase();
        let total = 0;
        let html = '';
        projectTreeData.forEach(year => {
            const projects = year.projects.filter(project => `${year.nendo} ${project.gyomu}`.toLowerCase().includes(query));
            if (!projects.length) return;
            html += `<section><strong style="font-size:13px;">${escapeHtml(year.nendo)}</strong>`;
            projects.forEach(project => {
                total++;
                const key = projectKey(year.nendo, project.gyomu);
                const loaded = projectLayers[key];
                const offline = Boolean(loaded?.offlineAvailable || project.offline);
                const active = activeProjectKey === key ? ' active' : '';
                const visible = loaded?.visible;
                const facilitiesExpanded = expandedProjectFacilities.has(key);
                const dirty = loaded?.dirty ? ' <span style="color:#b45309;">●未保存</span>' : '';
                const featureCount = loaded?.features?.length ?? project.count;
                const actionHtml = mobileMode
                    ? `<button class="map-mini-btn primary" data-action="show">${visible ? '地図から隠す' : '地図に表示'}</button>
                      <button class="map-mini-btn" data-action="toggle-facilities" aria-expanded="${facilitiesExpanded}">${facilitiesExpanded ? '▼ 施設一覧を隠す' : '▶ 施設一覧を表示'}</button>
                      <button class="map-mini-btn map-device-btn" data-action="offline-save">${offline ? '📱この端末を更新' : '📱この端末に保存'}</button>`
                    : `<button class="map-mini-btn primary" data-action="show">${visible ? '地図から隠す' : '地図に表示'}</button>
                      <button class="map-mini-btn" data-action="edit">編集</button>
                      <button class="map-mini-btn" data-action="toggle-facilities" aria-expanded="${facilitiesExpanded}">${facilitiesExpanded ? '▼ 施設一覧を隠す' : '▶ 施設一覧を表示'}</button>
                      <button class="map-mini-btn" data-action="zip">QGIS Zip</button>
                      <button class="map-mini-btn map-device-btn" data-action="offline-save">📱持ち出し保存／更新</button>
                      <button class="map-mini-btn danger" data-action="delete-project">削除</button>`;                html += `<div class="map-project-row${active}" data-project-key="${escapeHtml(key)}" data-revision="${escapeHtml(project.revision)}">
                    <div style="font-weight:700; font-size:13px;">${escapeHtml(project.gyomu)}</div>
                    <div style="font-size:12px; color:var(--text-light);">${featureCount}件${dirty}${offline ? ' <span class="map-offline-badge">📱端末保存済</span>' : ''}</div>
                    <div class="map-project-actions">${actionHtml}</div>
                    ${facilitiesExpanded ? renderProjectFacilityList(loaded) : ''}
                </div>`;
            });
            html += '</section>';
        });
        container.innerHTML = html || '<p class="map-detail-empty">該当する保存業務はありません。</p>';
        const count = document.getElementById('map-project-count'); if (count) count.textContent = `${total}業務`;
    }function fitToVisible() {
        const points = [];
        Object.values(projectLayers).filter(project => project.visible).forEach(project => project.features.forEach(feature => {
            const coord = getCoordinates(feature); if (coord) points.push([coord.lat, coord.lng]);
        }));
        if (points.length) leafletMap.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
    }
    function scheduleRenderVisibleMarkers() {
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(() => {
            renderTimer = null;
            renderVisibleMarkers();
        }, 90);
    }
    function rectanglesOverlap(a, b, margin = 5) {
        return !(a.right + margin <= b.left || b.right + margin <= a.left
            || a.bottom + margin <= b.top || b.bottom + margin <= a.top);
    }
    function estimateLabelWidth(title) {
        const textWidth = Array.from(title).reduce(
            (total, char) => total + (/[\x20-\x7e]/.test(char) ? 7 : 12), 0
        );
        return Math.max(58, Math.min(460, textWidth + 16));
    }
    function pointEquals(a, b, tolerance = 1) {
        return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
    }
    function segmentBounds(segment, margin = 0) {
        return {
            left: Math.min(segment.start.x, segment.end.x) - margin,
            top: Math.min(segment.start.y, segment.end.y) - margin,
            right: Math.max(segment.start.x, segment.end.x) + margin,
            bottom: Math.max(segment.start.y, segment.end.y) + margin,
        };
    }
    function orientation(a, b, c) {
        const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
        if (Math.abs(value) < 0.0001) return 0;
        return value > 0 ? 1 : 2;
    }
    function pointOnSegment(a, b, c) {
        return b.x <= Math.max(a.x, c.x) + 0.0001 && b.x + 0.0001 >= Math.min(a.x, c.x)
            && b.y <= Math.max(a.y, c.y) + 0.0001 && b.y + 0.0001 >= Math.min(a.y, c.y);
    }
    function segmentsIntersect(first, second) {
        if (pointEquals(first.start, second.start)) return false;
        const p1 = first.start; const q1 = first.end;
        const p2 = second.start; const q2 = second.end;
        const o1 = orientation(p1, q1, p2);
        const o2 = orientation(p1, q1, q2);
        const o3 = orientation(p2, q2, p1);
        const o4 = orientation(p2, q2, q1);
        if (o1 !== o2 && o3 !== o4) return true;
        return (o1 === 0 && pointOnSegment(p1, p2, q1))
            || (o2 === 0 && pointOnSegment(p1, q2, q1))
            || (o3 === 0 && pointOnSegment(p2, p1, q2))
            || (o4 === 0 && pointOnSegment(p2, q1, q2));
    }
    function segmentIntersectsRect(segment, rect, margin = 0) {
        const expanded = {
            left: rect.left - margin, top: rect.top - margin,
            right: rect.right + margin, bottom: rect.bottom + margin,
        };
        const inside = point => point.x >= expanded.left && point.x <= expanded.right
            && point.y >= expanded.top && point.y <= expanded.bottom;
        if (inside(segment.start) || inside(segment.end)) return true;
        const topLeft = { x: expanded.left, y: expanded.top };
        const topRight = { x: expanded.right, y: expanded.top };
        const bottomLeft = { x: expanded.left, y: expanded.bottom };
        const bottomRight = { x: expanded.right, y: expanded.bottom };
        return [
            { start: topLeft, end: topRight },
            { start: topRight, end: bottomRight },
            { start: bottomRight, end: bottomLeft },
            { start: bottomLeft, end: topLeft },
        ].some(edge => segmentsIntersect(segment, edge));
    }
    function createSpatialIndex(cellSize = 64) {
        const cells = new Map();
        const keysFor = rect => {
            const keys = [];
            const minX = Math.floor(rect.left / cellSize);
            const maxX = Math.floor(rect.right / cellSize);
            const minY = Math.floor(rect.top / cellSize);
            const maxY = Math.floor(rect.bottom / cellSize);
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) keys.push(`${x}:${y}`);
            }
            return keys;
        };
        return {
            add(item, rect) {
                keysFor(rect).forEach(key => {
                    if (!cells.has(key)) cells.set(key, new Set());
                    cells.get(key).add(item);
                });
            },
            query(rect) {
                const found = new Set();
                keysFor(rect).forEach(key => cells.get(key)?.forEach(item => found.add(item)));
                return [...found];
            },
        };
    }
    function closestPointOnRect(point, rect) {
        return {
            x: Math.max(rect.left, Math.min(point.x, rect.right)),
            y: Math.max(rect.top, Math.min(point.y, rect.bottom)),
        };
    }
    function generateLabelCandidates(item, mapSize) {
        const candidates = [];
        const angles = [
            0, Math.PI, -Math.PI / 2, Math.PI / 2,
            -Math.PI / 4, Math.PI / 4, -3 * Math.PI / 4, 3 * Math.PI / 4,
            -Math.PI / 8, Math.PI / 8, -3 * Math.PI / 8, 3 * Math.PI / 8,
            -5 * Math.PI / 8, 5 * Math.PI / 8, -7 * Math.PI / 8, 7 * Math.PI / 8,
        ];
        const gaps = [14, 24, 36, 52, 72, 98, 130, 170, 220, 280, 360, 460, 600];
        const addCandidate = (left, top, distance, edgePenalty = 0) => {
            const rect = {
                left: Math.round(left), top: Math.round(top),
                right: Math.round(left + item.width), bottom: Math.round(top + item.height),
            };
            if (rect.left < 4 || rect.top < 4 || rect.right > mapSize.x - 4 || rect.bottom > mapSize.y - 4) return;
            const line = { start: item.point, end: closestPointOnRect(item.point, rect) };
            candidates.push({ rect, line, baseScore: distance + edgePenalty });
        };
        gaps.forEach(gap => angles.forEach(angle => {
            const ux = Math.cos(angle); const uy = Math.sin(angle);
            const halfExtent = Math.abs(ux) * item.width / 2 + Math.abs(uy) * item.height / 2;
            const centerDistance = gap + halfExtent;
            addCandidate(
                item.point.x + ux * centerDistance - item.width / 2,
                item.point.y + uy * centerDistance - item.height / 2,
                gap
            );
        }));
        const verticalStep = Math.max(12, item.height + 4);
        for (let top = 4; top + item.height <= mapSize.y - 4; top += verticalStep) {
            addCandidate(4, top, Math.hypot(item.point.x - 4, item.point.y - top), 40);
            addCandidate(mapSize.x - item.width - 4, top, Math.hypot(mapSize.x - item.point.x, item.point.y - top), 40);
        }
        const horizontalStep = Math.max(24, Math.min(item.width + 4, 120));
        for (let left = 4; left + item.width <= mapSize.x - 4; left += horizontalStep) {
            addCandidate(left, 4, Math.hypot(item.point.x - left, item.point.y - 4), 50);
            addCandidate(left, mapSize.y - item.height - 4, Math.hypot(item.point.x - left, mapSize.y - item.point.y), 50);
        }
        return candidates;
    }
    function layoutLabelPlacements(items, mapSize, extraObstaclePoints = [], fixedPlacements = []) {
        const pointIndex = createSpatialIndex();
        const labelIndex = createSpatialIndex();
        const segmentIndex = createSpatialIndex();
        items.forEach(item => {
            const obstacle = {
                owner: item,
                rect: { left: item.point.x - 11, top: item.point.y - 11, right: item.point.x + 11, bottom: item.point.y + 11 },
            };
            pointIndex.add(obstacle, obstacle.rect);
        });
        extraObstaclePoints.forEach(point => {
            const obstacle = {
                owner: null,
                rect: { left: point.x - 20, top: point.y - 20, right: point.x + 20, bottom: point.y + 20 },
            };
            pointIndex.add(obstacle, obstacle.rect);
        });
        const placements = [];
        const unplaced = [];
        let crossings = 0;
        fixedPlacements.forEach(fixed => {
            placements.push(fixed);
            labelIndex.add(fixed, fixed.rect);
            segmentIndex.add(fixed, segmentBounds(fixed.line, 2));
        });
        items.filter(item => !item.fixedPlacement).forEach(item => {
            let best = null;
            generateLabelCandidates(item, mapSize).forEach(candidate => {
                const pointQueryRect = {
                    left: candidate.rect.left - 2, top: candidate.rect.top - 2,
                    right: candidate.rect.right + 2, bottom: candidate.rect.bottom + 2,
                };
                const labelQueryRect = {
                    left: candidate.rect.left - 3, top: candidate.rect.top - 3,
                    right: candidate.rect.right + 3, bottom: candidate.rect.bottom + 3,
                };
                if (pointIndex.query(pointQueryRect).some(obstacle => rectanglesOverlap(candidate.rect, obstacle.rect, 2))) return;
                if (labelIndex.query(labelQueryRect).some(placed => rectanglesOverlap(candidate.rect, placed.rect, 3))) return;
                const lineBounds = segmentBounds(candidate.line, 2);
                const labelLineHits = labelIndex.query(lineBounds).filter(placed =>
                    segmentIntersectsRect(candidate.line, placed.rect, 2)
                ).length;
                const coveredLines = segmentIndex.query(candidate.rect).filter(placed =>
                    segmentIntersectsRect(placed.line, candidate.rect, 2)
                ).length;

                const pointHits = pointIndex.query(lineBounds).filter(obstacle =>
                    obstacle.owner !== item && segmentIntersectsRect(candidate.line, obstacle.rect, 1)
                ).length;
                const crossingCount = segmentIndex.query(lineBounds).filter(placed =>
                    segmentsIntersect(candidate.line, placed.line)
                ).length;
                const score = candidate.baseScore + (labelLineHits + coveredLines) * 10000
                    + pointHits * 100000 + crossingCount * 1000000;
                if (!best || score < best.score) best = { ...candidate, score, crossingCount, pointHits, item };
            });
            if (!best) {
                unplaced.push(item);
                return;
            }
            placements.push(best);
            crossings += best.crossingCount;
            labelIndex.add(best, best.rect);
            segmentIndex.add(best, segmentBounds(best.line, 2));
        });
        return { placements, unplaced, crossings };
    }    function renderAggregateMarkers(entries) {
        const clusters = new Map();
        const severity = { other: 0, '1': 1, '2': 2, '3': 3, '4': 4 };
        entries.forEach(entry => {
            const point = leafletMap.latLngToContainerPoint([entry.coord.lat, entry.coord.lng]);
            const key = `${Math.floor(point.x / AGGREGATE_CELL_SIZE)}:${Math.floor(point.y / AGGREGATE_CELL_SIZE)}`;
            let cluster = clusters.get(key);
            if (!cluster) {
                cluster = { count: 0, lat: 0, lng: 0, hanteiKey: 'other' };
                clusters.set(key, cluster);
            }
            cluster.count += 1;
            cluster.lat += entry.coord.lat;
            cluster.lng += entry.coord.lng;
            const hanteiKey = getHanteiKey(entry.feature.properties);
            if (severity[hanteiKey] > severity[cluster.hanteiKey]) cluster.hanteiKey = hanteiKey;
        });
        const obstaclePoints = [];
        clusters.forEach(cluster => {
            const center = [cluster.lat / cluster.count, cluster.lng / cluster.count];
            const marker = L.circleMarker(center, {
                radius: Math.min(20, 7 + Math.log2(cluster.count + 1) * 2),
                color: PIN_COLOR, weight: 2, fillColor: PIN_COLOR, fillOpacity: .9,
            });
            marker.bindTooltip(`${cluster.count}地点（拡大すると個別表示）`, { sticky: true });
            marker.on('click', () => {
                moveMode = false;
                addPointMode = false;
                leafletMap.setView(center, Math.min(18, leafletMap.getZoom() + 2));
            });
            marker.addTo(aggregateLayer);
            obstaclePoints.push(leafletMap.latLngToContainerPoint(center));
        });
        return { clusterCount: clusters.size, obstaclePoints };
    }
    function renderLabels(entries, extraObstaclePoints = []) {
        const mobileMode = Boolean(window.XRDS_MOBILE_MODE);
        const mapSize = leafletMap.getSize();
        const ordered = [...entries].sort((a, b) => {
            const aSelected = activeFeature && activeFeature.project === a.project && activeFeature.index === a.index;
            const bSelected = activeFeature && activeFeature.project === b.project && activeFeature.index === b.index;
            return Number(bSelected) - Number(aSelected);
        });
        const items = ordered.map(entry => {
            const properties = entry.feature.properties || {};
            const baseTitle = getFeatureDisplayName(entry.feature, entry.index);
            const scheduleText = getScheduleInlineText(properties);
            const scheduleHtml = scheduleText
                ? '<span class="xrds-schedule-badge">' + escapeHtml(scheduleText) + '</span>'
                : '';
            const title = scheduleText ? baseTitle + ' | ' + scheduleText : baseTitle;
            const equipment = String(properties.XRDS_equipment || '').trim();
            const equipmentBorderColor = (displayOptions.equipmentBorders || mobileMode) ? getEquipmentBorderColor(equipment) : null;
            const point = leafletMap.latLngToContainerPoint([entry.coord.lat, entry.coord.lng]);
            const printAnchor = printMode ? getPrintLabelAnchor(entry.feature) : null;
            const width = Math.min(mapSize.x - 8, estimateLabelWidth(title) + (equipmentBorderColor ? 6 : 0));
            const height = scheduleText ? 30 : (equipmentBorderColor ? 30 : 24);
            return {
                entry, title, baseTitle, scheduleText, scheduleHtml, equipment, equipmentBorderColor,
                point, width, height, printAnchor, fixedPlacement: Boolean(printAnchor),
            };
        });
        const fixedPlacements = items.filter(item => item.printAnchor).map(item => {
            const anchorPoint = leafletMap.latLngToContainerPoint([item.printAnchor.lat, item.printAnchor.lng]);
            const rect = {
                left: Math.round(anchorPoint.x), top: Math.round(anchorPoint.y),
                right: Math.round(anchorPoint.x + item.width), bottom: Math.round(anchorPoint.y + item.height),
            };
            return {
                item,
                rect,
                line: { start: item.point, end: closestPointOnRect(item.point, rect) },
                fixed: true,
                crossingCount: 0,
            };
        });
        const layout = layoutLabelPlacements(items, mapSize, extraObstaclePoints, fixedPlacements);
        layout.placements.forEach(placement => {
            const { entry, baseTitle, scheduleHtml, equipment, equipmentBorderColor } = placement.item;
            const color = getColorFor(getHanteiKey(entry.feature.properties));
            const labelPoint = L.point(placement.rect.left, placement.rect.top);
            const labelLatLng = placement.fixed
                ? [placement.item.printAnchor.lat, placement.item.printAnchor.lng]
                : leafletMap.containerPointToLatLng(labelPoint);
            const lineTargetPoint = L.point(placement.line.end.x, placement.line.end.y);
            const lineTarget = leafletMap.containerPointToLatLng(lineTargetPoint);
            const leader = L.polyline(
                [[entry.coord.lat, entry.coord.lng], lineTarget],
                { pane: 'xrds-leader-pane', color: color.border, weight: 1.2, opacity: .72, interactive: false }
            );
            leader.addTo(entry.project.leafletGroup);
            const equipmentTitle = equipment ? ' title="equipment: ' + escapeHtml(equipment) + '"' : '';
            const label = L.marker(labelLatLng, {
                keyboard: false,
                draggable: printMode,
                icon: L.divIcon({
                    className: 'xrds-label-icon',
                    html: '<div class="xrds-label-text' + (equipmentBorderColor ? ' has-equipment' : '') + '"' + equipmentTitle
                        + ' style="background:' + color.fill + ';border-color:' + (equipmentBorderColor || color.border)
                        + ';color:' + color.text + ';">' + escapeHtml(baseTitle) + scheduleHtml + '</div>',
                    iconSize: [placement.item.width, placement.item.height],
                    iconAnchor: [0, 0],
                }),
            });
            let dragged = false;
            const updateLeader = () => {
                const currentLatLng = label.getLatLng();
                const currentPoint = leafletMap.latLngToContainerPoint(currentLatLng);
                const currentRect = {
                    left: currentPoint.x, top: currentPoint.y,
                    right: currentPoint.x + placement.item.width, bottom: currentPoint.y + placement.item.height,
                };
                const endpoint = closestPointOnRect(
                    leafletMap.latLngToContainerPoint([entry.coord.lat, entry.coord.lng]),
                    currentRect
                );
                leader.setLatLngs([[entry.coord.lat, entry.coord.lng], leafletMap.containerPointToLatLng(endpoint)]);
            };
            if (printMode) {
                label.on('dragstart', () => { dragged = true; });
                label.on('drag', updateLeader);
                label.on('dragend', event => {
                    const currentLatLng = event.target?.getLatLng?.() || label.getLatLng();
                    entry.feature.properties = entry.feature.properties || {};
                    entry.feature.properties.XRDS_print_label_anchor = [currentLatLng.lng, currentLatLng.lat];
                    entry.project.dirty = true;
                    printDirtyProjects.add(entry.project);
                    updateLeader();
                    renderProjectTree();
                    updatePrintControls();
                    status('ラベル位置を変更しました。保存すると印刷位置を共有できます。');
                });
            }
            label.on('click', () => {
                if (dragged) { dragged = false; return; }
                activeProjectKey = projectKey(entry.project.nendo, entry.project.gyomu);
                activeFeature = entry;
                moveMode = false;
                addPointMode = false;
                renderProjectTree();
                renderVisibleMarkers();
                renderDetail();
            });
            label.addTo(entry.project.leafletGroup);
        });
        return { placed: layout.placements.length, total: entries.length, unplaced: layout.unplaced.length, crossings: layout.crossings };
    }    function renderVisibleMarkers() {
        if (!leafletMap) return;
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        const entries = [];
        const paddedBounds = leafletMap.getBounds().pad(.18);
        if (aggregateLayer) aggregateLayer.clearLayers();
        Object.values(projectLayers).forEach(project => {
            project.leafletGroup.clearLayers();
            if (!project.visible) return;
            project.features.forEach((feature, index) => {
                const coord = getCoordinates(feature);
                if (coord && paddedBounds.contains([coord.lat, coord.lng])
                        && hanteiFilter.has(getHanteiKey(feature.properties))) {
                    entries.push({ project, index, feature, coord });
                }
            });
        });
        const aggregate = entries.length > MAX_INDIVIDUAL_MARKERS
            || (leafletMap.getZoom() < AGGREGATE_ZOOM_THRESHOLD && entries.length > AGGREGATE_COUNT_THRESHOLD);
        if (aggregate) {
            const aggregateResult = renderAggregateMarkers(entries);
            const labelResult = renderLabels(entries, aggregateResult.obstaclePoints);
            const canvasStatus = document.getElementById('map-canvas-status');
            if (canvasStatus) canvasStatus.textContent = `${entries.length}地点を${aggregateResult.clusterCount}個に集約し、${labelResult.placed}件のラベルを表示中。${labelResult.unplaced ? `表示領域に収まらないラベル: ${labelResult.unplaced}件。` : ''}`;
            return;
        }
        entries.forEach(entry => {
            const selected = activeFeature && activeFeature.project === entry.project && activeFeature.index === entry.index;
            const marker = L.circleMarker([entry.coord.lat, entry.coord.lng], {
                radius: selected ? 9 : 6, color: PIN_COLOR, weight: selected ? 3 : 1,
                fillColor: PIN_COLOR, fillOpacity: 1,
            });
            const schedulePopup = renderScheduleDetail(entry.feature.properties);
            if (schedulePopup) marker.bindPopup(schedulePopup, { maxWidth: 320 });
            marker.on('click', () => { activeProjectKey = projectKey(entry.project.nendo, entry.project.gyomu); activeFeature = entry; moveMode = false; addPointMode = false; renderProjectTree(); renderVisibleMarkers(); renderDetail(); });
            marker.addTo(entry.project.leafletGroup);
        });
        const labelResult = renderLabels(entries);
        const canvasStatus = document.getElementById('map-canvas-status');
        if (canvasStatus) canvasStatus.textContent = `${entries.length}地点・${labelResult.placed}件のラベルを表示中。${labelResult.unplaced ? `表示領域に収まらないラベル: ${labelResult.unplaced}件。` : ''}`;
    }        function renderDetail() {
        const panel = document.getElementById('map-detail-panel');
        if (!panel) return;
        const project = activeProjectKey && projectLayers[activeProjectKey];
        const pendingCount = getPendingSearchCount();
        const mobileMode = Boolean(window.XRDS_MOBILE_MODE);
        const readOnly = Boolean(project?.offlineReadOnly);
        if (mobileMode && activeFeature?.project === project) setPaneCollapsed('right', false);
        if (!project) {
            panel.innerHTML = `<div class="map-detail-empty">${pendingCount && !mobileMode ? `<strong>${pendingCount}件の検索結果を保持しています。</strong><br>` : ''}${mobileMode ? '左の保存済み業務を選択してください。' : '左の既存業にある「編集」を押して、追加先の業務を選択してください。'}</div>`;
            return;
        }
        if (!activeFeature || activeFeature.project !== project) {
            if (mobileMode) {
                panel.innerHTML = `<h3 class="map-panel-title">${escapeHtml(project.nendo)} / ${escapeHtml(project.gyomu)}</h3>
                  <p style="font-size:13px;line-height:1.6;">${project.features.length}件。地図上の地点または左の施設一覧を押すと詳細を表示します。</p>
                  <p class="map-offline-badge">📱持ち出し版・閲覧専用</p>
                  <div class="map-inline-actions"><button class="map-mini-btn primary" data-detail-action="fit-project">この業務に移動</button></div>`;
                return;
            }
            panel.innerHTML = `<h3 class="map-panel-title">${escapeHtml(project.nendo)} / ${escapeHtml(project.gyomu)}</h3>
              <p style="font-size:13px;line-height:1.6;">${project.features.length}件。地図上の地点を押すと詳細・編集画面を開きます。</p>${readOnly ? '<p class="map-offline-badge">📱オフライン持ち出しデータ（閲覧専用）</p>' : ''}${pendingCount ? `<p style="font-size:12px;line-height:1.5;color:#175c36;background:#e8f8ee;padding:9px;border-radius:7px;"><strong>${pendingCount}件の検索結果を追加できます。</strong></p>` : ''}
              <div class="map-inline-actions"><button class="map-mini-btn primary" data-detail-action="add-search">選択した検索結果を追加${pendingCount ? `（${pendingCount}件）` : ''}</button><button class="map-mini-btn" data-detail-action="add-empty-feature">空の地点を追加</button><button class="map-mini-btn primary" data-detail-action="save-project">この業務を保存</button><button class="map-mini-btn" data-detail-action="fit-project">この業務に移動</button></div>${renderSchedulePanel(project)}`;
            return;
        }
        const { feature, index } = activeFeature; const props = feature.properties || {}; const coord = getCoordinates(feature);
        const equipment = String(props.XRDS_equipment || '').trim();
        const customEquipment = Boolean(equipment) && !EQUIPMENT_OPTIONS.includes(equipment);
        if (mobileMode) {
            const noteToken = ++mobileNoteRenderToken;
            panel.innerHTML = `<h3 class="map-panel-title">地点詳細 <span style="font-size:12px;color:var(--text-light);">${escapeHtml(project.gyomu)} / ${index + 1}</span></h3>
              <p class="map-mobile-readonly-note">持ち出し版は閲覧専用です。編集はPC版で行ってください。</p>
              <div class="map-readonly-summary"><strong>${escapeHtml(getFeatureDisplayName(feature, index))}</strong>${props.XRDS_work_status ? `<span>進捗: ${escapeHtml(props.XRDS_work_status)}</span>` : ''}${equipment ? `<span>使用機材: ${escapeHtml(equipment)}</span>` : ''}${coord ? `<span>緯度経度: ${coord.lat.toFixed(6)}, ${coord.lng.toFixed(6)}</span>` : ''}</div>
              ${renderScheduleDetail(props)}
              ${renderOriginalAttributes(props)}
              ${renderMobileNotePanel()}`;
            hydrateMobileNotePanel(project, feature, noteToken);
            return;
        }
        panel.innerHTML = `<h3 class="map-panel-title">地点を編集 <span style="font-size:12px;color:var(--text-light);">${escapeHtml(project.gyomu)}</span></h3>
          <div class="map-editor"><label>元の施設名<input value="${escapeHtml(props.DPF_title || '')}" readonly></label>
          <label>地図上の表示名（社内用）<input id="map-edit-display-name" value="${escapeHtml(props.XRDS_display_name || '')}" placeholder="未入力なら元の施設名を表示"></label>
          <label>社内進捗<select id="map-edit-work-status">${renderWorkStatusOptions(props.XRDS_work_status)}</select></label>
          <label>使用機材<select id="map-edit-equipment-select">${renderEquipmentSelectOptions(equipment)}</select></label>
          <label id="map-edit-equipment-other-wrap" ${customEquipment ? '' : 'hidden'}>その他の使用機材<input id="map-edit-equipment-other" value="${customEquipment ? escapeHtml(equipment) : ''}" placeholder="使用機材名を入力"></label>
          ${renderScheduleDetail(props)}
          <small class="map-field-help">「その他」を選ぶと自由入力欄が表示され、紫色の太枠になります。</small>
          ${renderEquipmentLegend()}
          <label>社内メモ<textarea id="map-edit-note" style="min-height:90px; font-family:inherit;">${escapeHtml(props.XRDS_note || '')}</textarea></label>
          <label>緯度<input id="map-edit-lat" type="number" step="any" inputmode="decimal" value="${coord?.lat ?? ''}" placeholder="例: 35.681236"></label><label>経度<input id="map-edit-lng" type="number" step="any" inputmode="decimal" value="${coord?.lng ?? ''}" placeholder="例: 139.767125"></label>
          <div class="map-inline-actions"><button class="map-mini-btn" data-detail-action="move-to-coordinates">入力した緯度経度へ移動</button></div>
          <p class="map-field-help">緯度・経度を入力してこのボタンを押すか、入力欄で Enter キーを押すと地点が移動します。</p>
          ${renderOriginalAttributes(props)}
          <div class="map-inline-actions"><button class="map-mini-btn primary" data-detail-action="apply-feature">編集を反映</button><button class="map-mini-btn primary" data-detail-action="save-project">この業務を保存</button><button class="map-mini-btn" data-detail-action="move-feature">地図をクリックして移動</button><button class="map-mini-btn" data-detail-action="add-empty-feature">空の地点を追加</button><button class="map-mini-btn danger" data-detail-action="remove-feature">この地点を業務から除外</button></div>
          <p style="font-size:12px;color:var(--text-light);">反映後も「この業務を保存」を押すまでは共有データへ書き込みません。</p></div>`;
    }function applyActiveFeatureForm(project) {
        if (!activeFeature || activeFeature.project !== project) return false;
        const displayNameInput = document.getElementById('map-edit-display-name');
        if (!displayNameInput) return false;
        const feature = project.features[activeFeature.index];
        const properties = feature.properties || (feature.properties = {});
        properties.XRDS_display_name = displayNameInput.value.trim();
        properties.XRDS_work_status = document.getElementById('map-edit-work-status').value;
        const equipmentSelect = document.getElementById('map-edit-equipment-select');
        const equipmentOther = document.getElementById('map-edit-equipment-other');
        const previousEquipment = String(properties.XRDS_equipment || '').trim();
        const selectedEquipment = equipmentSelect.value === '__other__'
            ? equipmentOther.value.trim()
            : equipmentSelect.value;
        if (equipmentSelect.value === '__other__' && !selectedEquipment) {
            throw new Error('「その他」の使用機材名を入力してください。');
        }
        properties.XRDS_equipment = selectedEquipment;
        if (selectedEquipment !== previousEquipment) {
            properties.XRDS_equipment_source = selectedEquipment ? 'manual' : undefined;
            delete properties.XRDS_schedule_equipment_inference;
        } else if (selectedEquipment && !properties.XRDS_equipment_source) {
            properties.XRDS_equipment_source = 'manual';
        }
        properties.XRDS_note = document.getElementById('map-edit-note').value.trim();
        const latText = document.getElementById('map-edit-lat').value.trim();
        const lngText = document.getElementById('map-edit-lng').value.trim();
        const lat = Number(latText);
        const lng = Number(lngText);
        if (!latText || !lngText || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            throw new Error('緯度・経度が不正です。');
        }
        const oldCoordinates = feature.geometry.coordinates;
        if (oldCoordinates[0] !== lng || oldCoordinates[1] !== lat) {
            if (!Array.isArray(properties.XRDS_original_coordinates)) {
                properties.XRDS_original_coordinates = [...oldCoordinates];
            }
            feature.geometry.coordinates = [lng, lat];
        }
        project.dirty = true;
        moveMode = false;
        addPointMode = false;
        return true;
    }
    function moveActiveFeatureToCoordinateInputs(project) {
        try {
            if (!applyActiveFeatureForm(project)) return;
            const coord = getCoordinates(activeFeature.feature);
            renderVisibleMarkers();
            if (coord && leafletMap) {
                leafletMap.setView([coord.lat, coord.lng], Math.max(leafletMap.getZoom(), 15));
            }
            renderDetail();
            status('入力した緯度・経度へ地点を移動しました。「この業務を保存」で共有データへ反映します。');
        } catch (error) {
            alert(`緯度・経度の位置へ移動できません: ${error.message}`);
        }
    }
    function onDetailKeydown(event) {
        if (event.key !== 'Enter' || !['map-edit-lat', 'map-edit-lng'].includes(event.target?.id)) return;
        event.preventDefault();
        const project = activeProjectKey && projectLayers[activeProjectKey];
        if (project) moveActiveFeatureToCoordinateInputs(project);
    }
    function onDetailChange(event) {
        if (event.target?.dataset?.scheduleRowKey) {
            getScheduleState().decisions[event.target.dataset.scheduleRowKey] = event.target.value;
            return;
        }
        if (event.target?.id === 'map-schedule-apply-equipment') {
            getScheduleState().applyEquipment = event.target.checked;
            return;
        }
        if (event.target?.id !== 'map-edit-equipment-select') return;
        const wrap = document.getElementById('map-edit-equipment-other-wrap');
        const input = document.getElementById('map-edit-equipment-other');
        const custom = event.target.value === '__other__';
        if (wrap) wrap.hidden = !custom;
        if (input && !custom) input.value = '';
        if (input && custom) input.focus();
    }
    async function onDetailClick(event) {
        const button = event.target.closest('[data-detail-action]'); if (!button) return;
        const action = button.dataset.detailAction; const project = activeProjectKey && projectLayers[activeProjectKey];
        if (!project) return;
        if (action === 'save-mobile-note') return saveMobileNote(project);
        if (action === 'delete-mobile-note') return deleteMobileNote(project);
        if (project.offlineReadOnly && ['add-search', 'add-empty-feature', 'save-project', 'apply-feature', 'move-feature', 'remove-feature', 'schedule-preview', 'schedule-apply', 'schedule-detach'].includes(action)) {
            alert('オフライン持ち出しデータは閲覧専用です。オンラインに戻ってから編集してください。');
            return;
        }
        if (action === 'schedule-preview') { return previewSchedule(project); }
        if (action === 'schedule-apply') { return applySchedule(project); }
        if (action === 'schedule-detach') { return detachSchedule(project); }
        if (action === 'save-project') {
            moveMode = false;
            addPointMode = false;
            try {
                const applied = applyActiveFeatureForm(project);
                if (applied) renderVisibleMarkers();
                await saveProject(project);
                renderDetail();
            } catch (error) { alert(`業務を保存できません: ${error.message}`); }
            return;
        }
        if (action === 'add-search') return addSearchSelection(project);
        if (action === 'add-empty-feature') {
            moveMode = false;
            addPointMode = true;
            status(`「${project.gyomu}」に追加する位置を地図上でクリックしてください。`);
            return;
        }
        if (action === 'fit-project') { project.visible = true; project.leafletGroup.addTo(leafletMap); renderVisibleMarkers(); fitToVisible(); return; }
        if (!activeFeature) return;
        if (action === 'move-feature') { addPointMode = false; moveMode = true; status('地図上の新しい位置をクリックしてください。'); return; }
        if (action === 'move-to-coordinates') { moveActiveFeatureToCoordinateInputs(project); return; }
        if (action === 'remove-feature') { if (!confirm('この地点をこの業務から除外しますか？（保存するまで共有データは変わりません）')) return; project.features.splice(activeFeature.index, 1); project.dirty = true; activeFeature = null; renderVisibleMarkers(); renderDetail(); return; }
        if (action === 'apply-feature') {
            try {
                applyActiveFeatureForm(project);
                renderVisibleMarkers(); renderDetail(); status('地点の編集を反映しました。業務を保存すると共有データへ反映されます。');
            } catch (error) { alert(`編集内容を反映できません: ${error.message}`); }
        }
    }
    async function addSearchSelection(project) {
        const features = getSelectedSearchFeatures();
        if (!features.length) { alert('検索結果画面で施設を選び、「既存業務に追加」を押してください。'); return; }
        try {
            const existing = new Set(project.features.map(featureIdentity));
            let added = 0;
            features.forEach(feature => {
                const clone = cloneFeature(feature);
                const identity = featureIdentity(clone);
                if (existing.has(identity)) return;
                project.features.push(clone);
                existing.add(identity);
                added++;
            });
            window.__pendingMapFeatures = [];
            project.dirty = project.dirty || added > 0;
            project.visible = true;
            project.leafletGroup.addTo(leafletMap);
            renderVisibleMarkers();
            renderDetail();
            if (added) {
                status(`${added}件を「${project.gyomu}」へ追加しました。右の「この業務を保存」で共有データへ反映してください。`);
                alert(`${added}件を「${project.gyomu}」へ追加しました。\n続けて「この業務を保存」を押してください。`);
            } else {
                status('選択した施設は、すべて既にこの業務へ登録されています。');
                alert('選択した施設は、すべて既にこの業務へ登録されています。');
            }
        } catch (error) {
            alert(`既存業務に追加できません: ${error.message}`);
        }
    }
    async function saveProject(project) {
        if (project?.offlineReadOnly) {
            throw new Error('オフライン持ち出しデータは閲覧専用です。オンラインに戻ってから編集してください。');
        }
        const request = async revision => fetch('/api/projects/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nendo: project.nendo, gyomu: project.gyomu, features: project.features, base_revision: revision }) });
        let response = await request(project.revision);
        if (response.status === 409) { const conflict = await response.json(); if (!confirm(`${conflict.error}\n\n最新の保存内容を上書きしますか？`)) return false; response = await request(conflict.current_revision); }
        if (!response.ok) throw new Error(await response.text());
        project.revision = (await response.json()).revision; project.dirty = false; printDirtyProjects.delete(project); await refreshProjectTree(); renderProjectTree(); status(`「${project.gyomu}」を共有フォルダへ保存しました。`); return true;
    }
    async function saveSearchToMap() {
        const button = document.getElementById('save-map-btn');
        const nendo = document.getElementById('save-nendo-input')?.value.trim();
        const gyomu = document.getElementById('save-gyomu-input')?.value.trim();
        if (!nendo || !gyomu) { alert('保存する年度と業務名を入力してください。'); return; }
        const features = typeof window.collectSelectedFeatures === 'function' ? window.collectSelectedFeatures() : [];
        if (!features.length) { alert('保存する施設を選択してください。'); return; }
        const request = async revision => fetch('/api/projects/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nendo, gyomu, features, base_revision: revision }) });
        if (button) { button.disabled = true; button.textContent = '保存中...'; }
        try {
            let response = await request(null);
            if (response.status === 409) {
                const conflict = await response.json();
                if (!confirm(`${conflict.error}\n\n現在の検索結果で上書き保存しますか？`)) return;
                response = await request(conflict.current_revision);
            }
            if (!response.ok) throw new Error(await response.text());
            window.__savedToMapThisSession = true;
            alert(`「${gyomu}」として地図管理へ保存しました。`);
        } catch (error) {
            alert(`地図に保存できません。\n${error.message}`);
        } finally {
            if (button) { button.disabled = false; button.textContent = '🗺️ 地図に保存'; }
        }
    }
    function bindSearchSaveButton() {
        const button = document.getElementById('save-map-btn');
        if (button) button.onclick = saveSearchToMap;
    }
    async function createProject() {
        const nendo = document.getElementById('map-new-nendo').value.trim(); const gyomu = document.getElementById('map-new-gyomu').value.trim();
        if (!nendo || !gyomu) { alert('年度と業務名を入力してください。'); return; }
        const project = { nendo, gyomu, features: [], revision: null, visible: true, dirty: true, leafletGroup: L.layerGroup().addTo(leafletMap) };
        try { await saveProject(project); const canonical = projectKey(nendo.includes('年度') ? nendo : `${nendo.match(/\d{4}/)?.[0] || nendo}年度`, gyomu); projectLayers[canonical] = { ...project, nendo: canonical.split('::')[0] }; activeProjectKey = canonical; activeFeature = null; renderProjectTree(); renderDetail(); } catch (error) { alert(`業務を作成できません: ${error.message}`); }
    }
    async function deleteProject(nendo, gyomu, revision) {
        if (!confirm(`「${nendo} / ${gyomu}」を削除しますか？削除データはサーバー側の _trash に移動します。`)) return;
        const request = async current => fetch('/api/projects/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nendo, gyomu, base_revision: current }) });
        let response = await request(revision);
        if (response.status === 409) { alert('他の人が更新したため削除しませんでした。最新の一覧を確認してください。'); await refreshProjectTree(); return; }
        if (!response.ok) throw new Error(await response.text());
        const key = projectKey(nendo, gyomu); if (projectLayers[key]) { printDirtyProjects.delete(projectLayers[key]); leafletMap.removeLayer(projectLayers[key].leafletGroup); } delete projectLayers[key]; expandedProjectFacilities.delete(key); if (activeProjectKey === key) { activeProjectKey = null; activeFeature = null; }
        await refreshProjectTree(); renderVisibleMarkers(); renderDetail();
    }
    async function exportProjectZip(project) {
        const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ features: project.features }) });
        if (!response.ok) throw new Error(await response.text()); const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${project.gyomu}_search_results.zip`; anchor.click(); URL.revokeObjectURL(url);
    }
    bindPaneToggleEvents();
    bindSearchSaveButton();
    window.saveToMap = saveSearchToMap;
    window.onMapTabActivated = async function () {
        try {
            getSelectedSearchFeatures();
            if (!mapInitialized) { await initLeafletMap(); mapInitialized = true; }
            setTimeout(() => leafletMap?.invalidateSize(), 70);
            await refreshProjectTree();
            renderDetail();
            const pendingCount = getPendingSearchCount();
            if (pendingCount) status(`${pendingCount}件の検索結果を保持しています。左の既存業務で「編集」を押してください。`);
        } catch (error) { status(`地図管理を開けません: ${error.message}`); }
    };
})();