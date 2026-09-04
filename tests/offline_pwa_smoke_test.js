const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const offlineSource = fs.readFileSync(path.join(root, 'static', 'offline.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'static', 'manifest.webmanifest'), 'utf8'));

assert.match(index, /manifest\.webmanifest/);
assert.match(index, /static\/offline\.js\?v=2/);
assert.match(index, /static\/map\.js\?v=31/);
assert.match(serviceWorker, /xrds-gsi-tiles-v1/);
assert.match(serviceWorker, /xrds-shell-v31/);
assert.match(serviceWorker, /static\/map\.js\?v=31/);
assert.match(serviceWorker, /request\.mode === 'navigate'/);
assert.match(offlineSource, /const DB_VERSION = 2/);
assert.match(offlineSource, /iphone_notes/);
assert.match(offlineSource, /keyPath: \['projectKey', 'facilityRef'\]/);
assert.match(offlineSource, /async function saveNote/);
assert.match(offlineSource, /async function deleteNote/);
assert.strictEqual(manifest.start_url, '/index.html?tab=map');

const context = {
    window: {},
    navigator: { onLine: true },
    location: { hostname: 'localhost' },
    console,
};
vm.runInNewContext(offlineSource, context);
const urls = context.window.xrdsOffline.collectTileUrls([
    { geometry: { coordinates: [139.76, 35.68] } },
    { geometry: { coordinates: [141.35, 43.06] } },
], { minZoom: 9, maxZoom: 15, maxTiles: 20, padding: 1 });
assert.ok(urls.length > 0 && urls.length <= 20);
assert.ok(urls.every(url => url.includes('cyberjapandata.gsi.go.jp/xyz/pale/')));
assert.equal(context.window.xrdsOffline.facilityRefFor({ properties: { shisetsu_id: 'A-1' }, geometry: { coordinates: [139.1, 35.2] } }), 'id:A-1');
assert.match(context.window.xrdsOffline.facilityRefFor({ properties: { DPF_title: '地点A' }, geometry: { coordinates: [139.1, 35.2] } }), /^point:地点A\|35\.2000000\|139\.1000000$/);

console.log('offline PWA smoke test passed');
