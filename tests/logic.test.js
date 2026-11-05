'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../shared/logic.js');

test('computeTargets: 男性40歳70kg ふつう', () => {
  const T = L.computeTargets({ sex: 'm', birth_year: 1986, weight_kg: 70, activity_level: 'normal' }, 2026);
  assert.equal(T.kcal, 2760);            // 22.5*70=1575 → ×1.75=2756.25 → 10kcal丸め
  assert.deepEqual(T.p, [90, 138]);      // 13〜20%
  assert.deepEqual(T.f, [61, 92]);       // 20〜30%
  assert.deepEqual(T.c, [345, 449]);     // 50〜65%
  assert.equal(T.salt, 7.5);
  assert.equal(T.hasProfile, true);
  assert.equal(T.bmr, 1575);
});
test('computeTargets: 女性・高血圧・手動・プロフィール無し', () => {
  assert.equal(L.computeTargets({ sex: 'f', birth_year: 1990, weight_kg: 52 }, 2026).salt, 6.5);
  assert.equal(L.computeTargets({ sex: 'f', birth_year: 1990, weight_kg: 52, htn: true }, 2026).salt, 6.0);
  const M = L.computeTargets({ target_mode: 'manual', target_kcal: 1800 }, 2026);
  assert.equal(M.kcal, 1800); assert.equal(M.auto, false); assert.equal(M.hasProfile, true);
  const N = L.computeTargets({}, 2026);
  assert.equal(N.kcal, 2200); assert.equal(N.hasProfile, false);
  const A = L.computeTargets({ sex: 'm', birth_year: 1986, weight_kg: 70, activity_level: 'normal', kcal_adjust: -300 }, 2026);
  assert.equal(A.kcal, 2460);
  const S = L.computeTargets({ sex: 'm', birth_year: 1960, weight_kg: 70 }, 2026); // 66歳 → PAL 1.70, P下限15%
  assert.equal(S.kcal, Math.round(21.6 * 70 * 1.70 / 10) * 10);
  assert.equal(S.p[0], Math.round(S.kcal * 0.15 / 4));
});

test('judge / summarize / overall', () => {
  const T = L.computeTargets({ target_mode: 'manual', target_kcal: 2000 }, 2026);
  const tot = { energy_kcal: 2320, protein_g: 70, fat_g: 40, carb_g: 300, salt_g: 8.7, count: 3 };
  const j = L.judge(tot, T, false);
  assert.equal(j.energy_kcal.s, 'over'); assert.equal(j.energy_kcal.t, '+320 kcal');
  assert.equal(j.protein_g.s, 'ok'); assert.equal(j.fat_g.s, 'short'); assert.equal(j.carb_g.s, 'ok');
  assert.equal(j.salt_g.s, 'over'); assert.equal(j.salt_g.t, '+1.2 g');
  assert.equal(L.summarize(j, tot, false), 'カロリーオーバー +320 kcal、食塩オーバー +1.2 g、ほか1項目。2項目はOK。');
  assert.equal(L.overall(j, tot, false).s, 'over');
  const jt = L.judge({ energy_kcal: 500, protein_g: 20, fat_g: 10, carb_g: 60, salt_g: 1 }, T, true);
  assert.equal(jt.energy_kcal.s, 'left'); assert.equal(jt.energy_kcal.t, 'あと 1,500 kcal');
  assert.equal(L.summarize({}, { count: 0 }, true), 'まだ記録がありません。バーコードを読んで記録しましょう。');
  const allOk = L.judge({ energy_kcal: 2000, protein_g: 80, fat_g: 55, carb_g: 280, salt_g: 5 }, T, false);
  assert.equal(L.allOk(allOk), true);
  assert.equal(L.summarize(allOk, { count: 2 }, false), 'すべて目標の範囲内です。');
});

test('EAN 検証', () => {
  assert.equal(L.eanValid('4901234567894'), true);
  assert.equal(L.eanValid('4902102072618'), true);
  assert.equal(L.eanValid('4901234567895'), false);
  assert.equal(L.eanValid('12345678'), false);
  assert.equal(L.eanValid('96385074'), true);  // EAN-8
  assert.equal(L.normJan('490123456789'), '0490123456789');
  assert.equal(L.normJan(' 4901-2345-67894 '), '4901234567894');
  assert.equal(L.eanCheckDigit('490123456789'), '4');
});

test('factorFor / availableModes / scaleN / amountLabel', () => {
  const p100 = { serving_basis: 'per_100g', package_g: 400, quantity_text: '400g' };
  assert.equal(L.factorFor(p100, 'grams', 150), 1.5);
  assert.equal(L.factorFor(p100, 'package', 1), 4);
  assert.equal(L.factorFor(p100, 'serving', 1), null);
  assert.deepEqual(L.availableModes(p100), ['package', 'grams']);
  const pkg = { serving_basis: 'per_package', serving_g: 110 };
  assert.equal(L.factorFor(pkg, 'package', 0.5), 0.5);
  assert.equal(L.factorFor(pkg, 'grams', 55), 0.5);
  const pkgNoG = { serving_basis: 'per_package' };
  assert.deepEqual(L.availableModes(pkgNoG), ['package', 'serving']);
  const srv = { serving_basis: 'per_serving', serving_g: 77, package_g: 154 };
  assert.equal(L.factorFor(srv, 'package', 1), 2);
  assert.equal(L.factorFor(srv, 'grams', 38.5), 0.5);
  assert.equal(L.factorFor(srv, 'serving', 0), null);
  const n = L.scaleN({ energy_kcal: 62, protein_g: 3.6, fat_g: 3.0, carb_g: 4.9, salt_g: 0.1, fiber_g: '' }, 1.5);
  assert.deepEqual(n, { energy_kcal: 93, protein_g: 5.4, fat_g: 4.5, carb_g: 7.4, salt_g: 0.2 });
  assert.equal(L.amountLabel(pkg, 'package', 0.5), '半分');
  assert.equal(L.amountLabel({ quantity_text: '200ml' }, 'grams', 200), '200ml');
  assert.equal(L.amountLabel(srv, 'serving', 1), '1食');
  assert.equal(L.sodiumToSalt(400), 1.02);
  assert.deepEqual(L.defaultAmount(p100), { mode: 'grams', amount: 100 });
});

test('totals / 日付', () => {
  const t = L.totals([{ energy_kcal: 180, protein_g: 4.5, fat_g: 1.5, carb_g: 37, salt_g: 1.0 }, { energy_kcal: 62.4, protein_g: 3.6, fat_g: 3, carb_g: 4.9, salt_g: 0.1 }]);
  assert.deepEqual(t, { energy_kcal: 242, protein_g: 8.1, fat_g: 4.5, carb_g: 41.9, salt_g: 1.1, count: 2 });
  assert.equal(L.isValidDate('2026-02-29'), false);
  assert.equal(L.isValidDate('2026-11-04'), true);
  assert.equal(L.addDays('2026-11-04', -4), '2026-10-31');
  assert.equal(L.addMonths('2026-01', -1), '2025-12');
  assert.equal(L.daysInMonth('2026-02'), 28);
  assert.equal(L.isValidTime('23:59'), true); assert.equal(L.isValidTime('24:00'), false);
  assert.equal(L.fmtDateJP('2026-11-04'), '11月4日（水）');
});

test('normalizeProduct / normalizeProfile', () => {
  const p = L.normalizeProduct({ jan: '4901234567894', name: ' サラダチキン ', serving_basis: 'per_package', package_g: '110', energy_kcal: '121', protein_g: 26, fat_g: '1.6', carb_g: 0.5, sodium_mg: 470, fiber_g: '' });
  assert.equal(p.name, 'サラダチキン'); assert.equal(p.serving_g, 110); assert.equal(p.salt_g, 1.19); assert.equal('fiber_g' in p, false);
  assert.throws(() => L.normalizeProduct({ jan: '4901234567894', name: '', serving_basis: 'per_package', energy_kcal: 1 }), /商品名/);
  assert.throws(() => L.normalizeProduct({ jan: '123', name: 'x', serving_basis: 'per_package', energy_kcal: 1 }), /JAN/);
  assert.throws(() => L.normalizeProduct({ jan: '4901234567894', name: 'x', serving_basis: 'per_package', energy_kcal: 100, protein_g: -5 }), /負の値/);
  assert.throws(() => L.normalizeProduct({ jan: '4901234567894', name: 'x', serving_basis: 'per_package', energy_kcal: -5 }), /熱量/);
  const pr = L.normalizeProfile({ sex: 'm', birth_year: '1986', weight_kg: '70', activity_level: 'high', htn: 'true' });
  assert.equal(pr.activity_level, 'high'); assert.equal(pr.htn, true); assert.equal(pr.target_mode, 'auto');
  assert.throws(() => L.normalizeProfile({ target_mode: 'manual' }), /目標カロリー/);
});

test('isFoodJan / normJan / normSearchText', () => {
  assert.equal(L.isFoodJan('food:gohan'), true); assert.equal(L.isFoodJan('4901234567894'), false); assert.equal(L.isFoodJan('food:Bad Key'), false);
  assert.equal(L.normJan('food:gohan'), 'food:gohan'); assert.equal(L.normJan('4901-2345-67894'), '4901234567894');
  assert.equal(L.normSearchText(' ミソ 汁 ABC'), 'みそ汁abc');
  assert.equal(L.normalizeProduct({ jan: 'food:gohan', name: 'ご飯', serving_basis: 'per_serving', serving_g: 150, energy_kcal: 234 }).jan, 'food:gohan');
});

test('isCustomJan / isPseudoJan（バーコードの無い商品の疑似 JAN）', () => {
  assert.equal(L.isCustomJan('custom:new'), true); assert.equal(L.isCustomJan('custom:' + 'a'.repeat(32)), true);
  assert.equal(L.isCustomJan('custom:'), false); assert.equal(L.isCustomJan('custom:Bad id'), false); assert.equal(L.isCustomJan('food:gohan'), false);
  assert.equal(L.isPseudoJan('food:gohan'), true); assert.equal(L.isPseudoJan('custom:new'), true); assert.equal(L.isPseudoJan('4901234567894'), false);
  assert.equal(L.normJan('custom:new'), 'custom:new');
  const p = L.normalizeProduct({ jan: 'custom:new', name: 'お店のカレー', serving_basis: 'per_serving', energy_kcal: 850 });
  assert.equal(p.jan, 'custom:new'); assert.equal(p.protein_g, 0);
  assert.deepEqual(L.defaultAmount(p), { mode: 'serving', amount: 1 }); assert.equal(L.factorFor(p, 'serving', 1), 1); assert.equal(L.factorFor(p, 'grams', 100), null, '質量未入力なら g 入力は不可');
});
