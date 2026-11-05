'use strict';
process.env.TZ = 'Asia/Tokyo';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas } = require('./mock-gas.js');

const JAN = '4901234567894';
const OFF_JAN = '4902102072618';
const offResponse = { status: 1, product: { product_name: 'Test Cola', brands: 'TestBrand', quantity: '500 ml', nutriments: { 'energy-kcal_100g': 45, proteins_100g: 0, fat_100g: 0, carbohydrates_100g: 11.3, sodium_100g: 0.01, sugars_100g: 11.3 } } };
function fetchMock(url) {
  if (url.includes('openfoodfacts.org')) return url.includes(OFF_JAN) ? { code: 200, body: offResponse } : { code: 404, body: { status: 0 } };
  if (url.includes('oauth2.googleapis.com/tokeninfo')) {
    const token = decodeURIComponent(url.split('id_token=')[1]);
    if (token === 'good') return { code: 200, body: { aud: 'client-123', iss: 'https://accounts.google.com', sub: '1122', email: 'taro@example.com', email_verified: 'true', name: 'Taro', exp: String(Math.floor(Date.now() / 1000) + 3600) } };
    if (token === 'good2') return { code: 200, body: { aud: 'client-123', iss: 'https://accounts.google.com', sub: '3344', email: 'hanako@example.com', email_verified: 'true', name: 'Hanako', exp: String(Math.floor(Date.now() / 1000) + 3600) } };
    if (token === 'wrongaud') return { code: 200, body: { aud: 'other', iss: 'https://accounts.google.com', sub: '1', exp: String(Math.floor(Date.now() / 1000) + 3600) } };
    return { code: 400, body: { error: 'invalid_token' } };
  }
  if (url.includes('api.anthropic.com')) {
    return { code: 200, body: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ basis: 'per_package', serving_g: 110, package_g: 110, name: 'サラダチキン', energy_kcal: 121, protein_g: 26, fat_g: 1.6, carb_g: 0.5, salt_g: null, sodium_mg: 470, sugar_g: null, fiber_g: null, satfat_g: 0.4, confidence: 0.9, notes: 'ナトリウム表記' }) }] } };
  }
  throw new Error('unexpected fetch ' + url);
}
const today = new Date();
const pad = n => (n < 10 ? '0' : '') + n;
const TODAY = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const d = new Date(today); d.setDate(d.getDate() - 1);
const YESTERDAY = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test('API 一連のシナリオ（devモード）', () => {
  const gas = createGas({ fetch: fetchMock });
  // health
  assert.equal(gas.get({ action: 'health' }).ok, true);
  assert.equal(gas.get({ action: 'nope' }).error.code, 'unknown_action');
  assert.equal(gas.get({ action: 'log.create' }).error.code, 'method_not_allowed');
  assert.equal(gas.postRaw('{bad').error.code, 'bad_request');
  assert.equal(gas.post({ action: 'logs.list', token: 'wrong' }).error.code, 'unauthorized');

  // product.get: 未登録 → null / 外部照会で OFF ヒット → マスタ保存
  assert.deepEqual(gas.get({ action: 'product.get', jan: JAN }).data, { product: null, found: null });
  assert.equal(gas.get({ action: 'product.get', jan: '123' }).error.code, 'validation');
  const off = gas.get({ action: 'product.get', jan: OFF_JAN, external: '1' }).data;
  assert.equal(off.found, 'off'); assert.equal(off.product.source, 'off'); assert.equal(off.product.serving_basis, 'per_100g');
  assert.equal(off.product.package_g, 500); assert.equal(off.product.salt_g, 0.03); assert.equal(off.product.sugar_g, 11.3);
  assert.equal(gas.get({ action: 'product.get', jan: OFF_JAN }).data.found, 'master');
  // 未登録で OFF にも無い → null（hint は YAHOO_CLIENT_ID が無いので無し）
  assert.equal(gas.get({ action: 'product.get', jan: '4901234567894', external: '1' }).data.product, null);

  // product.create
  const bad = gas.call('product.create', { jan: JAN, serving_basis: 'per_package', energy_kcal: 121 });
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'validation'); assert.equal(bad.error.details.field, 'name');
  const created = gas.call('product.create', { jan: JAN, name: 'サラダチキン', serving_basis: 'per_package', package_g: 110, energy_kcal: 121, protein_g: 26, fat_g: 1.6, carb_g: 0.5, sodium_mg: 470, source: 'ocr' });
  assert.equal(created.ok, true, JSON.stringify(created)); assert.equal(created.data.created, true);
  const product = created.data.product;
  assert.equal(product.salt_g, 1.19); assert.equal(product.serving_g, 110); assert.equal(product.source, 'ocr'); assert.equal(product.verified, false);
  const again = gas.call('product.create', { jan: JAN, name: '別名', serving_basis: 'per_100g', energy_kcal: 1 });
  assert.equal(again.data.created, false); assert.equal(again.data.product.id, product.id);
  // シートの自動型変換を受けても jan / 日付は文字列で読める
  assert.equal(typeof gas.sheet('products').rows[1][1], 'number', 'モックは jan を数値化している');
  assert.equal(gas.get({ action: 'product.get', jan: JAN }).data.product.jan, JAN);

  // log.create
  const c1 = gas.call('log.create', { client_id: 'c1', product_id: product.id, date: TODAY, time: '12:30', meal_type: 'lunch', amount_mode: 'package', amount: 1 });
  assert.equal(c1.ok, true, JSON.stringify(c1));
  assert.equal(c1.data.log.energy_kcal, 121); assert.equal(c1.data.log.amount_label, '1個'); assert.equal(c1.data.log.time, '12:30');
  assert.equal(c1.data.daily_summary.totals.count, 1); assert.equal(c1.data.daily_summary.totals.energy_kcal, 121);
  assert.equal(c1.data.daily_summary.verdict.energy_kcal.s, 'left');
  const dup = gas.call('log.create', { client_id: 'c1', product_id: product.id, date: TODAY, amount_mode: 'package', amount: 3 });
  assert.equal(dup.data.duplicate, true); assert.equal(dup.data.log.id, c1.data.log.id);
  assert.equal(gas.sheet('food_logs').getLastRow(), 2, '重複登録されていない');
  const c2 = gas.call('log.create', { client_id: 'c2', product_id: product.id, date: TODAY, time: '19:00', amount_mode: 'grams', amount: 55 });
  assert.equal(c2.data.log.energy_kcal, 61); assert.equal(c2.data.log.meal_type, 'dinner'); assert.equal(c2.data.log.amount_label, '55g');
  assert.equal(c2.data.daily_summary.totals.count, 2);
  const c3 = gas.call('log.create', { client_id: 'c3', product_id: off.product.id, date: YESTERDAY, time: '08:00', amount_mode: 'package', amount: 1 });
  assert.equal(c3.data.log.energy_kcal, 225); assert.equal(c3.data.log.date, YESTERDAY);
  const badMode = gas.call('log.create', { client_id: 'c4', product_id: off.product.id, date: TODAY, amount_mode: 'serving', amount: 1 });
  assert.equal(badMode.error.code, 'validation');
  assert.equal(gas.call('log.create', { client_id: 'c5', product_id: 'nope', date: TODAY, amount_mode: 'package', amount: 1 }).error.code, 'not_found');
  assert.equal(gas.call('log.create', { client_id: 'c6', product_id: product.id, date: '2026-13-01', amount_mode: 'package', amount: 1 }).error.code, 'validation');

  // logs.list / summary.daily / summary.monthly
  const list = gas.call('logs.list', { from: YESTERDAY, to: TODAY }).data.logs;
  assert.equal(list.length, 3); assert.equal(list[0].date, YESTERDAY);
  assert.equal(typeof gas.sheet('food_logs').rows[1][5], 'object', 'モックは date を Date 化している');
  const daily = gas.call('summary.daily', { date: TODAY }).data.daily_summary;
  assert.equal(daily.totals.energy_kcal, 182); assert.equal(daily.totals.count, 2); assert.equal(daily.overall.s, 'left');
  const month = gas.call('summary.monthly', { month: TODAY.slice(0, 7) }).data;
  assert.equal(month.days.length >= 28, true);
  const recordedToday = month.days.find(x => x.date === TODAY);
  assert.equal(recordedToday.totals.count, 2);
  assert.equal(month.recorded_days, YESTERDAY.slice(0, 7) === TODAY.slice(0, 7) ? 2 : 1);

  // log.update: 量と日付を変える → 両日のサマリが更新される
  const upd = gas.call('log.update', { id: c2.data.log.id, amount: 110, date: YESTERDAY });
  assert.equal(upd.ok, true, JSON.stringify(upd)); assert.equal(upd.data.log.energy_kcal, 121); assert.equal(upd.data.log.date, YESTERDAY);
  assert.equal(gas.call('summary.daily', { date: TODAY }).data.daily_summary.totals.count, 1);
  assert.equal(gas.call('summary.daily', { date: YESTERDAY }).data.daily_summary.totals.energy_kcal, 346);
  // log.delete
  const del = gas.call('log.delete', { id: c2.data.log.id });
  assert.equal(del.data.daily_summary.totals.count, 1);
  assert.equal(gas.call('log.delete', { id: c2.data.log.id }).error.code, 'not_found');
  assert.equal(gas.call('logs.list', { from: YESTERDAY, to: TODAY }).data.logs.length, 2);

  // profile
  assert.equal(gas.call('profile.get').data.targets.hasProfile, false);
  const prof = gas.call('profile.update', { sex: 'm', birth_year: 1986, weight_kg: 70, height_cm: 172, activity_level: 'normal' });
  assert.equal(prof.ok, true, JSON.stringify(prof)); assert.equal(prof.data.targets.kcal, 2760); assert.equal(prof.data.profile.sex, 'm');
  assert.equal(gas.call('profile.update', { target_mode: 'manual' }).error.code, 'validation');
  const prof2 = gas.call('profile.update', { sex: 'f', birth_year: 1990, weight_kg: 52, htn: true, target_mode: 'manual', target_kcal: 1800 });
  assert.equal(prof2.data.targets.kcal, 1800); assert.equal(prof2.data.targets.salt, 6.0); assert.equal(prof2.data.profile.htn, true);
  assert.equal(gas.sheet('user_profiles').getLastRow(), 2, 'プロフィールは upsert');
  assert.equal(gas.call('summary.daily', { date: TODAY }).data.targets.kcal, 1800);

  // products.recent / sync.bootstrap
  const recent = gas.call('products.recent').data.products;
  assert.equal(recent.length, 2); assert.equal(recent[0].id, off.product.id, '最後に記録した商品が先頭'); assert.equal(recent[1].id, product.id);
  const boot = gas.call('sync.bootstrap', { days: 7 }).data;
  assert.equal(boot.logs.length, 2); assert.equal(boot.products.length, 2); assert.equal(boot.profile.sex, 'f'); assert.equal(boot.today, TODAY);
  assert.equal(boot.user.email, 'dev@example.com');

  // product.update: 登録者本人 → 反映、別ユーザー → 修正提案
  const u1 = gas.call('product.update', { id: product.id, name: 'サラダチキン プレーン', serving_basis: 'per_package', package_g: 110, energy_kcal: 125, protein_g: 26, fat_g: 1.6, carb_g: 0.5, salt_g: 1.2 });
  assert.equal(u1.ok, true, JSON.stringify(u1)); assert.equal(u1.data.applied, true); assert.equal(u1.data.product.energy_kcal, 125); assert.equal(u1.data.product.jan, JAN);
  gas.state.props.DEV_USER_ID = 'other-user';
  const u2 = gas.call('product.update', { id: product.id, name: 'いたずら', serving_basis: 'per_package', energy_kcal: 1 });
  assert.equal(u2.data.applied, false); assert.ok(u2.data.suggestion_id);
  assert.equal(gas.sheet('product_suggestions').getLastRow(), 2);
  assert.equal(gas.call('product.update', { id: product.id, name: 'x', serving_basis: 'per_package', energy_kcal: 1 }).data.product.name, 'サラダチキン プレーン');
  assert.equal(gas.call('logs.list', { from: YESTERDAY, to: TODAY }).data.logs.length, 0, '他ユーザーの記録は見えない');
  gas.state.props.DEV_USER_ID = 'dev-user';

  // 夜間の全件再計算
  assert.equal(gas.run('recomputeAllSummaries') >= 2, true);
  assert.equal(gas.call('summary.daily', { date: YESTERDAY }).data.daily_summary.totals.energy_kcal, 225);

  // ocr.parse（Claude をモック）: ナトリウム → 食塩相当量に換算
  gas.state.props.CLAUDE_API_KEY = 'sk-test';
  const ocr = gas.call('ocr.parse', { image_base64: 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64'), media_type: 'image/jpeg' });
  assert.equal(ocr.ok, true, JSON.stringify(ocr));
  assert.equal(ocr.data.result.salt_g, 1.19); assert.equal(ocr.data.result.basis, 'per_package'); assert.equal(ocr.data.result.filled, 5); assert.equal(ocr.data.provider, 'claude');
  const req = gas.state.fetchCalls.find(c => c.url.includes('api.anthropic.com'));
  const body = JSON.parse(req.opts.payload);
  assert.equal(body.model, 'claude-opus-5-5'); assert.equal(body.fallbacks, 'default'); assert.equal(body.output_config.format.type, 'json_schema'); assert.equal(body.output_config.effort, 'low');
  assert.equal(body.messages[0].content[0].type, 'image'); assert.equal(body.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.equal(req.opts.headers['anthropic-version'], '2026-10-21'); assert.equal(req.opts.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(gas.call('ocr.parse', { image_base64: '' }).error.code, 'validation');

  // account.delete
  assert.equal(gas.call('account.delete', {}).error.code, 'validation');
  const delAcc = gas.call('account.delete', { confirm: 'DELETE' });
  assert.equal(delAcc.ok, true, JSON.stringify(delAcc)); assert.equal(delAcc.data.deleted.logs, 3); assert.equal(delAcc.data.deleted.user, 1); assert.equal(delAcc.data.deleted.profile, 1);
  assert.equal(gas.call('logs.list', { from: YESTERDAY, to: TODAY }).data.logs.length, 0);
  assert.equal(gas.sheet('products').getLastRow(), 3, '共有の商品マスタは残る');
  // 再ログインでユーザー行が復活する
  assert.equal(gas.call('profile.get').ok, true);
  assert.equal(gas.sheet('users').getLastRow(), 3);
});

test('Google ID トークン検証（tokeninfo をモック）', () => {
  const gas = createGas({ fetch: fetchMock, properties: { AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'client-123', ALLOWED_DOMAINS: 'example.com' } });
  assert.equal(gas.post({ action: 'profile.get' }).error.code, 'unauthorized');
  assert.equal(gas.post({ action: 'profile.get', token: 'wrongaud' }).error.code, 'unauthorized');
  assert.equal(gas.post({ action: 'profile.get', token: 'expired' }).error.code, 'unauthorized');
  const ok = gas.post({ action: 'profile.get', token: 'good' });
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.data.user.email, 'taro@example.com');
  const calls = gas.state.fetchCalls.filter(c => c.url.includes('tokeninfo')).length;
  gas.post({ action: 'profile.get', token: 'good' });
  assert.equal(gas.state.fetchCalls.filter(c => c.url.includes('tokeninfo')).length, calls, '2回目はキャッシュ');
  assert.equal(gas.sheet('users').rows[1][0], 1122, 'users.id = sub');
  gas.state.props.ALLOWED_DOMAINS = 'other.co.jp';
  const gas2 = createGas({ fetch: fetchMock, properties: { AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'client-123', ALLOWED_EMAILS: 'someone@else.com' } });
  assert.equal(gas2.post({ action: 'profile.get', token: 'good' }).error.code, 'forbidden');
});

test('OCR: refusal / 不正JSON / Gemini 切替', () => {
  let mode = 'refusal';
  const gas = createGas({ properties: { CLAUDE_API_KEY: 'k', GEMINI_API_KEY: 'g' }, fetch: (url) => {
    if (url.includes('anthropic')) {
      if (mode === 'refusal') return { code: 200, body: { stop_reason: 'refusal', content: [] } };
      if (mode === 'junk') return { code: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] } };
      return { code: 500, body: 'oops' };
    }
    if (url.includes('generativelanguage')) return { code: 200, body: { candidates: [{ content: { parts: [{ text: '```json\n{"basis":"per_100g","energy_kcal":62,"protein_g":3.6,"fat_g":3,"carb_g":4.9,"salt_g":0.1,"confidence":0.8,"notes":""}\n```' }] } }] } };
    throw new Error('unexpected ' + url);
  } });
  const img = { image_base64: Buffer.from('img').toString('base64') };
  assert.equal(gas.call('ocr.parse', img).error.code, 'ocr_refused');
  mode = 'junk'; assert.equal(gas.call('ocr.parse', img).error.code, 'ocr_failed');
  mode = '500'; assert.equal(gas.call('ocr.parse', img).error.code, 'upstream');
  gas.state.props.OCR_PROVIDER = 'gemini';
  const g = gas.call('ocr.parse', img);
  assert.equal(g.ok, true, JSON.stringify(g)); assert.equal(g.data.provider, 'gemini'); assert.equal(g.data.result.energy_kcal, 62); assert.equal(g.data.result.serving_g, null);
});

test('ウェブ照会（Claude web_search をモック）: 自動保存 / 要確認ヒント / キャッシュ / pause_turn', () => {
  const WEB_JAN = '4902105001011';
  const LOW_JAN = '4901777298088';
  let lookups = 0, pauses = 0;
  const webJson = { found: true, name: 'カップヌードル', brand: '日清食品', quantity_text: '78g', basis: 'per_package', serving_g: 78, package_g: 78, energy_kcal: 351, protein_g: 10.5, fat_g: 14.6, carb_g: 44.5, salt_g: 4.9, sodium_mg: null, sugar_g: null, fiber_g: null, satfat_g: null, confidence: 0.9, source_url: 'https://www.nissin.com/jp/products/items/1', notes: '公式サイトの栄養成分表示' };
  const lowJson = Object.assign({}, webJson, { name: 'どこかのクッキー', confidence: 0.4, salt_g: null, sodium_mg: 120, source_url: 'https://shop.example.com/item' });
  const gas = createGas({ properties: { CLAUDE_API_KEY: 'sk-test' }, fetch: (url, opts) => {
    if (url.includes('openfoodfacts.org')) return { code: 404, body: { status: 0 } };
    if (url.includes('api.anthropic.com')) {
      const body = JSON.parse(opts.payload);
      assert.ok(Array.isArray(body.tools) && body.tools.some(t => t.name === 'web_search'), 'web_search ツールを渡す');
      assert.equal(body.output_config, undefined, '引用付きの web_search と JSON schema は併用しない');
      lookups++;
      const jan = body.messages[0].content.match(/\d{13}/)[0];
      if (jan === WEB_JAN && body.messages.length === 1) { pauses++; return { code: 200, body: { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: jan } }] } }; }
      const j = jan === LOW_JAN ? lowJson : webJson;
      return { code: 200, body: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [
        { type: 'text', text: '調べました。' },
        { type: 'text', text: '```json\n' + JSON.stringify(j) + '\n```', citations: [{ type: 'web_search_result_location', url: j.source_url }] }
      ] } };
    }
    throw new Error('unexpected fetch ' + url);
  } });
  // 5 項目そろって確からしい → source=web で保存
  assert.deepEqual(gas.get({ action: 'product.get', jan: WEB_JAN, external: '1' }).data, { product: null, found: null, hint: null }, '匿名の GET では有料照会しない');
  assert.equal(lookups, 0);
  const r = gas.call('product.get', { jan: WEB_JAN, external: '1' }).data;
  assert.equal(r.found, 'web', JSON.stringify(r)); assert.equal(r.product.source, 'web'); assert.equal(r.product.name, 'カップヌードル');
  assert.equal(r.product.serving_basis, 'per_package'); assert.equal(r.product.serving_g, 78); assert.equal(r.product.salt_g, 4.9); assert.equal(r.product.verified, false);
  assert.equal(r.lookup.source_url, webJson.source_url); assert.equal(r.lookup.confidence, 0.9);
  assert.equal(pauses, 1, 'pause_turn を 1 回継続した'); assert.equal(lookups, 2);
  assert.equal(gas.get({ action: 'product.get', jan: WEB_JAN }).data.found, 'master');
  // 信頼度が低い → 保存せず hint（フォーム初期値）。ナトリウムは食塩相当量に換算
  const low = gas.call('product.get', { jan: LOW_JAN, external: '1' }).data;
  assert.equal(low.product, null); assert.equal(low.hint.provider, 'web'); assert.equal(low.hint.name, 'どこかのクッキー');
  assert.equal(low.hint.filled, 5); assert.equal(low.hint.salt_g, 0.3); assert.equal(low.hint.confidence, 0.4); assert.equal(low.hint.source_url, lowJson.source_url);
  const before = lookups;
  assert.equal(gas.call('product.get', { jan: LOW_JAN, external: '1' }).data.hint.name, 'どこかのクッキー');
  assert.equal(lookups, before, '2 回目はキャッシュ');
  // 自動保存を止める設定
  gas.state.props.WEB_LOOKUP_AUTOSAVE = '0';
  gas.state.cache.clear();
  const noSave = gas.call('product.get', { jan: '4901234567894', external: '1' }).data;
  assert.equal(noSave.product, null); assert.equal(noSave.hint.energy_kcal, 351);
  // hint から登録するとき source=web を受け付ける
  const created = gas.call('product.create', { jan: '4901234567894', name: 'カップヌードル', serving_basis: 'per_package', package_g: 78, energy_kcal: 351, protein_g: 10.5, fat_g: 14.6, carb_g: 44.5, salt_g: 4.9, source: 'web' });
  assert.equal(created.ok, true, JSON.stringify(created)); assert.equal(created.data.product.source, 'web');
  // 無効化 / キー無し / API エラーでは照会しない・落ちない
  gas.state.props.WEB_LOOKUP = '0'; gas.state.cache.clear();
  const off = gas.call('product.get', { jan: '4902102072618', external: '1' }).data;
  assert.equal(off.product, null); assert.equal(off.hint, null);
  delete gas.state.props.WEB_LOOKUP;
  const gas2 = createGas({ properties: { CLAUDE_API_KEY: 'bad', DEBUG: '1' }, fetch: (url) => url.includes('anthropic') ? { code: 401, body: { error: { message: 'invalid x-api-key' } } } : { code: 404, body: { status: 0 } } });
  const err = gas2.call('product.get', { jan: WEB_JAN, external: '1' }).data;
  assert.equal(gas2.state.props.WEB_LOOKUP_COUNT.split(':')[1], '1', '照会回数を記録');
  assert.equal(err.product, null); assert.equal(err.hint, null); assert.match(err.lookup_error, /401/);
  // 1 日の上限
  gas2.state.props.WEB_LOOKUP_DAILY_LIMIT = '1';
  const capped = gas2.call('product.get', { jan: LOW_JAN, external: '1' }).data;
  assert.match(capped.lookup_error, /上限/);
});

test('手料理・一般食品: setupFoods / products.search / 記録', () => {
  const gas = createGas({ fetch: () => { throw new Error('no network'); } });
  const r = gas.run('setupFoods');
  assert.equal(r.inserted, r.total); assert.equal(r.updated, 0); assert.ok(r.total >= 70);
  const again = gas.run('setupFoods');
  assert.equal(again.inserted, 0); assert.equal(again.updated, r.total, '2 回目は更新だけ');
  assert.equal(gas.sheet('products').getLastRow(), r.total + 1);
  // ご飯 茶碗1杯 150g = 八訂 01088 の 1.5 倍
  const gohan = gas.call('products.search', { q: 'ごはん' }).data;
  assert.ok(gohan.products.length >= 1, JSON.stringify(gohan));
  const g = gohan.products.find(p => p.name === 'ご飯（白米）');
  assert.ok(g); assert.equal(g.source, 'food'); assert.equal(g.serving_basis, 'per_serving'); assert.equal(g.serving_g, 150);
  assert.equal(g.energy_kcal, 234); assert.equal(g.protein_g, 3.8); assert.equal(g.fat_g, 0.5); assert.equal(g.carb_g, 55.7); assert.equal(g.salt_g, 0); assert.equal(g.jan, 'food:gohan');
  // 読み・カタカナ・別名で引ける（カタカナ → ひらがな）
  assert.ok(gas.call('products.search', { q: 'ライス' }).data.products.some(p => p.jan === 'food:gohan'));
  assert.ok(gas.call('products.search', { q: '味噌汁' }).data.products.some(p => p.jan === 'food:misoshiru'));
  assert.ok(gas.call('products.search', { q: 'チキン' }).data.products.some(p => p.jan === 'food:tori_mune'));
  assert.equal(gas.call('products.search', { q: '' }).error.code, 'validation');
  // みそ汁（豆腐・わかめ）はレシピ合算: みそ12 + 木綿豆腐30 + わかめ1 + だし150
  const miso = gas.call('products.search', { q: 'みそしる' }).data.products.find(p => p.jan === 'food:misoshiru');
  assert.equal(miso.energy_kcal, 48); assert.equal(miso.salt_g, 1.8); assert.equal(miso.protein_g, 4.2);
  // 記録: 1食 / 半分 / 100g
  const c1 = gas.call('log.create', { client_id: 'f1', product_id: g.id, date: TODAY, time: '07:30', meal_type: 'breakfast', amount_mode: 'serving', amount: 1 });
  assert.equal(c1.ok, true, JSON.stringify(c1)); assert.equal(c1.data.log.energy_kcal, 234); assert.equal(c1.data.log.amount_label, '1食');
  const c2 = gas.call('log.create', { client_id: 'f2', product_id: g.id, date: TODAY, time: '12:30', amount_mode: 'grams', amount: 200 });
  assert.equal(c2.data.log.energy_kcal, 312);
  // 修正は管理者のみ（本人作成ではないので一般ユーザーは修正提案になる）。food: の jan は検証を通る
  const u = gas.call('product.update', { id: g.id, name: 'ご飯（白米）', serving_basis: 'per_serving', serving_g: 160, energy_kcal: 250 });
  assert.equal(u.ok, true, JSON.stringify(u)); assert.equal(u.data.applied, false);
  gas.state.props.ADMIN_EMAILS = 'dev@example.com';
  const u2 = gas.call('product.update', { id: g.id, name: 'ご飯（白米）', serving_basis: 'per_serving', serving_g: 160, energy_kcal: 250 });
  assert.equal(u2.data.applied, true); assert.equal(u2.data.product.serving_g, 160);
  // setupFoods を再実行すると標準値に戻る
  gas.run('setupFoods');
  assert.equal(gas.call('products.search', { q: 'ごはん' }).data.products.find(p => p.jan === 'food:gohan').serving_g, 150);
  // 疑似 JAN は product.create では作れない（setupFoods 専用）
  assert.equal(gas.call('product.create', { jan: 'food:evil', name: 'x', serving_basis: 'per_serving', serving_g: 1, energy_kcal: 1 }).error.code, 'validation');
  // 空白入りの検索語、液体は ml 表記
  assert.ok(gas.call('products.search', { q: 'みそ 汁' }).data.products.some(p => p.jan === 'food:misoshiru'));
  const milk = gas.call('products.search', { q: '牛乳' }).data.products.find(p => p.jan === 'food:milk');
  assert.equal(milk.quantity_text, 'コップ1杯（200ml）'); assert.equal(gas.call('log.create', { client_id: 'f3', product_id: milk.id, date: TODAY, amount_mode: 'grams', amount: 100 }).data.log.amount_label, '100ml');
  // バーコード照会は food: の行に影響しない
  assert.equal(gas.get({ action: 'product.get', jan: '4901234567894' }).data.product, null);
  const check = gas.run('selfCheck');
  assert.equal(check.ok, true); assert.equal(check.foods_registered, r.total);
});

test('バーコードの無い商品の手入力登録（custom:）: 採番 / 本人だけに検索表示 / 記録', () => {
  const gas = createGas({ fetch: fetchMock });
  // クライアントは custom:new で送る → サーバが custom:<32hex> を振り、常に新規行
  const c1 = gas.call('product.create', { jan: 'custom:new', name: 'パン屋のクロワッサン', serving_basis: 'per_package', serving_g: 45, energy_kcal: 200, protein_g: 4, fat_g: 11, carb_g: 21, salt_g: 0.5, source: 'web' });
  assert.equal(c1.ok, true, JSON.stringify(c1)); assert.equal(c1.data.created, true);
  assert.match(c1.data.product.jan, /^custom:[0-9a-f]{32}$/); assert.equal(c1.data.product.source, 'manual', 'custom では web を名乗れない');
  const c2 = gas.call('product.create', { jan: 'custom:new', name: 'パン屋のクロワッサン', serving_basis: 'per_package', serving_g: 45, energy_kcal: 200 });
  assert.equal(c2.data.created, true); assert.notEqual(c2.data.product.jan, c1.data.product.jan, '同名でも別行（JAN での重複判定はしない）');
  assert.equal(gas.call('product.create', { jan: 'custom:Bad id!', name: 'x', serving_basis: 'per_serving', energy_kcal: 1 }).error.code, 'validation');
  assert.equal(gas.call('product.create', { jan: 'custom:new', name: '定食', serving_basis: 'per_serving', energy_kcal: 1, source: 'ocr' }).data.product.source, 'ocr');
  // 熱量だけでも登録でき、1食単位で記録できる
  const c3 = gas.call('product.create', { jan: 'custom:new', name: 'お店のカレー', serving_basis: 'per_serving', energy_kcal: 850 });
  assert.equal(c3.data.product.protein_g, 0);
  const lg = gas.call('log.create', { client_id: 'c1', product_id: c3.data.product.id, date: TODAY, amount_mode: 'serving', amount: 1 });
  assert.equal(lg.ok, true, JSON.stringify(lg)); assert.equal(lg.data.log.energy_kcal, 850); assert.equal(lg.data.log.amount_label, '1食');
  // 検索・最近の商品に出る。product.get（バーコード照会）では引けない
  assert.ok(gas.call('products.search', { q: 'くろわっさん' }).data.products.some(p => p.jan === c1.data.product.jan));
  assert.ok(gas.call('products.recent', {}).data.products.some(p => p.jan === c3.data.product.jan));
  assert.equal(gas.get({ action: 'product.get', jan: c1.data.product.jan }).error.code, 'validation');
  // 本人の修正はその場で反映、jan は変わらない
  const up = gas.call('product.update', { id: c1.data.product.id, jan: '4901234567894', name: 'クロワッサン（大）', serving_basis: 'per_package', serving_g: 60, energy_kcal: 260 });
  assert.equal(up.data.applied, true); assert.equal(up.data.product.jan, c1.data.product.jan); assert.equal(up.data.product.name, 'クロワッサン（大）');
  // 他人の手入力商品は検索に出ない（Google 認証で 2 ユーザー）
  const g2 = createGas({ fetch: fetchMock, properties: { AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'client-123', ALLOWED_DOMAINS: 'example.com' } });
  const mine = g2.call('product.create', { jan: 'custom:new', name: '社食のラーメン', serving_basis: 'per_serving', energy_kcal: 600 }, 'good');
  assert.equal(mine.ok, true, JSON.stringify(mine));
  assert.equal(g2.call('products.search', { q: 'らーめん' }, 'good').data.products.length, 1);
  assert.equal(g2.call('products.search', { q: 'らーめん' }, 'good2').data.products.length, 0);
  assert.equal(g2.call('products.recent', {}, 'good2').data.products.length, 0);
});
