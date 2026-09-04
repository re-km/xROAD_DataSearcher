const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mobile = fs.readFileSync(path.join(root, 'mobile.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'static', 'manifest-mobile.webmanifest'), 'utf8'));
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const map = fs.readFileSync(path.join(root, 'static', 'map.js'), 'utf8');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

assert(mobile.includes('window.XRDS_MOBILE_MODE = true;'), 'mobile mode flag is missing');
assert(mobile.includes('/static/map.js?v=33'), 'mobile entry must use the current shared map script');
assert(mobile.includes('/static/manifest-mobile.webmanifest'), 'mobile manifest link is missing');
assert(!mobile.includes('map-print-mode-btn'), 'mobile entry must not expose print mode');
assert(!mobile.includes('save-map-btn'), 'mobile entry must not expose search save controls');
assert(manifest.start_url === '/mobile.html', 'mobile manifest start_url is incorrect');
assert(manifest.display === 'standalone', 'mobile manifest must be installable');
assert(serviceWorker.includes("'/mobile.html'"), 'service worker shell must include mobile.html');
assert(serviceWorker.includes("'/static/manifest-mobile.webmanifest'"), 'service worker shell must include mobile manifest');
assert(serviceWorker.includes("url.pathname === '/mobile.html' ? '/mobile.html' : '/index.html'"), 'navigation fallback must preserve mobile entry');
assert(map.includes('Boolean(window.XRDS_MOBILE_MODE)'), 'shared map code must have a mobile mode branch');
assert(map.includes('持ち出し版は閲覧専用です'), 'mobile detail must be read-only');
assert(map.includes('data-action="offline-save"'), 'mobile entry must provide per-device offline save');
assert(map.includes('この端末に保存'), 'mobile entry must label the per-device save action');
assert(mobile.includes('/static/offline.js?v=2'), 'mobile entry must use the memo-capable offline script');
assert(map.includes('data-detail-action="save-mobile-note"'), 'mobile detail must provide memo save');
assert(map.includes('data-detail-action="delete-mobile-note"'), 'mobile detail must provide memo delete');
assert(map.includes('PC共有データへ送信しません'), 'mobile memo must be local-only');

console.log('mobile entry smoke test passed');
