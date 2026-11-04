'use strict';
/* E2E: モックGAS + web/ を Playwright で操作し、主要導線をスクリーンショット付きで確認する。 */
process.env.TZ = 'Asia/Tokyo';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const outDir = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const PORT = 8791;
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', '..', 'gas', 'test', 'server.js'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.once('data', r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const shots = [];
  const shot = async (name) => { const f = path.join(outDir, name + '.png'); await page.screenshot({ path: f }); shots.push(f); };
  const base = `http://localhost:${PORT}/`;
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#view-home') && !document.querySelector('#view-home').hidden);
    await page.waitForFunction(() => /同期済み|API未設定|オフライン/.test(document.querySelector('#home-sync').textContent));
    assert(await page.textContent('#home-sync') === '同期済み', 'bootstrap 同期');
    await shot('01-home-empty');

    // スキャン画面（ヘッドレスはカメラ無し → 写真/手入力モード）
    await page.click('#go-scan');
    await page.waitForFunction(() => !document.querySelector('#view-scan').hidden);
    await page.waitForTimeout(300);
    await shot('02-scan');

    // 未登録 JAN → 登録フォーム
    await page.fill('#jan-input', '4901234567894');
    await page.click('#jan-search');
    await page.waitForFunction(() => !document.querySelector('#view-register').hidden);
    assert(await page.inputValue('#f-jan') === '4901234567894', 'JAN 引き継ぎ');
    // OCR（モックの Claude 応答で自動入力、信頼度 62% → 黄色）
    const pngFile = path.join(__dirname, '..', '..', 'web', 'icons', 'icon-192.png');
    await page.setInputFiles('#ocr-file', pngFile);
    await page.waitForFunction(() => /項目を読み取りました/.test(document.querySelector('#ocr-status').textContent), null, { timeout: 15000 });
    assert(await page.inputValue('#f-energy_kcal') === '121', 'OCR 熱量');
    assert(await page.inputValue('#f-salt_g') === '1.19', 'OCR ナトリウム→食塩換算');
    assert(await page.inputValue('#f-name') === 'サラダチキン（OCR）', 'OCR 商品名');
    assert(await page.$eval('#f-energy_kcal', el => el.classList.contains('lowconf')), '低信頼度の強調');
    await shot('03-register-ocr');
    await page.click('#reg-save');
    await page.waitForFunction(() => !document.querySelector('#view-product').hidden);
    await page.waitForTimeout(200);
    assert((await page.textContent('#p-name')).includes('サラダチキン（OCR）'), '商品カード');
    await shot('04-product');

    // 半分を昼食で登録 → ホーム
    await page.click('#amount-chips .chip:nth-child(2)');
    await page.click('#meal-chips [data-meal="lunch"]');
    await page.click('#log-save');
    await page.waitForFunction(() => !document.querySelector('#view-home').hidden);
    await page.waitForFunction(() => document.querySelector('#home-sync').textContent === '同期済み' && !document.querySelector('#home-logs .item.pending'), null, { timeout: 10000 });
    const kcalText = await page.textContent('#home-summary .big');
    assert(/^61 /.test(kcalText.trim()), 'ホームの合計 61 kcal: ' + kcalText);
    await shot('05-home-one-log');

    // 既存商品（OFF ヒット）を JAN で照会 → 1個登録
    await page.click('#go-manual');
    await page.waitForFunction(() => !document.querySelector('#view-scan').hidden);
    await page.fill('#jan-input', '4902102072618');
    await page.click('#jan-search');
    await page.waitForFunction(() => !document.querySelector('#view-product').hidden, null, { timeout: 10000 });
    assert((await page.textContent('#p-name')).includes('Test Cola'), 'OFF 商品名');
    assert((await page.textContent('#p-name')).includes('Open Food Facts'), 'OFF タグ');
    await page.click('#amount-chips .chip:nth-child(1)');  // 1個（500ml）
    await page.click('#log-save');
    await page.waitForFunction(() => !document.querySelector('#view-home').hidden);
    await page.waitForFunction(() => !document.querySelector('#home-logs .item.pending'), null, { timeout: 10000 });
    const kcal2 = (await page.textContent('#home-summary .big')).trim();
    assert(/^286 /.test(kcal2), 'ホームの合計 286 kcal: ' + kcal2);
    await shot('06-home-two-logs');

    // 記録を選んで消去
    await page.click('#home-logs .item >> nth=0');
    await page.click('#home-logs [data-del]');
    await page.waitForFunction(() => document.querySelectorAll('#home-logs .item').length === 1);
    await page.waitForTimeout(500);

    // 最近の商品から再記録（スキャン無し）
    await page.click('#go-recent');
    await page.waitForFunction(() => !document.querySelector('#view-scan').hidden);
    assert((await page.$$('#recent-list .item')).length === 2, '最近の商品 2件');
    await page.click('#recent-list .item >> nth=0');
    await page.waitForFunction(() => !document.querySelector('#view-product').hidden);
    await page.click('#product-back');
    await page.waitForFunction(() => !document.querySelector('#view-scan').hidden);

    // 月次
    await page.click('.tab[data-view="month"]');
    await page.waitForFunction(() => /記録 1日/.test(document.querySelector('#month-summary').textContent), null, { timeout: 10000 });
    await shot('07-month');

    // 設定: プロフィール保存 → 目標が変わる
    await page.click('.tab[data-view="goal"]');
    await page.click('#sex-chips [data-v="m"]');
    await page.fill('#s-birth', '1986'); await page.fill('#s-height', '172'); await page.fill('#s-weight', '70');
    await page.click('#s-save');
    await page.waitForFunction(() => /2,760 kcal/.test(document.querySelector('#targets-table').textContent), null, { timeout: 10000 });
    await shot('08-settings');
    await page.click('.tab[data-view="home"]');
    await page.waitForFunction(() => /2,760 kcal/.test(document.querySelector('#home-summary').textContent));
    await shot('09-home-targets');

    // 商品情報の修正（登録者本人 → 反映）
    await page.click('#go-recent');
    await page.waitForFunction(() => !document.querySelector('#view-scan').hidden);
    await page.click('#recent-list .item >> nth=1');
    await page.waitForFunction(() => !document.querySelector('#view-product').hidden);
    await page.click('#p-edit');
    await page.waitForFunction(() => !document.querySelector('#view-register').hidden);
    assert(await page.textContent('#reg-title') === '商品情報を修正', '修正タイトル');
    await page.fill('#f-energy_kcal', '125');
    await page.click('#reg-save');
    await page.waitForFunction(() => !document.querySelector('#view-product').hidden);
    await page.waitForTimeout(300);
    assert((await page.textContent('#p-table')).includes('125 kcal'), '修正反映');

    // リロード後もキャッシュから即表示され、再同期される
    await page.goto(base + '#home', { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#home-sync').textContent === '同期済み');
    assert((await page.$$('#home-logs .item')).length === 1, 'リロード後の記録');

    // 退会
    await page.click('.tab[data-view="goal"]');
    await page.click('#del-all'); await page.click('#del-yes');
    await page.waitForFunction(() => !document.querySelector('#view-login').hidden || !document.querySelector('#view-home').hidden, null, { timeout: 10000 });
    await page.waitForTimeout(500);
    await shot('10-after-delete');

    console.log('E2E OK');
  } catch (e) {
    await shot('99-failure');
    console.error('E2E FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    if (errors.length) { console.log('browser errors:'); errors.forEach(e => console.log('  ' + e)); }
    await browser.close();
    srv.kill();
  }
  // 1枚にまとめる
  const sheetBrowser = await chromium.launch();
  const html = `<!doctype html><body style="margin:0;background:#888;display:flex;flex-wrap:wrap;gap:8px;padding:8px;width:${Math.min(shots.length, 5) * 398 + 8}px">${shots.map(s => `<img src="file://${s}" style="width:390px;height:844px;display:block">`).join('')}</body>`;
  const sheet = path.join(outDir, 'sheet.html'); fs.writeFileSync(sheet, html);
  const p = await sheetBrowser.newPage({ viewport: { width: Math.min(shots.length, 5) * 398 + 8, height: Math.ceil(shots.length / 5) * 852 + 8 } });
  await p.goto('file://' + sheet); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(outDir, 'sheet.png') });
  await sheetBrowser.close();
})();
