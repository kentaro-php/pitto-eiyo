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
