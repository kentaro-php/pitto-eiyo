/* ============================================================================
 * ピッと栄養 共通ロジック（純粋関数のみ）
 *  - フロント（web/logic.js）と GAS（gas/logic.js）に同じファイルをコピーして使う
 *    （scripts/sync-shared.sh）。DOM / SpreadsheetApp には一切触らない。
 *  - 栄養5項目の列名は設計書どおり energy_kcal / protein_g / fat_g / carb_g / salt_g。
 *  - 目標値は「日本人の食事摂取基準（2025年版）」の考え方で算出（設計書 8節）。
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.PittoLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KEYS = ['energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g'];
  var OPTIONAL_KEYS = ['sugar_g', 'fiber_g', 'satfat_g'];
  var NAMES = { energy_kcal: 'カロリー', protein_g: 'たんぱく質', fat_g: '脂質', carb_g: '炭水化物', salt_g: '食塩' };
  var LABELS = [
    { k: 'energy_kcal', label: '熱量', unit: 'kcal', d: 0 },
    { k: 'protein_g', label: 'たんぱく質', unit: 'g', d: 1 },
    { k: 'fat_g', label: '脂質', unit: 'g', d: 1 },
    { k: 'carb_g', label: '炭水化物', unit: 'g', d: 1 },
    { k: 'salt_g', label: '食塩相当量', unit: 'g', d: 1 }
  ];
  var MEALS = [['breakfast', '朝食'], ['lunch', '昼食'], ['dinner', '夕食'], ['snack', '間食']];
  var MEAL_NAME = {};
  MEALS.forEach(function (m) { MEAL_NAME[m[0]] = m[1]; });
  var BASES = ['per_100g', 'per_package', 'per_serving'];
  var BASIS_NAME = { per_100g: '100g', per_package: '1包装', per_serving: '1食' };
  var AMOUNT_MODES = ['package', 'grams', 'serving'];
  var ACTIVITY = ['low', 'normal', 'high'];

  /* ---------- 数値ユーティリティ ---------- */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function round(n, d) { var p = Math.pow(10, d || 0); return Math.round(n * p) / p; }
  function fmt(n, d) {
    n = Number(n) || 0;
    return n.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- 日付（YYYY-MM-DD の文字列で扱う） ---------- */
  function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDate(s) { var p = String(s).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function addDays(s, n) { var d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
  function addMonths(ym, n) { var p = ym.split('-'); var d = new Date(Number(p[0]), Number(p[1]) - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function daysInMonth(ym) { var p = ym.split('-'); return new Date(Number(p[0]), Number(p[1]), 0).getDate(); }
  function isValidDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
    var d = parseDate(s); return dateStr(d) === s;
  }
  function isValidMonth(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s)); }
  function isValidTime(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s)); }
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  function fmtDateJP(s) { var d = parseDate(s); return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WD[d.getDay()] + '）'; }
  function fmtMonthJP(ym) { var p = ym.split('-'); return Number(p[0]) + '年' + Number(p[1]) + '月'; }
  function mealByHour(h) { if (h >= 5 && h < 10) return 'breakfast'; if (h >= 10 && h < 15) return 'lunch'; if (h >= 17 && h < 23) return 'dinner'; return 'snack'; }

  /* ---------- 目標値（設計書 8節） ---------- */
  var BMR_REF = { /* 基礎代謝基準値 kcal/kg体重/日（2025年版 表3） */
    m: [[18, 29, 23.7], [30, 49, 22.5], [50, 64, 21.8], [65, 74, 21.6], [75, 200, 21.5]],
    f: [[18, 29, 22.1], [30, 49, 21.9], [50, 64, 20.7], [65, 74, 20.7], [75, 200, 20.7]]
  };
  function palTable(age) {
    if (age >= 75) return { low: 1.40, normal: 1.65, high: 1.65 };
    if (age >= 65) return { low: 1.45, normal: 1.70, high: 1.95 };
    return { low: 1.50, normal: 1.75, high: 2.00 };
  }
  /**
   * profile: { sex:'m'|'f', birth_year, weight_kg, height_cm, activity_level:'low'|'normal'|'high',
   *            target_mode:'auto'|'manual', target_kcal, kcal_adjust, htn:boolean }
   * year: 年齢計算に使う年（省略時は今年）
   */
  function computeTargets(profile, year) {
    var pr = profile || {};
    year = year || new Date().getFullYear();
    var birth = num(pr.birth_year);
    var age = birth > 0 ? year - birth : 40;
    var sex = pr.sex === 'f' ? 'f' : 'm';
    var weight = num(pr.weight_kg);
    var hasProfile = !!(pr.sex && weight > 0);
    var manual = pr.target_mode === 'manual' && num(pr.target_kcal) > 0;
    var kcal, auto = true, bmr = null;
    if (manual) { kcal = Math.round(num(pr.target_kcal)); auto = false; }
    else if (hasProfile) {
      var row = null;
      for (var i = 0; i < BMR_REF[sex].length; i++) { var r0 = BMR_REF[sex][i]; if (age >= r0[0] && age <= r0[1]) row = r0; }
      if (!row) row = BMR_REF[sex][1];
      bmr = row[2] * weight;
      var pal = palTable(age)[ACTIVITY.indexOf(pr.activity_level) >= 0 ? pr.activity_level : 'normal'];
      kcal = Math.round((bmr * pal + (num(pr.kcal_adjust) || 0)) / 10) * 10;
      if (kcal < 1000) kcal = 1000;
    } else { kcal = 2200; }
    var pLo = age >= 65 ? 0.15 : age >= 50 ? 0.14 : 0.13;
    var r = Math.round;
    return {
      kcal: kcal,
      p: [r(kcal * pLo / 4), r(kcal * 0.20 / 4)],
      f: [r(kcal * 0.20 / 9), r(kcal * 0.30 / 9)],
      c: [r(kcal * 0.50 / 4), r(kcal * 0.65 / 4)],
      salt: pr.htn ? 6.0 : (sex === 'f' ? 6.5 : 7.5),
      auto: auto, hasProfile: hasProfile || manual, age: age, sex: sex, bmr: bmr == null ? null : Math.round(bmr)
    };
  }

  /* ---------- 判定（設計書 8節の表） ---------- */
  function st(s, t) { return { s: s, t: t }; }
  var RANGE_KEY = { protein_g: 'p', fat_g: 'f', carb_g: 'c' };
  /**
   * tot: {energy_kcal, protein_g, fat_g, carb_g, salt_g}  T: computeTargets の戻り値
   * isToday=true のときは「不足」と言わず「あと◯」の残量表示にする（設計書の運用ルール）
   */
  function judge(tot, T, isToday) {
    var out = {};
    var e = Number(tot.energy_kcal) || 0, lo = T.kcal * 0.9, hi = T.kcal * 1.1;
    out.energy_kcal = e > hi ? st('over', '+' + fmt(e - T.kcal, 0) + ' kcal') :
      e >= lo ? st('ok', 'OK') :
      isToday ? st('left', 'あと ' + fmt(T.kcal - e, 0) + ' kcal') : st('short', '不足 ' + fmt(T.kcal - e, 0) + ' kcal');
    ['protein_g', 'fat_g', 'carb_g'].forEach(function (k) {
      var v = Number(tot[k]) || 0, l = T[RANGE_KEY[k]][0], h = T[RANGE_KEY[k]][1];
      out[k] = v > h ? st('over', '+' + fmt(v - h, 0) + ' g') :
        v >= l ? st('ok', 'OK') :
        isToday ? st('left', 'あと ' + fmt(l - v, 0) + ' g') : st('short', '不足 ' + fmt(l - v, 0) + ' g');
    });
    var s = Number(tot.salt_g) || 0;
    out.salt_g = s >= T.salt ? st('over', '+' + fmt(s - T.salt, 1) + ' g') : st('ok', isToday ? 'あと ' + fmt(T.salt - s, 1) + ' g' : 'OK');
    return out;
  }
  function summarize(j, tot, isToday) {
    if (!tot.count) return isToday ? 'まだ記録がありません。バーコードを読んで記録しましょう。' : 'この日の記録はありません。';
    var over = [], need = [], ok = 0;
    KEYS.forEach(function (k) {
      if (j[k].s === 'over') over.push(NAMES[k] + 'オーバー ' + j[k].t);
      else if (j[k].s === 'short' || j[k].s === 'left') need.push(NAMES[k] + ' ' + j[k].t);
      else ok++;
    });
    if (ok === KEYS.length) return 'すべて目標の範囲内です。';
    var parts = over.concat(need).slice(0, 2);
    var rest = over.length + need.length - parts.length;
    var text = parts.join('、');
    if (rest > 0) text += '、ほか' + rest + '項目';
    if (ok > 0) text += '。' + ok + '項目はOK';
    return text + '。';
  }
  function overall(j, tot, isToday) {
    if (!tot.count) return st('left', '記録なし');
    var over = false, short = false, left = false;
    KEYS.forEach(function (k) { if (j[k].s === 'over') over = true; if (j[k].s === 'short') short = true; if (j[k].s === 'left') left = true; });
    if (over) return st('over', 'オーバーあり');
    if (short) return st('short', '不足あり');
    if (left) return st('left', '記録中');
    return st('ok', '目標内');
  }
  function allOk(j) { return KEYS.every(function (k) { return j[k].s === 'ok'; }); }

  /* ---------- JAN / EAN ---------- */
  /** 手料理・一般食品の疑似 JAN（"food:<key>"、Foods.gs が登録） */
  function isFoodJan(s) { return /^food:[a-z0-9_]+$/.test(String(s == null ? '' : s)); }
  /** バーコードの無い商品（手入力登録）の疑似 JAN。クライアントは custom:new で送り、サーバが custom:<id> を振る */
  function isCustomJan(s) { return /^custom:[a-z0-9-]{1,40}$/.test(String(s == null ? '' : s)); }
  /** バーコード以外の疑似 JAN（food: / custom:）か */
  function isPseudoJan(s) { return isFoodJan(s) || isCustomJan(s); }
  function normJan(s) { if (isPseudoJan(s)) return String(s); s = String(s == null ? '' : s).replace(/\D/g, ''); return s.length === 12 ? '0' + s : s; }
  /** 検索用の正規化: 小文字、全角→半角、カタカナ→ひらがな、空白除去（web と GAS で共通） */
  function normSearchText(s) {
    s = String(s == null ? '' : s).toLowerCase().normalize('NFKC').replace(/\s+/g, '');
    return s.replace(/[\u30a1-\u30f6]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0x60); });
  }
  function eanValid(s) {
    s = String(s);
    if (!/^\d{8}$|^\d{13}$/.test(s)) return false;
    var L = s.length, sum = 0;
    for (var i = 0; i < L - 1; i++) sum += Number(s[i]) * (((L - 1 - i) % 2 === 1) ? 3 : 1);
    return ((10 - sum % 10) % 10) === Number(s[L - 1]);
  }
  function eanCheckDigit(base) {
    var L = base.length + 1, sum = 0;
    for (var i = 0; i < base.length; i++) sum += Number(base[i]) * (((L - 1 - i) % 2 === 1) ? 3 : 1);
    return String((10 - sum % 10) % 10);
  }

  /* ---------- 量 → 基準量の倍率（設計書 6節 ルール3） ----------
   * product.serving_basis: per_100g | per_package | per_serving
   * product.serving_g    : 1包装 or 1食 の質量（g/ml）。per_100g のときは未使用
   * product.package_g    : 内容量の総量（g/ml）。分かれば「1個」換算ができる
   * mode: package（個数・割合）| grams（g/ml）| serving（食）
   * 戻り値: 基準量あたりの栄養値に掛ける倍率。換算できないときは null
   */
  function factorFor(product, mode, amount) {
    amount = num(amount);
    if (!(amount > 0) || !product) return null;
    var basis = product.serving_basis, sg = num(product.serving_g), pg = num(product.package_g);
    if (basis === 'per_100g') {
      if (mode === 'grams') return amount / 100;
      if (mode === 'package') return pg > 0 ? amount * pg / 100 : null;
      if (mode === 'serving') return sg > 0 ? amount * sg / 100 : null;
    } else if (basis === 'per_package') {
      if (mode === 'package' || mode === 'serving') return amount;
      if (mode === 'grams') { var g = sg > 0 ? sg : pg; return g > 0 ? amount / g : null; }
    } else if (basis === 'per_serving') {
      if (mode === 'serving') return amount;
      if (mode === 'grams') return sg > 0 ? amount / sg : null;
      if (mode === 'package') return (sg > 0 && pg > 0) ? amount * pg / sg : amount;
    }
    return null;
  }
  function availableModes(product) {
    return AMOUNT_MODES.filter(function (m) { return factorFor(product, m, 1) != null; });
  }
  function defaultAmount(product) {
    if (!product) return { mode: 'package', amount: 1 };
    if (product.serving_basis === 'per_100g') return { mode: 'grams', amount: 100 };
    if (product.serving_basis === 'per_serving') return { mode: 'serving', amount: 1 };
    return { mode: 'package', amount: 1 };
  }
  function isLiquid(product) { return !!(product && /ml|mL|ミリリットル|リットル/.test(String(product.quantity_text || ''))); }
  function amountLabel(product, mode, amount) {
    amount = num(amount) || 0;
    if (mode === 'grams') return fmt(amount, 1) + (isLiquid(product) ? 'ml' : 'g');
    if (mode === 'serving') return fmt(amount, 2) + '食';
    if (amount === 0.5) return '半分';
    return fmt(amount, 2) + '個';
  }
  /** 基準量あたりの栄養値 n に倍率 factor を掛ける。小数1桁、熱量は整数 */
  function scaleN(n, factor) {
    var out = {};
    KEYS.concat(OPTIONAL_KEYS).forEach(function (k) {
      var v = num(n ? n[k] : null);
      if (v != null) out[k] = round(v * factor, 1);
    });
    out.energy_kcal = Math.round(out.energy_kcal || 0);
    KEYS.forEach(function (k) { if (out[k] == null) out[k] = 0; });
    return out;
  }
  function sodiumToSalt(mg) { mg = num(mg); return mg == null ? null : round(mg * 2.54 / 1000, 2); }

  /* ---------- 集計 ---------- */
  function emptyTotals() { return { energy_kcal: 0, protein_g: 0, fat_g: 0, carb_g: 0, salt_g: 0, count: 0 }; }
  function totals(logs) {
    var t = emptyTotals();
    (logs || []).forEach(function (l) {
      t.count++;
      KEYS.forEach(function (k) { t[k] += Number(l[k]) || 0; });
    });
    KEYS.forEach(function (k) { t[k] = round(t[k], 1); });
    t.energy_kcal = Math.round(t.energy_kcal);
    return t;
  }

  /* ---------- 入力検証 ---------- */
  function ValidationError(message, field) { this.name = 'ValidationError'; this.message = message; this.field = field || null; }
  ValidationError.prototype = Object.create(Error.prototype);
  /** 商品登録フォーム / API の入力を検証して正規化する。失敗は ValidationError */
  function normalizeProduct(input) {
    input = input || {};
    var jan = normJan(input.jan);
    if (!isPseudoJan(jan) && !eanValid(jan)) throw new ValidationError('JANコードが正しくありません。', 'jan');
    var name = String(input.name || '').trim();
    if (!name) throw new ValidationError('商品名を入力してください。', 'name');
    if (name.length > 120) throw new ValidationError('商品名が長すぎます。', 'name');
    var basis = BASES.indexOf(input.serving_basis) >= 0 ? input.serving_basis : null;
    if (!basis) throw new ValidationError('栄養成分表示の基準量を選んでください。', 'serving_basis');
    var kcal = num(input.energy_kcal);
    if (kcal == null || kcal < 0) throw new ValidationError('熱量（kcal）を入力してください。', 'energy_kcal');
    var out = {
      jan: jan, name: name, brand: String(input.brand || '').trim().slice(0, 80),
      quantity_text: String(input.quantity_text || '').trim().slice(0, 40),
      serving_basis: basis, serving_g: nonNeg(input.serving_g), package_g: nonNeg(input.package_g),
      energy_kcal: kcal
    };
    ['protein_g', 'fat_g', 'carb_g'].forEach(function (k) { out[k] = nonNeg(input[k]) || 0; });
    var salt = nonNeg(input.salt_g);
    if (salt == null && num(input.sodium_mg) != null) salt = sodiumToSalt(input.sodium_mg);
    out.salt_g = salt || 0;
    OPTIONAL_KEYS.forEach(function (k) { var v = nonNeg(input[k]); if (v != null) out[k] = v; });
    if (basis !== 'per_100g' && out.serving_g == null && out.package_g != null) out.serving_g = out.package_g;
    return out;
  }
  function nonNeg(v) { var n = num(v); if (n == null) return null; if (n < 0) throw new ValidationError('負の値は入力できません。'); return n; }
  function normalizeProfile(input) {
    input = input || {};
    var out = {
      sex: input.sex === 'f' ? 'f' : (input.sex === 'm' ? 'm' : ''),
      birth_year: num(input.birth_year) || null,
      height_cm: nonNeg(input.height_cm),
      weight_kg: nonNeg(input.weight_kg),
      activity_level: ACTIVITY.indexOf(input.activity_level) >= 0 ? input.activity_level : 'normal',
      target_mode: input.target_mode === 'manual' ? 'manual' : 'auto',
      target_kcal: nonNeg(input.target_kcal),
      kcal_adjust: num(input.kcal_adjust) || 0,
      htn: input.htn === true || input.htn === 'true' || input.htn === 1
    };
    var thisYear = new Date().getFullYear();
    if (out.birth_year != null && (out.birth_year < thisYear - 120 || out.birth_year > thisYear)) throw new ValidationError('生まれた年を確認してください。', 'birth_year');
    if (out.weight_kg != null && (out.weight_kg < 20 || out.weight_kg > 300)) throw new ValidationError('体重を確認してください。', 'weight_kg');
    if (out.height_cm != null && (out.height_cm < 80 || out.height_cm > 250)) throw new ValidationError('身長を確認してください。', 'height_cm');
    if (out.target_mode === 'manual' && !(out.target_kcal > 0)) throw new ValidationError('目標カロリーを入力してください。', 'target_kcal');
    if (Math.abs(out.kcal_adjust) > 1500) throw new ValidationError('カロリーの増減幅が大きすぎます。', 'kcal_adjust');
    return out;
  }

  return {
    KEYS: KEYS, OPTIONAL_KEYS: OPTIONAL_KEYS, NAMES: NAMES, LABELS: LABELS, MEALS: MEALS, MEAL_NAME: MEAL_NAME,
    BASES: BASES, BASIS_NAME: BASIS_NAME, AMOUNT_MODES: AMOUNT_MODES, ACTIVITY: ACTIVITY,
    num: num, round: round, fmt: fmt, pad: pad,
    dateStr: dateStr, parseDate: parseDate, addDays: addDays, addMonths: addMonths, daysInMonth: daysInMonth,
    isValidDate: isValidDate, isValidMonth: isValidMonth, isValidTime: isValidTime, fmtDateJP: fmtDateJP, fmtMonthJP: fmtMonthJP, mealByHour: mealByHour,
    computeTargets: computeTargets, judge: judge, summarize: summarize, overall: overall, allOk: allOk,
    normJan: normJan, eanValid: eanValid, eanCheckDigit: eanCheckDigit, isFoodJan: isFoodJan, isCustomJan: isCustomJan, isPseudoJan: isPseudoJan, normSearchText: normSearchText,
    factorFor: factorFor, availableModes: availableModes, defaultAmount: defaultAmount, amountLabel: amountLabel, isLiquid: isLiquid,
    scaleN: scaleN, sodiumToSalt: sodiumToSalt, totals: totals, emptyTotals: emptyTotals,
    ValidationError: ValidationError, normalizeProduct: normalizeProduct, normalizeProfile: normalizeProfile
  };
});
