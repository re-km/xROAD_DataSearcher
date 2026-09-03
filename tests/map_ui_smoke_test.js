const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const mapPath = path.join(root, 'static', 'map.js');
const indexPath = path.join(root, 'index.html');
const source = fs.readFileSync(mapPath, 'utf8');
const instrumented = source.replace(
    /\}\)\(\);\s*$/,
    `window.__xrdsMapTest = {
        seed(project) {
            const key = projectKey(project.nendo, project.gyomu);
            projectLayers[key] = project;
            activeProjectKey = key;
            activeFeature = null;
            leafletMap = null;
        },
        renderDetail,
        renderProjectTree,
        onProjectTreeClick,
        onMapDisplayOptionChange,
        onPrintDisplayOptionChange,
        displayOptions() { return { ...displayOptions }; },
        printDisplayOptions() { return { ...printDisplayOptions }; },
        onDetailClick,
        onDetailChange,
        onMapClick,
        layoutLabelPlacements,
        rectanglesOverlap,
        segmentsIntersect,
        segmentIntersectsRect,
        setProjectTreeData(data) { projectTreeData = data; },
        state() { return { activeFeature, addPointMode, moveMode }; },
    };
})();`
);
assert.notEqual(instrumented, source, 'map.js のテストフックを挿入できません');
assert.match(source, /SCHEDULE_LABEL_ZOOM_THRESHOLD = 14/);
assert.match(source, /leafletMap\.on\('zoomend'/);
const elements = {
    'map-detail-panel': { innerHTML: '' },
};
let savedPayload = null;
const context = {
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
    alert(message) {
        throw new Error(`予期しない alert: ${message}`);
    },
    confirm() {
        return true;
    },
    document: {
        getElementById(id) {
            return elements[id] || null;
        },
    },
    window: {},
    async fetch(url, options = {}) {
        if (url === '/api/projects/save') {
            savedPayload = JSON.parse(options.body);
            return {
                ok: true,
                status: 200,
                async json() { return { revision: 'sha256:test' }; },
                async text() { return ''; },
            };
        }
        if (url === '/api/projects') {
            return {
                ok: true,
                status: 200,
                async json() { return { tree: [] }; },
                async text() { return ''; },
            };
        }
        throw new Error(`予期しない fetch: ${url}`);
    },
};
vm.createContext(context);
vm.runInContext(instrumented, context, { filename: mapPath });

const test = context.window.__xrdsMapTest;
const project = {
    nendo: '2026年度',
    gyomu: 'UIテスト業務',
    features: [],
    revision: 'sha256:base',
    visible: true,
    dirty: false,
    leafletGroup: {
        addTo() { return this; },
        clearLayers() {},
    },
};
const clickAction = action => ({
    target: {
        closest() {
            return { dataset: { detailAction: action } };
        },
    },
});

const projectTreeAction = (action, featureIndex) => {
    const row = { dataset: { projectKey: '2026年度::UIテスト業務', revision: 'sha256:test' } };
    const button = {
        dataset: { action, featureIndex: featureIndex === undefined ? undefined : String(featureIndex) },
        closest(selector) {
            return selector === '[data-project-key]' ? row : null;
        },
    };
    return {
        target: {
            closest(selector) {
                return selector === 'button[data-action]' ? button : null;
            },
        },
    };
};

(async () => {
    test.seed(project);
    test.renderDetail();
    assert.match(elements['map-detail-panel'].innerHTML, /この業務を保存/);
    assert.match(elements['map-detail-panel'].innerHTML, /空の地点を追加/);

    await test.onDetailClick(clickAction('add-empty-feature'));
    assert.equal(test.state().addPointMode, true);
    test.onMapClick({ latlng: { lat: 35.123456, lng: 135.654321 } });

    assert.equal(project.features.length, 1);
    assert.equal(project.features[0].type, 'Feature');
    assert.equal(project.features[0].geometry.type, 'Point');
    assert.equal(project.features[0].geometry.coordinates[0], 135.654321);
    assert.equal(project.features[0].geometry.coordinates[1], 35.123456);
    assert.equal(Object.keys(project.features[0].properties).length, 0);
    assert.equal(project.dirty, true);
    assert.match(elements['map-detail-panel'].innerHTML, /地点を編集/);
    assert.match(elements['map-detail-panel'].innerHTML, /この業務を保存/);
    assert.match(elements['map-detail-panel'].innerHTML, /入力した緯度経度へ移動/);
    assert.match(elements['map-detail-panel'].innerHTML, /id="map-edit-equipment-select"/);
    assert.match(elements['map-detail-panel'].innerHTML, /<option value="施設点検車"/);

    Object.assign(elements, {
        'map-edit-display-name': { value: '空地点A' },
        'map-edit-work-status': { value: '準備中' },
        'map-edit-equipment-select': { id: 'map-edit-equipment-select', value: '橋梁点検車' },
        'map-edit-equipment-other-wrap': { hidden: true },
        'map-edit-equipment-other': { value: '', focus() {} },
        'map-edit-note': { value: '地図上で追加' },
        'map-edit-lat': { value: '34.987654' },
        'map-edit-lng': { value: '136.456789' },
    });
    await test.onDetailClick(clickAction('move-to-coordinates'));

    assert.equal(project.features[0].geometry.coordinates[0], 136.456789);
    assert.equal(project.features[0].geometry.coordinates[1], 34.987654);
    assert.equal(project.features[0].properties.XRDS_original_coordinates[0], 135.654321);
    assert.equal(project.features[0].properties.XRDS_original_coordinates[1], 35.123456);

    await test.onDetailClick(clickAction('save-project'));

    assert.ok(savedPayload, '保存APIが呼ばれていません');
    assert.equal(savedPayload.features[0].properties.XRDS_display_name, '空地点A');
    assert.equal(savedPayload.features[0].properties.XRDS_work_status, '準備中');
    assert.equal(savedPayload.features[0].properties.XRDS_equipment, '橋梁点検車');
    assert.equal(savedPayload.features[0].properties.XRDS_note, '地図上で追加');
    assert.equal(project.dirty, false);

    elements['map-edit-equipment-select'].value = '施設点検車';
    await test.onDetailClick(clickAction('apply-feature'));
    assert.equal(project.features[0].properties.XRDS_equipment, '施設点検車');
    assert.match(elements['map-detail-panel'].innerHTML, /<option value="施設点検車" selected>/);

    Object.assign(elements, {
        'project-tree': { innerHTML: '' },
        'map-project-search': { value: '' },
        'map-project-count': { textContent: '' },
    });
    test.setProjectTreeData([{
        nendo: '2026年度',
        projects: [{ gyomu: 'UIテスト業務', count: 1, revision: 'sha256:test' }],
    }]);
    await test.onProjectTreeClick(projectTreeAction('toggle-facilities'));
    const facilityHtml = elements['project-tree'].innerHTML;
    assert.match(facilityHtml, /施設一覧を隠す/);
    assert.match(facilityHtml, /空地点A/);
    assert.match(facilityHtml, /data-action="jump-facility"/);
    assert.match(facilityHtml, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=34\.987654%2C136\.456789/);
    assert.match(facilityHtml, /target="_blank"/);
    assert.match(facilityHtml, /map-facility-equipment-marker/);
    assert.match(facilityHtml, /進捗: 準備中/);
    assert.match(facilityHtml, /data-action="delete-facility"/);
    assert.match(facilityHtml, /background-color:#0b5d1e/);

    elements['map-edit-equipment-select'].value = '__other__';
    test.onDetailChange({ target: elements['map-edit-equipment-select'] });
    assert.equal(elements['map-edit-equipment-other-wrap'].hidden, false);
    elements['map-edit-equipment-other'].value = '特殊点検車';
    await test.onDetailClick(clickAction('apply-feature'));
    assert.equal(project.features[0].properties.XRDS_equipment, '特殊点検車');
    test.renderProjectTree();
    assert.match(elements['project-tree'].innerHTML, /background-color:#7e22ce/);

    Object.assign(elements, {
        'map-label-color-toggle': { id: 'map-label-color-toggle', checked: false },
        'map-equipment-border-toggle': { id: 'map-equipment-border-toggle', checked: false },
    });
    test.onMapDisplayOptionChange({ target: elements['map-label-color-toggle'] });
    test.onMapDisplayOptionChange({ target: elements['map-equipment-border-toggle'] });
    assert.equal(test.displayOptions().hanteiColors, false);
    assert.equal(test.displayOptions().equipmentBorders, false);
    elements['map-label-color-toggle'].checked = true;
    elements['map-equipment-border-toggle'].checked = true;
    test.onMapDisplayOptionChange({ target: elements['map-label-color-toggle'] });
    test.onMapDisplayOptionChange({ target: elements['map-equipment-border-toggle'] });
    assert.equal(test.displayOptions().hanteiColors, true);
    assert.equal(test.displayOptions().equipmentBorders, true);
    Object.assign(elements, {
        'map-print-header-toggle': { id: 'map-print-header-toggle', checked: false },
        'map-print-pane-tabs-toggle': { id: 'map-print-pane-tabs-toggle', checked: true },
    });
    test.onPrintDisplayOptionChange({ target: elements['map-print-header-toggle'] });
    elements['map-print-pane-tabs-toggle'].checked = true;
    test.onPrintDisplayOptionChange({ target: elements['map-print-pane-tabs-toggle'] });
    assert.equal(test.printDisplayOptions().header, false);
    assert.equal(test.printDisplayOptions().paneTabs, true);
    elements['map-print-pane-tabs-toggle'].checked = false;
    test.onPrintDisplayOptionChange({ target: elements['map-print-pane-tabs-toggle'] });
    elements['map-print-header-toggle'].checked = true;
    test.onPrintDisplayOptionChange({ target: elements['map-print-header-toggle'] });

    assert.equal(test.printDisplayOptions().header, true);
    assert.equal(test.printDisplayOptions().paneTabs, false);
    const denseLabels = Array.from({ length: 30 }, (_, index) => ({
        id: index,
        point: { x: 450, y: 320 },
        width: 76,
        height: 24,
    }));
    const denseLayout = test.layoutLabelPlacements(denseLabels, { x: 1000, y: 700 });
    assert.equal(denseLayout.placements.length, denseLabels.length);
    assert.equal(denseLayout.unplaced.length, 0);
    for (let i = 0; i < denseLayout.placements.length; i++) {
        const current = denseLayout.placements[i];
        assert.equal(
            current.rect.left <= 461 && current.rect.right >= 439
                && current.rect.top <= 331 && current.rect.bottom >= 309,
            false,
            'ラベルが地点予約領域を隠しています'
        );
        for (let j = i + 1; j < denseLayout.placements.length; j++) {
            const other = denseLayout.placements[j];
            assert.equal(test.rectanglesOverlap(current.rect, other.rect, 3), false, 'ラベル同士が重なっています');


            assert.equal(test.segmentsIntersect(current.line, other.line), false, '同一点からの引出線を交差として扱っています');
        }
    }

    const ringLabels = Array.from({ length: 16 }, (_, index) => {
        const angle = index * Math.PI * 2 / 16;
        return {
            id: index,
            point: { x: 450 + Math.cos(angle) * 24, y: 320 + Math.sin(angle) * 24 },
            width: 76,
            height: 24,
        };
    });
    const ringLayout = test.layoutLabelPlacements(ringLabels, { x: 1000, y: 700 });
    assert.equal(ringLayout.placements.length, ringLabels.length);
    assert.equal(ringLayout.unplaced.length, 0);
    assert.equal(ringLayout.crossings, 0, '引出線が交差しています');

    await test.onProjectTreeClick(projectTreeAction('jump-facility', 0));
    assert.equal(test.state().activeFeature.index, 0);
    await test.onProjectTreeClick(projectTreeAction('toggle-facilities'));
    assert.doesNotMatch(elements['project-tree'].innerHTML, /map-project-facilities/);
    project.features[0].properties.XRDS_inspection_schedule = [{ date: '2026-09-24', category: '\u70b9\u691c\u8eca(BT110)', status: 'planned' }];
    test.renderDetail();
    assert.match(elements['map-detail-panel'].innerHTML, /\u70b9\u691c\u5de5\u7a0b\u8868/);
    assert.match(elements['map-detail-panel'].innerHTML, /0?9\/24/);
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    assert.match(indexHtml, /\.xrds-label-text\.has-equipment\s*\{\s*border-width:\s*4px;/);
    assert.match(indexHtml, /\.xrds-label-text\s*\{[^}]*border:\s*1px solid;/);
    assert.match(indexHtml, /static\/map\.js\?v=22/);
    assert.match(indexHtml, /id="map-label-color-toggle"/);
    assert.match(indexHtml, /id="map-equipment-border-toggle"/);
    assert.match(indexHtml, /id="map-print-header-toggle"/);
    assert.match(indexHtml, /id="map-print-pane-tabs-toggle"/);
    assert.match(indexHtml, /xrds-print-hide-header/);
    assert.match(indexHtml, /xrds-print-show-pane-tabs/);
    assert.match(indexHtml, /value="A3">A3横/);
    assert.match(source, /XRDS_print_label_anchor/);

    await test.onProjectTreeClick(projectTreeAction('toggle-facilities'));
    assert.match(elements['project-tree'].innerHTML, /map-facility-delete/);
    await test.onProjectTreeClick(projectTreeAction('delete-facility', 0));
    assert.equal(project.features.length, 0);
    assert.equal(project.dirty, true);
    console.log('map UI smoke test: OK');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
