'use strict';
/* ローカル開発・E2E用: モックGASを HTTP で公開し、同じサーバで web/ を配信する。
 *   node gas/test/server.js [port]   → http://localhost:8787/ でアプリ、/exec が API（devモード）
 * 本物の GAS と同じく POST text/plain の JSON を受け、Access-Control-Allow-Origin: * を返す。 */
process.env.TZ = process.env.TZ || 'Asia/Tokyo';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./mock-gas.js');

const port = Number(process.argv[2] || process.env.PORT || 8787);
const webDir = path.join(__dirname, '..', '..', 'web');
const OFF_JAN = '4902102072618';
const offResponse = { status: 1, product: { product_name: 'Test Cola', brands: 'TestBrand', quantity: '500 ml', nutriments: { 'energy-kcal_100g': 45, proteins_100g: 0, fat_100g: 0, carbohydrates_100g: 11.3, sodium_100g: 0.01, sugars_100g: 11.3 } } };
const ocrResult = { basis: 'per_package', serving_g: 110, package_g: 110, name: 'サラダチキン（OCR）', energy_kcal: 121, protein_g: 26, fat_g: 1.6, carb_g: 0.5, salt_g: null, sodium_mg: 470, sugar_g: null, fiber_g: null, satfat_g: 0.4, confidence: 0.62, notes: 'ナトリウム表記' };
const gas = createGas({
  properties: { AUTH_MODE: 'dev', DEBUG: '1', CLAUDE_API_KEY: 'mock' },
  fetch: (url) => {
    if (url.includes('openfoodfacts.org')) return url.includes(OFF_JAN) ? { code: 200, body: offResponse } : { code: 404, body: { status: 0 } };
    if (url.includes('api.anthropic.com')) return { code: 200, body: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(ocrResult) }] } };
    return { code: 500, body: 'mock: unknown url ' + url };
  }
});
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/exec') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let out;
      try {
        if (req.method === 'GET') out = gas.get(Object.fromEntries(url.searchParams.entries()));
        else out = gas.postRaw(body || '{}');
      } catch (e) { out = { ok: false, error: { code: 'internal', message: String(e && e.stack || e) } }; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    res.end(`window.PITTO_CONFIG = { apiUrl: 'http://localhost:${port}/exec', googleClientId: '', devToken: 'dev', appName: 'ピッと栄養', version: 'dev', syncDays: 35 };`);
    return;
  }
  let file = path.join(webDir, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(webDir)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
server.listen(port, () => console.log('pitto dev server: http://localhost:' + port + '/  (API: /exec, dev mode)'));
module.exports = { server, gas };
