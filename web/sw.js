/* ピッと栄養 Service Worker — アプリ本体（シェル）をキャッシュしてオフラインでも開けるようにする。
 * API（GAS）や Google ログインの通信はキャッシュしない。 */
var VERSION = 'pitto-shell-v3';
var ASSETS = ['./', './index.html', './styles.css', './config.js', './logic.js', './api.js', './auth.js', './store.js', './scanner.js', './app.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './vendor/zxing-library-0.21.3.min.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(ASSETS.map(function (a) { return c.add(a).catch(function () { /* 無いファイルは無視 */ }); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // GAS / Google / CDN はそのまま
  var networkFirst = req.mode === 'navigate' || /\/(index\.html|config\.js|sw\.js)?$/.test(url.pathname);
  if (networkFirst) {
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); return res;
    }).catch(function () { return caches.match(req).then(function (r) { return r || caches.match('./index.html'); }); }));
  } else {
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); return res; });
    }));
  }
});
