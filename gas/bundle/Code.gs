/* ピッと栄養 GAS 一体版 — scripts/bundle-gas.sh が生成。編集は gas/*.gs と shared/logic.js に対して行うこと。 */

/* ===================== logic.js ===================== */
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
  function normJan(s) { s = String(s == null ? '' : s).replace(/\D/g, ''); return s.length === 12 ? '0' + s : s; }
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
    if (!eanValid(jan)) throw new ValidationError('JANコードが正しくありません。', 'jan');
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
    normJan: normJan, eanValid: eanValid, eanCheckDigit: eanCheckDigit,
    factorFor: factorFor, availableModes: availableModes, defaultAmount: defaultAmount, amountLabel: amountLabel, isLiquid: isLiquid,
    scaleN: scaleN, sodiumToSalt: sodiumToSalt, totals: totals, emptyTotals: emptyTotals,
    ValidationError: ValidationError, normalizeProduct: normalizeProduct, normalizeProfile: normalizeProfile
  };
});

/* ===================== Util.gs ===================== */
/* ============================================================================
 * Util.gs — 共通ユーティリティ（エラー型・日時・ID）
 * ========================================================================== */
var TZ = 'Asia/Tokyo';
var API_VERSION = '1.0.0';

/** API が返すエラー。code はフロントが分岐に使う（unauthorized / forbidden / not_found / validation / busy / upstream / internal など） */
function ApiError(code, message, details) {
  this.name = 'ApiError';
  this.code = code;
  this.message = message;
  this.details = details || null;
}
ApiError.prototype = Object.create(Error.prototype);

function nowIso_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"); }
function todayJst_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowTimeJst_() { return Utilities.formatDate(new Date(), TZ, 'HH:mm'); }
function currentYearJst_() { return Number(todayJst_().slice(0, 4)); }
function uuid_() { return Utilities.getUuid(); }
function prop_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === '') ? (fallback === undefined ? '' : fallback) : v;
}
function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function str_(v) { return v === null || v === undefined ? '' : String(v); }
function truthy_(v) { return v === true || v === 'true' || v === 'TRUE' || v === 1 || v === '1'; }
/** fetch の共通ラッパ。失敗時は null ではなく例外（呼び出し側で握りつぶすか決める） */
function fetchJson_(url, options) {
  options = options || {};
  options.muteHttpExceptions = true;
  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  var text = res.getContentText();
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { code: code, json: json, text: text };
}

/* ===================== Db.gs ===================== */
/* ============================================================================
 * Db.gs — Googleスプレッドシートをテーブルとして扱う薄い層（設計書 6節）
 *  - 1タブ = 1テーブル、1行目 = ヘッダー。IDはUUID文字列、日時は ISO 8601（JST）文字列。
 *  - 削除は deleted_at を入れる論理削除（退会時だけ物理削除）。
 *  - 書き込みは Db.withLock() で直列化する（LockService）。
 *  - セルの自動型変換（日付や数値化）に備えて、読み出し時に文字列へ正規化する。
 * ========================================================================== */
var Db = (function () {
  var SCHEMA = {
    users: ['id', 'email', 'display_name', 'created_at', 'updated_at', 'deleted_at'],
    user_profiles: ['user_id', 'sex', 'birth_year', 'height_cm', 'weight_kg', 'activity_level', 'target_mode', 'target_kcal', 'kcal_adjust', 'htn', 'updated_at'],
    products: ['id', 'jan', 'name', 'brand', 'quantity_text', 'serving_basis', 'serving_g', 'package_g',
      'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'sugar_g', 'fiber_g', 'satfat_g',
      'source', 'verified', 'created_by', 'created_at', 'updated_at', 'deleted_at'],
    food_logs: ['id', 'client_id', 'user_id', 'product_id', 'product_name', 'date', 'eaten_at', 'meal_type', 'amount_mode', 'amount', 'amount_label',
      'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'created_at', 'updated_at', 'deleted_at'],
    daily_summaries: ['user_id', 'date', 'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'log_count', 'verdict_json', 'updated_at'],
    product_images: ['id', 'product_id', 'drive_file_id', 'kind', 'created_by', 'created_at'],
    product_suggestions: ['id', 'product_id', 'user_id', 'fields_json', 'note', 'status', 'created_at']
  };
  /* 読み出し時に必ず文字列として扱う列（シートが数値や日付に自動変換しても元に戻す） */
  var TEXT_COLS = {};
  ['id', 'jan', 'client_id', 'user_id', 'product_id', 'created_by', 'drive_file_id', 'email', 'display_name', 'name', 'brand', 'quantity_text',
    'serving_basis', 'meal_type', 'amount_mode', 'amount_label', 'source', 'sex', 'activity_level', 'target_mode', 'kind', 'note', 'status',
    'verdict_json', 'fields_json', 'product_name'].forEach(function (c) { TEXT_COLS[c] = true; });
  var DATE_COLS = { date: true };
  var BOOL_COLS = { verified: true, htn: true };

  var ss_ = null;
  var sheets_ = {};
  var lockDepth_ = 0;

  function spreadsheet_() {
    if (ss_) return ss_;
    var id = prop_('SPREADSHEET_ID');
    ss_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss_) throw new ApiError('internal', 'スプレッドシートが見つかりません。スクリプトプロパティ SPREADSHEET_ID を設定してください。');
    return ss_;
  }
  function sheet_(name) {
    if (sheets_[name]) return sheets_[name];
    if (!SCHEMA[name]) throw new ApiError('internal', '未定義のテーブル: ' + name);
    var ss = spreadsheet_();
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(SCHEMA[name]);
      sh.setFrozenRows(1);
      try { sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), SCHEMA[name].length).setNumberFormat('@'); } catch (e) { /* 書式設定は任意 */ }
    }
    sheets_[name] = sh;
    return sh;
  }
  /** 全テーブルのタブを作る。初回に Apps Script エディタから手動実行する（なくても初回アクセス時に自動で作られる） */
  function setup() { Object.keys(SCHEMA).forEach(function (n) { sheet_(n); }); return Object.keys(SCHEMA); }

  function cell_(col, v) {
    if (v instanceof Date) {
      return DATE_COLS[col] ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
    }
    if (v === '' || v === null || v === undefined) return '';
    if (BOOL_COLS[col]) return truthy_(v);
    if (TEXT_COLS[col] || DATE_COLS[col]) {
      var s = String(v);
      if (col === 'jan') s = PittoLogic.normJan(s);
      return s;
    }
    return v;
  }
  function toObj_(name, row, rowNumber) {
    var cols = SCHEMA[name], o = { _row: rowNumber };
    for (var i = 0; i < cols.length; i++) o[cols[i]] = cell_(cols[i], row[i]);
    return o;
  }
  function toRow_(name, obj) {
    return SCHEMA[name].map(function (c) {
      var v = obj[c];
      if (v === null || v === undefined) return '';
      if (BOOL_COLS[c]) return !!v;
      if (TEXT_COLS[c] || DATE_COLS[c]) return String(v);
      return v;
    });
  }
  /** テーブル全体を配列で返す（_row にシートの行番号） */
  function readAll(name) {
    var sh = sheet_(name);
    var last = sh.getLastRow();
    if (last < 2) return [];
    var values = sh.getRange(2, 1, last - 1, SCHEMA[name].length).getValues();
    var out = [];
    for (var i = 0; i < values.length; i++) {
      if (values[i][0] === '' && values[i][1] === '') continue; // 空行はスキップ
      out.push(toObj_(name, values[i], i + 2));
    }
    return out;
  }
  function findAll(name, pred) { return readAll(name).filter(pred); }
  function findOne(name, pred) {
    var rows = readAll(name);
    for (var i = 0; i < rows.length; i++) if (pred(rows[i])) return rows[i];
    return null;
  }
  function insert(name, obj) {
    sheet_(name).appendRow(toRow_(name, obj));
    return obj;
  }
  function update(name, obj) {
    if (!obj._row) throw new ApiError('internal', '更新対象の行番号がありません。');
    sheet_(name).getRange(obj._row, 1, 1, SCHEMA[name].length).setValues([toRow_(name, obj)]);
    return obj;
  }
  /** 条件に合う行を物理削除する（シートを書き直す）。退会処理専用 */
  function deleteWhere(name, pred) {
    var sh = sheet_(name);
    var rows = readAll(name);
    var keep = rows.filter(function (r) { return !pred(r); });
    if (keep.length === rows.length) return 0;
    var last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, SCHEMA[name].length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, SCHEMA[name].length).setValues(keep.map(function (r) { return toRow_(name, r); }));
    return rows.length - keep.length;
  }
  /** 書き込みの直列化。入れ子で呼ばれても二重取得しない */
  function withLock(fn) {
    if (lockDepth_ > 0) return fn();
    var lock = LockService.getScriptLock();
    var got = false;
    try { got = lock.tryLock(20000); } catch (e) { got = false; }
    if (!got) throw new ApiError('busy', '混み合っています。少し待ってからもう一度お試しください。');
    lockDepth_++;
    try { return fn(); }
    finally { lockDepth_--; try { lock.releaseLock(); } catch (e) { /* noop */ } }
  }
  /** ログインしたユーザーの行を用意する（初回は作成、退会済みなら復活）。結果はキャッシュして毎回の読み出しを省く */
  function ensureUser(user) {
    var cache = CacheService.getScriptCache();
    var key = 'user:' + user.id;
    if (cache.get(key)) return;
    withLock(function () {
      var row = findOne('users', function (r) { return r.id === user.id; });
      var now = nowIso_();
      if (!row) {
        insert('users', { id: user.id, email: user.email || '', display_name: user.name || '', created_at: now, updated_at: now, deleted_at: '' });
      } else if (row.deleted_at || row.email !== (user.email || '')) {
        row.deleted_at = ''; row.email = user.email || row.email; row.updated_at = now;
        update('users', row);
      }
    });
    cache.put(key, '1', 21600);
  }
  return { SCHEMA: SCHEMA, setup: setup, readAll: readAll, findAll: findAll, findOne: findOne, insert: insert, update: update, deleteWhere: deleteWhere, withLock: withLock, ensureUser: ensureUser };
})();

/** Apps Script エディタから一度実行: 全テーブルのタブを作成する */
function setupSheets() { return Db.setup(); }

/* ===================== Auth.gs ===================== */
/* ============================================================================
 * Auth.gs — 認証（設計書 9節 呼び出し規約2）
 *  - 本番: フロント（Google Identity Services）が得た ID トークンを body.token で受け取り、
 *          https://oauth2.googleapis.com/tokeninfo で検証。aud がこのアプリの Client ID か確認。
 *          検証結果は CacheService に有効期限まで保存する。
 *  - 開発: スクリプトプロパティ AUTH_MODE=dev のとき、token が DEV_TOKEN（既定 "dev"）に一致すれば
 *          固定ユーザーとして扱う（ログイン実装前に自分専用で動作確認するため。公開前に必ず google に戻す）。
 *  - 利用者の制限: ALLOWED_EMAILS（カンマ区切り）/ ALLOWED_DOMAINS（例 example.co.jp）を設定すると、それ以外は forbidden。
 * ========================================================================== */
var Auth = (function () {
  function authenticate(token) {
    var mode = prop_('AUTH_MODE', 'google');
    if (mode === 'dev') return devUser_(token);
    token = str_(token).trim();
    if (!token) throw new ApiError('unauthorized', 'ログインが必要です。');
    var cache = CacheService.getScriptCache();
    var key = 'tok:' + sha256Hex_(token);
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
    var info = verifyGoogleIdToken_(token);
    var user = { id: String(info.sub), email: str_(info.email).toLowerCase(), name: str_(info.name), picture: str_(info.picture) };
    checkAllowed_(user);
    var ttl = Math.min(21600, Math.max(60, Number(info.exp) - Math.floor(Date.now() / 1000)));
    cache.put(key, JSON.stringify(user), ttl);
    return user;
  }
  function verifyGoogleIdToken_(token) {
    var clientId = prop_('GOOGLE_CLIENT_ID');
    if (!clientId) throw new ApiError('internal', 'スクリプトプロパティ GOOGLE_CLIENT_ID が設定されていません。');
    var res = fetchJson_('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { method: 'get' });
    if (res.code !== 200 || !res.json) throw new ApiError('unauthorized', 'ログインの有効期限が切れました。もう一度ログインしてください。');
    var info = res.json;
    if (info.aud !== clientId) throw new ApiError('unauthorized', 'このアプリ向けのログイン情報ではありません。');
    if (['accounts.google.com', 'https://accounts.google.com'].indexOf(info.iss) < 0) throw new ApiError('unauthorized', 'ログイン情報の発行元が不正です。');
    if (!info.sub || Number(info.exp) * 1000 < Date.now()) throw new ApiError('unauthorized', 'ログインの有効期限が切れました。');
    if (info.email && String(info.email_verified) === 'false') throw new ApiError('unauthorized', 'メールアドレスが確認されていないアカウントです。');
    return info;
  }
  function devUser_(token) {
    if (str_(token) !== prop_('DEV_TOKEN', 'dev')) throw new ApiError('unauthorized', '開発用トークンが一致しません。');
    return { id: prop_('DEV_USER_ID', 'dev-user'), email: prop_('DEV_USER_EMAIL', 'dev@example.com'), name: prop_('DEV_USER_NAME', '開発ユーザー'), picture: '' };
  }
  function list_(key) { return prop_(key).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean); }
  function checkAllowed_(user) {
    var emails = list_('ALLOWED_EMAILS'), domains = list_('ALLOWED_DOMAINS');
    if (!emails.length && !domains.length) return;
    var email = str_(user.email).toLowerCase();
    var domain = email.split('@')[1] || '';
    if (emails.indexOf(email) >= 0 || domains.indexOf(domain) >= 0) return;
    throw new ApiError('forbidden', 'このアカウントではまだ利用できません。管理者に連絡してください。');
  }
  function isAdmin(user) { return list_('ADMIN_EMAILS').indexOf(str_(user && user.email).toLowerCase()) >= 0; }
  return { authenticate: authenticate, isAdmin: isAdmin };
})();

/* ===================== Products.gs ===================== */
/* ============================================================================
 * Products.gs — 共有の商品マスタ（設計書 7節: 自前マスタ → Open Food Facts → Yahoo!商品名 → OCR登録）
 * ========================================================================== */
var Products = (function () {
  var L = function () { return PittoLogic; };

  function pub(p) {
    if (!p) return null;
    var out = {
      id: p.id, jan: p.jan, name: p.name, brand: p.brand || '', quantity_text: p.quantity_text || '',
      serving_basis: p.serving_basis, serving_g: L().num(p.serving_g), package_g: L().num(p.package_g),
      source: p.source || 'manual', verified: !!p.verified, created_at: p.created_at || '', updated_at: p.updated_at || ''
    };
    L().KEYS.forEach(function (k) { out[k] = L().num(p[k]) || 0; });
    L().OPTIONAL_KEYS.forEach(function (k) { var v = L().num(p[k]); if (v != null) out[k] = v; });
    return out;
  }
  function byId(id) {
    id = str_(id);
    if (!id) return null;
    return Db.findOne('products', function (r) { return r.id === id && !r.deleted_at; });
  }
  function byJan(jan) { return Db.findOne('products', function (r) { return r.jan === jan && !r.deleted_at; }); }

  /** GET product.get?jan=…&external=1 — 認証不要。外部でヒットした商品はマスタに保存して返す */
  function get(params, ctx) {
    var jan = L().normJan(params.jan);
    if (!L().eanValid(jan)) throw new ApiError('validation', 'JANコードが正しくありません（桁数またはチェックデジット）。', { field: 'jan' });
    var p = byJan(jan);
    if (p) return { product: pub(p), found: 'master' };
    if (str_(params.external) !== '1') return { product: null, found: null };
    var off = External.openFoodFacts(jan);
    if (off) {
      var saved = Db.withLock(function () {
        var again = byJan(jan);
        if (again) return again;
        var now = nowIso_();
        var row = Object.assign({ id: uuid_(), source: 'off', verified: false, created_by: '', created_at: now, updated_at: now, deleted_at: '' }, off);
        return Db.insert('products', row);
      });
      return { product: pub(saved), found: 'off' };
    }
    var hint = External.yahooProductName(jan);
    return { product: null, found: null, hint: hint };
  }

  /** POST product.create — jan が既存なら既存を返す（409にしない） */
  function create(params, ctx) {
    var input = params.product || params;
    var norm = L().normalizeProduct(input);
    var existing = byJan(norm.jan);
    if (existing) return { product: pub(existing), created: false };
    var now = nowIso_();
    var source = ['ocr', 'manual'].indexOf(input.source) >= 0 ? input.source : 'manual';
    var row = Object.assign({ id: uuid_(), source: source, verified: !!ctx.isAdmin, created_by: ctx.user.id, created_at: now, updated_at: now, deleted_at: '' }, norm);
    Db.insert('products', row);
    saveImage_(row.id, input.image_base64, input.image_media_type, ctx);
    return { product: pub(row), created: true };
  }

  /** POST product.update — 登録者本人か管理者ならその場で修正、それ以外は修正提案として記録 */
  function update(params, ctx) {
    var input = params.product || params;
    var existing = byId(input.id || params.id);
    if (!existing) throw new ApiError('not_found', '商品が見つかりません。');
    var norm = L().normalizeProduct(Object.assign({}, input, { jan: existing.jan }));
    var canEdit = ctx.isAdmin || (existing.created_by && existing.created_by === ctx.user.id);
    if (!canEdit) {
      var s = suggest({ product_id: existing.id, fields: norm, note: str_(input.note) }, ctx);
      return { product: pub(existing), applied: false, suggestion_id: s.suggestion_id };
    }
    Object.assign(existing, norm);
    existing.updated_at = nowIso_();
    if (ctx.isAdmin && input.verified !== undefined) existing.verified = truthy_(input.verified);
    Db.update('products', existing);
    return { product: pub(existing), applied: true };
  }

  /** POST product.suggest — 修正提案（v1.1: 管理者がシート上で確認して反映する） */
  function suggest(params, ctx) {
    var product = byId(params.product_id);
    if (!product) throw new ApiError('not_found', '商品が見つかりません。');
    var fields = params.fields && typeof params.fields === 'object' ? params.fields : {};
    var row = { id: uuid_(), product_id: product.id, user_id: ctx.user.id, fields_json: JSON.stringify(fields), note: str_(params.note).slice(0, 500), status: 'open', created_at: nowIso_() };
    Db.insert('product_suggestions', row);
    return { suggestion_id: row.id };
  }

  /** POST products.recent — 本人が最近記録した／登録した商品（スキャン無しで再記録するため） */
  function recent(params, ctx) {
    var limit = Math.min(50, Math.max(1, Number(params.limit) || 30));
    return { products: recentForUser(ctx.user.id, limit).map(pub) };
  }
  function recentForUser(userId, limit) {
    var lastUsed = {};
    Db.findAll('food_logs', function (r) { return r.user_id === userId && !r.deleted_at; }).forEach(function (l) {
      var k = str_(l.created_at);
      if (!lastUsed[l.product_id] || lastUsed[l.product_id] < k) lastUsed[l.product_id] = k;
    });
    var all = Db.findAll('products', function (r) { return !r.deleted_at && (lastUsed[r.id] || r.created_by === userId); });
    all.sort(function (a, b) { return str_(lastUsed[b.id] || b.created_at).localeCompare(str_(lastUsed[a.id] || a.created_at)); });
    return all.slice(0, limit);
  }

  /** 商品画像（任意）。スクリプトプロパティ DRIVE_FOLDER_ID があるときだけ Drive に保存する */
  function saveImage_(productId, base64, mediaType, ctx) {
    var folderId = prop_('DRIVE_FOLDER_ID');
    if (!folderId || !base64) return;
    try {
      var data = String(base64).replace(/^data:[^;]+;base64,/, '');
      var blob = Utilities.newBlob(Utilities.base64Decode(data), mediaType || 'image/jpeg', productId + '.jpg');
      var file = DriveApp.getFolderById(folderId).createFile(blob);
      Db.insert('product_images', { id: uuid_(), product_id: productId, drive_file_id: file.getId(), kind: 'label', created_by: ctx.user.id, created_at: nowIso_() });
    } catch (e) { try { console.warn('画像の保存に失敗: ' + e); } catch (e2) { /* noop */ } }
  }

  return { pub: pub, byId: byId, byJan: byJan, get: get, create: create, update: update, suggest: suggest, recent: recent, recentForUser: recentForUser };
})();

/* ===================== External.gs ===================== */
/* ============================================================================
 * External.gs — 外部データソース（設計書 7節）
 *  - Open Food Facts API v2: JAN → 100gあたりの栄養成分（ODbL。source=off で分離保持）
 *  - Yahoo!ショッピング 商品検索API v3: JAN → 商品名・画像（栄養は無い）。YAHOO_CLIENT_ID が必要
 *  どちらも失敗時は null を返し、呼び出し側は手入力（OCR登録）へ進む。
 * ========================================================================== */
var External = (function () {
  var L = function () { return PittoLogic; };
  function ua_() { return prop_('APP_USER_AGENT', 'PittoEiyo/1.0 (GAS)'); }

  function parseQuantity_(s) {
    s = str_(s).toLowerCase().replace(/,/g, '.');
    var m = s.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|cl)\b/);
    if (!m) return null;
    var v = Number(m[1]);
    if (m[2] === 'kg' || m[2] === 'l') v *= 1000;
    if (m[2] === 'cl') v *= 10;
    return v > 0 ? v : null;
  }

  function openFoodFacts(jan) {
    if (prop_('DISABLE_OFF') === '1') return null;
    try {
      var url = 'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(jan) + '.json?fields=code,product_name,product_name_ja,brands,quantity,serving_size,nutriments';
      var res = fetchJson_(url, { method: 'get', headers: { 'User-Agent': ua_() }, followRedirects: true });
      if (res.code !== 200 || !res.json || Number(res.json.status) !== 1 || !res.json.product) return null;
      var pr = res.json.product, n = pr.nutriments || {};
      var num = L().num;
      var kcal = num(n['energy-kcal_100g']);
      if (kcal == null && num(n['energy_100g']) != null) kcal = Math.round(num(n['energy_100g']) / 4.184);
      if (kcal == null) return null;
      var salt = num(n['salt_100g']);
      if (salt == null && num(n['sodium_100g']) != null) salt = L().round(num(n['sodium_100g']) * 2.54, 2);
      var out = {
        jan: jan, name: str_(pr.product_name_ja || pr.product_name).trim().slice(0, 120), brand: str_(pr.brands).slice(0, 80),
        quantity_text: str_(pr.quantity).slice(0, 40), serving_basis: 'per_100g',
        serving_g: parseQuantity_(pr.serving_size), package_g: parseQuantity_(pr.quantity),
        energy_kcal: kcal, protein_g: num(n['proteins_100g']) || 0, fat_g: num(n['fat_100g']) || 0,
        carb_g: num(n['carbohydrates_100g']) || 0, salt_g: salt || 0
      };
      if (!out.name) out.name = 'JAN ' + jan;
      var sugar = num(n['sugars_100g']), fiber = num(n['fiber_100g']), sat = num(n['saturated-fat_100g']);
      if (sugar != null) out.sugar_g = sugar;
      if (fiber != null) out.fiber_g = fiber;
      if (sat != null) out.satfat_g = sat;
      return out;
    } catch (e) {
      return null;
    }
  }

  function yahooProductName(jan) {
    var appid = prop_('YAHOO_CLIENT_ID');
    if (!appid) return null;
    try {
      var url = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?appid=' + encodeURIComponent(appid) + '&jan_code=' + encodeURIComponent(jan) + '&results=1';
      var res = fetchJson_(url, { method: 'get' });
      if (res.code !== 200 || !res.json || !res.json.hits || !res.json.hits.length) return null;
      var hit = res.json.hits[0];
      return { name: str_(hit.name).slice(0, 120), brand: hit.brand ? str_(hit.brand.name).slice(0, 80) : '', image_url: hit.image ? str_(hit.image.medium) : '' };
    } catch (e) {
      return null;
    }
  }
  return { openFoodFacts: openFoodFacts, yahooProductName: yahooProductName, parseQuantity_: parseQuantity_ };
})();

/* ===================== Logs.gs ===================== */
/* ============================================================================
 * Logs.gs — 食事記録（設計書 6節: 登録時点の栄養5項目をスナップショットで保持）
 * ========================================================================== */
var Logs = (function () {
  var L = function () { return PittoLogic; };

  function pub(l) {
    if (!l) return null;
    var out = {
      id: l.id, client_id: l.client_id || '', product_id: l.product_id, product_name: l.product_name || '',
      date: l.date, time: timeOf_(l), eaten_at: l.eaten_at, meal_type: l.meal_type, amount_mode: l.amount_mode,
      amount: L().num(l.amount) || 0, amount_label: l.amount_label || '', created_at: l.created_at || '', updated_at: l.updated_at || ''
    };
    L().KEYS.forEach(function (k) { out[k] = L().num(l[k]) || 0; });
    return out;
  }
  function timeOf_(l) { var m = str_(l.eaten_at).match(/T(\d{2}:\d{2})/); return m ? m[1] : ''; }
  function own_(userId, id) {
    id = str_(id);
    return id ? Db.findOne('food_logs', function (r) { return r.id === id && r.user_id === userId && !r.deleted_at; }) : null;
  }
  function validateCommon_(p, existing) {
    var date = str_(p.date || (existing && existing.date));
    if (!L().isValidDate(date)) throw new ApiError('validation', '日付の形式が正しくありません（YYYY-MM-DD）。', { field: 'date' });
    var today = todayJst_();
    if (date > L().addDays(today, 1) || date < L().addDays(today, -400)) throw new ApiError('validation', '日付が範囲外です。', { field: 'date' });
    var time = str_(p.time || (existing && timeOf_(existing)));
    if (!time) time = date === today ? nowTimeJst_() : '12:00';
    if (!L().isValidTime(time)) throw new ApiError('validation', '時刻の形式が正しくありません（HH:MM）。', { field: 'time' });
    var meal = str_(p.meal_type || (existing && existing.meal_type));
    if (!L().MEAL_NAME[meal]) meal = L().mealByHour(Number(time.slice(0, 2)));
    var mode = str_(p.amount_mode || (existing && existing.amount_mode));
    if (L().AMOUNT_MODES.indexOf(mode) < 0) throw new ApiError('validation', '量の指定方法が不正です。', { field: 'amount_mode' });
    var amount = L().num(p.amount !== undefined ? p.amount : (existing && existing.amount));
    if (!(amount > 0) || amount > 5000) throw new ApiError('validation', '量を正しく入力してください。', { field: 'amount' });
    return { date: date, time: time, meal_type: meal, amount_mode: mode, amount: amount };
  }

  /** POST log.create — client_id で冪等化（オフラインキューの再送で二重登録しない） */
  function create(params, ctx) {
    var user = ctx.user;
    var clientId = str_(params.client_id).trim();
    if (!clientId || clientId.length > 64) throw new ApiError('validation', 'client_id が必要です。', { field: 'client_id' });
    var dup = Db.findOne('food_logs', function (r) { return r.user_id === user.id && r.client_id === clientId; });
    if (dup) return { log: pub(dup), daily_summary: Summary.getOrCompute(user, dup.date), duplicate: true };
    var product = Products.byId(params.product_id);
    if (!product) throw new ApiError('not_found', '商品が見つかりません。', { field: 'product_id' });
    var v = validateCommon_(params, null);
    var factor = L().factorFor(product, v.amount_mode, v.amount);
    if (factor == null) throw new ApiError('validation', 'この商品ではその量の指定方法が使えません（内容量が未登録）。', { field: 'amount_mode' });
    var n = L().scaleN(product, factor);
    var now = nowIso_();
    var log = {
      id: uuid_(), client_id: clientId, user_id: user.id, product_id: product.id, product_name: product.name,
      date: v.date, eaten_at: v.date + 'T' + v.time + ':00+09:00', meal_type: v.meal_type, amount_mode: v.amount_mode, amount: v.amount,
      amount_label: L().amountLabel(product, v.amount_mode, v.amount),
      energy_kcal: n.energy_kcal, protein_g: n.protein_g, fat_g: n.fat_g, carb_g: n.carb_g, salt_g: n.salt_g,
      created_at: now, updated_at: now, deleted_at: ''
    };
    Db.insert('food_logs', log);
    return { log: pub(log), daily_summary: Summary.recompute(user, v.date), duplicate: false };
  }

  /** POST log.update — 日付・時刻・区分・量の変更。栄養値は商品マスタの現在値から再計算 */
  function update(params, ctx) {
    var user = ctx.user;
    var log = own_(user.id, params.id);
    if (!log) throw new ApiError('not_found', '記録が見つかりません。');
    var v = validateCommon_(params, log);
    var product = Products.byId(log.product_id);
    var n;
    if (product) {
      var factor = L().factorFor(product, v.amount_mode, v.amount);
      if (factor == null) throw new ApiError('validation', 'この商品ではその量の指定方法が使えません。', { field: 'amount_mode' });
      n = L().scaleN(product, factor);
      log.amount_label = L().amountLabel(product, v.amount_mode, v.amount);
    } else {
      if (v.amount_mode !== log.amount_mode) throw new ApiError('validation', '商品マスタに無い商品は量の指定方法を変えられません。');
      var ratio = v.amount / (L().num(log.amount) || 1);
      n = L().scaleN(log, ratio);
      log.amount_label = L().amountLabel({ quantity_text: '' }, v.amount_mode, v.amount);
    }
    var oldDate = log.date;
    log.date = v.date; log.eaten_at = v.date + 'T' + v.time + ':00+09:00'; log.meal_type = v.meal_type;
    log.amount_mode = v.amount_mode; log.amount = v.amount;
    L().KEYS.forEach(function (k) { log[k] = n[k]; });
    log.updated_at = nowIso_();
    Db.update('food_logs', log);
    var summary = Summary.recompute(user, log.date);
    if (oldDate !== log.date) Summary.recompute(user, oldDate);
    return { log: pub(log), daily_summary: summary };
  }

  /** POST log.delete — 論理削除 */
  function remove(params, ctx) {
    var user = ctx.user;
    var log = own_(user.id, params.id);
    if (!log) throw new ApiError('not_found', '記録が見つかりません。');
    log.deleted_at = nowIso_(); log.updated_at = log.deleted_at;
    Db.update('food_logs', log);
    return { id: log.id, daily_summary: Summary.recompute(user, log.date) };
  }

  /** POST logs.list — from〜to（両端含む、最大366日） */
  function list(params, ctx) {
    var from = str_(params.from), to = str_(params.to || params.from);
    if (!L().isValidDate(from) || !L().isValidDate(to) || from > to) throw new ApiError('validation', '期間の指定が正しくありません。');
    if (L().parseDate(to) - L().parseDate(from) > 366 * 86400000) throw new ApiError('validation', '期間が長すぎます（最大366日）。');
    return { logs: listRange(ctx.user.id, from, to).map(pub) };
  }
  function listRange(userId, from, to) {
    var rows = Db.findAll('food_logs', function (r) { return r.user_id === userId && !r.deleted_at && r.date >= from && r.date <= to; });
    rows.sort(function (a, b) { return str_(a.eaten_at).localeCompare(str_(b.eaten_at)) || str_(a.created_at).localeCompare(str_(b.created_at)); });
    return rows;
  }
  return { pub: pub, create: create, update: update, remove: remove, list: list, listRange: listRange };
})();

/* ===================== Summary.gs ===================== */
/* ============================================================================
 * Summary.gs — 日次・月次集計（設計書 6節 ルール5 / 8節）
 *  - daily_summaries は記録の登録・更新・削除のたびにその日を再計算して upsert する。
 *  - 夜間トリガー recomputeAllSummaries() で全件を再計算してずれを直す。
 *  - 判定は目標値に依存するため、API の応答では保存値ではなく現在の目標で判定し直す。
 * ========================================================================== */
var Summary = (function () {
  var L = function () { return PittoLogic; };

  function targetsFor(user) {
    var pr = Profile.row(user.id);
    return L().computeTargets(pr || {}, currentYearJst_());
  }
  function totalsOf_(row) {
    var t = L().emptyTotals();
    if (!row) return t;
    L().KEYS.forEach(function (k) { t[k] = L().num(row[k]) || 0; });
    t.count = Number(row.log_count) || 0;
    return t;
  }
  function present_(date, tot, T) {
    var isToday = date === todayJst_();
    var j = tot.count ? L().judge(tot, T, isToday) : null;
    return {
      date: date, totals: tot, verdict: j,
      overall: L().overall(j || {}, tot, isToday), summary_text: L().summarize(j || {}, tot, isToday),
      all_ok: !!(j && L().allOk(j))
    };
  }
  function findRow_(userId, date) { return Db.findOne('daily_summaries', function (r) { return r.user_id === userId && r.date === date; }); }

  /** その日の記録から集計し直して daily_summaries に保存する */
  function recompute(user, date) {
    var logs = Logs.listRange(user.id, date, date);
    var tot = L().totals(logs);
    var T = targetsFor(user);
    var verdict = tot.count ? L().judge(tot, T, false) : null;
    var row = findRow_(user.id, date);
    var now = nowIso_();
    var values = { user_id: user.id, date: date, energy_kcal: tot.energy_kcal, protein_g: tot.protein_g, fat_g: tot.fat_g, carb_g: tot.carb_g, salt_g: tot.salt_g, log_count: tot.count, verdict_json: JSON.stringify(verdict), updated_at: now };
    if (row) { Object.assign(row, values); Db.update('daily_summaries', row); }
    else if (tot.count > 0) { Db.insert('daily_summaries', values); }
    var out = present_(date, tot, T);
    out.targets = T;
    return out;
  }
  function getOrCompute(user, date) {
    var row = findRow_(user.id, date);
    if (!row) return recompute(user, date);
    var out = present_(date, totalsOf_(row), targetsFor(user));
    out.targets = targetsFor(user);
    return out;
  }

  /** POST summary.daily { date } */
  function daily(params, ctx) {
    var date = str_(params.date) || todayJst_();
    if (!L().isValidDate(date)) throw new ApiError('validation', '日付の形式が正しくありません。', { field: 'date' });
    var s = getOrCompute(ctx.user, date);
    return { daily_summary: s, targets: s.targets };
  }

  /** POST summary.monthly { month: YYYY-MM } — 日別配列・月合計・平均・達成日数 */
  function monthly(params, ctx) {
    var month = str_(params.month) || todayJst_().slice(0, 7);
    if (!L().isValidMonth(month)) throw new ApiError('validation', '月の形式が正しくありません（YYYY-MM）。', { field: 'month' });
    var T = targetsFor(ctx.user);
    var rows = {};
    Db.findAll('daily_summaries', function (r) { return r.user_id === ctx.user.id && str_(r.date).slice(0, 7) === month; })
      .forEach(function (r) { rows[r.date] = r; });
    var n = L().daysInMonth(month), days = [], recorded = 0, achieved = 0, sum = L().emptyTotals();
    for (var d = 1; d <= n; d++) {
      var date = month + '-' + L().pad(d);
      var tot = totalsOf_(rows[date]);
      var p = present_(date, tot, T);
      days.push(p);
      if (tot.count) { recorded++; L().KEYS.forEach(function (k) { sum[k] += tot[k]; }); sum.count += tot.count; if (p.all_ok) achieved++; }
    }
    var avg = L().emptyTotals();
    L().KEYS.forEach(function (k) { sum[k] = L().round(sum[k], 1); avg[k] = recorded ? L().round(sum[k] / recorded, 1) : 0; });
    avg.count = recorded;
    var avgVerdict = recorded ? L().judge(avg, T, false) : null;
    return { month: month, days: days, recorded_days: recorded, achieved_days: achieved, sum: sum, avg: avg, avg_verdict: avgVerdict, targets: T };
  }

  /** 夜間トリガー用: 全ユーザー・全日の日次サマリを再計算する */
  function recomputeAll() {
    var users = Db.findAll('users', function (r) { return !r.deleted_at; });
    var byUser = {};
    Db.findAll('food_logs', function (r) { return !r.deleted_at; }).forEach(function (l) {
      if (!byUser[l.user_id]) byUser[l.user_id] = {};
      byUser[l.user_id][l.date] = true;
    });
    var count = 0;
    Db.withLock(function () {
      users.forEach(function (u) {
        var user = { id: u.id, email: u.email, name: u.display_name };
        var dates = Object.keys(byUser[u.id] || {});
        Db.findAll('daily_summaries', function (r) { return r.user_id === u.id; }).forEach(function (r) { if (dates.indexOf(r.date) < 0) dates.push(r.date); });
        dates.forEach(function (d) { recompute(user, d); count++; });
      });
    });
    return count;
  }
  return { targetsFor: targetsFor, recompute: recompute, getOrCompute: getOrCompute, daily: daily, monthly: monthly, recomputeAll: recomputeAll };
})();

/** トリガーから呼ばれる（setupNightlyTrigger で登録） */
function recomputeAllSummaries() { return Summary.recomputeAll(); }
/** Apps Script エディタから一度実行: 毎日 3 時に全件再計算するトリガーを登録する */
function setupNightlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'recomputeAllSummaries') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('recomputeAllSummaries').timeBased().everyDays(1).atHour(3).create();
}

/* ===================== Profile.gs ===================== */
/* ============================================================================
 * Profile.gs — プロフィール・目標（設計書 8節）と退会（設計書: 本人の記録を物理削除）
 * ========================================================================== */
var Profile = (function () {
  var L = function () { return PittoLogic; };
  function row(userId) { return Db.findOne('user_profiles', function (r) { return r.user_id === userId; }); }
  function pub(r) {
    r = r || {};
    return {
      sex: str_(r.sex), birth_year: L().num(r.birth_year), height_cm: L().num(r.height_cm), weight_kg: L().num(r.weight_kg),
      activity_level: str_(r.activity_level) || 'normal', target_mode: str_(r.target_mode) || 'auto',
      target_kcal: L().num(r.target_kcal), kcal_adjust: L().num(r.kcal_adjust) || 0, htn: !!r.htn, updated_at: str_(r.updated_at)
    };
  }
  function get(params, ctx) {
    var r = row(ctx.user.id);
    return { profile: pub(r), targets: L().computeTargets(r || {}, currentYearJst_()), user: { email: ctx.user.email, name: ctx.user.name } };
  }
  function update(params, ctx) {
    var norm = L().normalizeProfile(params.profile || params);
    var r = row(ctx.user.id);
    norm.updated_at = nowIso_();
    if (r) { Object.assign(r, norm); Db.update('user_profiles', r); }
    else { r = Object.assign({ user_id: ctx.user.id }, norm); Db.insert('user_profiles', r); }
    return { profile: pub(r), targets: L().computeTargets(r, currentYearJst_()) };
  }
  /** POST account.delete — 本人の記録・サマリ・プロフィール・ユーザー行を物理削除する（共有の商品マスタは残す） */
  function deleteAccount(params, ctx) {
    if (str_(params.confirm) !== 'DELETE') throw new ApiError('validation', '確認文字列 confirm: "DELETE" が必要です。');
    var id = ctx.user.id;
    var byUser = function (r) { return r.user_id === id; };
    var out = {
      logs: Db.deleteWhere('food_logs', byUser),
      summaries: Db.deleteWhere('daily_summaries', byUser),
      profile: Db.deleteWhere('user_profiles', byUser),
      suggestions: Db.deleteWhere('product_suggestions', byUser),
      user: Db.deleteWhere('users', function (r) { return r.id === id; })
    };
    try { CacheService.getScriptCache().remove('user:' + id); } catch (e) { /* noop */ }
    return { deleted: out };
  }
  return { row: row, pub: pub, get: get, update: update, deleteAccount: deleteAccount };
})();

/* ===================== Sync.gs ===================== */
/* ============================================================================
 * Sync.gs — 起動時の一括同期（GASは1往復 0.5〜2秒かかるので初期表示に必要な物を1回で返す）
 * ========================================================================== */
var Sync = (function () {
  var L = function () { return PittoLogic; };
  /** POST sync.bootstrap { days?: 30 } → プロフィール・目標・直近の記録・最近の商品 */
  function bootstrap(params, ctx) {
    var days = Math.min(92, Math.max(1, Number(params.days) || 30));
    var today = todayJst_();
    var from = L().addDays(today, -(days - 1));
    var pr = Profile.row(ctx.user.id);
    return {
      today: today, now: nowIso_(),
      user: { email: ctx.user.email, name: ctx.user.name, picture: ctx.user.picture || '', is_admin: !!ctx.isAdmin },
      profile: Profile.pub(pr), targets: L().computeTargets(pr || {}, currentYearJst_()),
      logs: Logs.listRange(ctx.user.id, from, today).map(Logs.pub),
      products: Products.recentForUser(ctx.user.id, 30).map(Products.pub),
      range: { from: from, to: today }
    };
  }
  return { bootstrap: bootstrap };
})();

/* ===================== Ocr.gs ===================== */
/* ============================================================================
 * Ocr.gs — 栄養成分表示の写真 → 5項目（設計書 7節）
 *  - 既定は Claude（Anthropic Messages API）。スクリプトプロパティ OCR_PROVIDER=gemini で Gemini に切替。
 *  - API キーはスクリプトプロパティ CLAUDE_API_KEY / GEMINI_API_KEY に置く（コードに書かない）。
 *  - 返却スキーマ: { basis, serving_g, package_g, name, energy_kcal, protein_g, fat_g, carb_g, salt_g,
 *                   sodium_mg, sugar_g, fiber_g, satfat_g, confidence, notes }
 *  - 誤読があり得るのでフロントは必ず確認画面を挟む（confidence が低い項目は強調）。
 * ========================================================================== */
var Ocr = (function () {
  var L = function () { return PittoLogic; };
  var NUM_OR_NULL = { anyOf: [{ type: 'number' }, { type: 'null' }] };
  var SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['basis', 'serving_g', 'package_g', 'name', 'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'sodium_mg', 'sugar_g', 'fiber_g', 'satfat_g', 'confidence', 'notes'],
    properties: {
      basis: { anyOf: [{ type: 'string', enum: ['per_100g', 'per_package', 'per_serving'] }, { type: 'null' }] },
      serving_g: NUM_OR_NULL, package_g: NUM_OR_NULL,
      name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      energy_kcal: NUM_OR_NULL, protein_g: NUM_OR_NULL, fat_g: NUM_OR_NULL, carb_g: NUM_OR_NULL, salt_g: NUM_OR_NULL,
      sodium_mg: NUM_OR_NULL, sugar_g: NUM_OR_NULL, fiber_g: NUM_OR_NULL, satfat_g: NUM_OR_NULL,
      confidence: { type: 'number' }, notes: { type: 'string' }
    }
  };
  var SYSTEM = '日本の食品パッケージの「栄養成分表示」を読み取り、指定のJSONだけを返す読取係です。説明文は書きません。';
  var PROMPT = [
    'この画像の栄養成分表示を読み取ってください。',
    'ルール:',
    '- basis: 「100gあたり」「100mlあたり」なら per_100g、「1包装あたり」「1袋あたり」「1本あたり」「1個あたり」なら per_package、「1食（○g）あたり」なら per_serving。読めなければ null。',
    '- serving_g: basis が per_package / per_serving のときの基準量の質量（gまたはml）。per_100g なら null。',
    '- package_g: 内容量（総量）が読めればその数値（gまたはml）。読めなければ null。',
    '- name: 商品名が読めれば入れる。読めなければ null。',
    '- energy_kcal / protein_g / fat_g / carb_g / salt_g: 熱量・たんぱく質・脂質・炭水化物・食塩相当量。単位を付けず数値だけ。',
    '- 「食塩相当量」が無く「ナトリウム(mg)」だけの場合は sodium_mg に入れ、salt_g は null。',
    '- 「炭水化物」が無く「糖質」「食物繊維」だけなら sugar_g / fiber_g に入れ、carb_g は null。飽和脂肪酸があれば satfat_g。',
    '- 読めない項目は null。推測で埋めない。',
    '- confidence: 読み取り全体の確からしさ（0〜1）。不鮮明・一部欠けなら低くする。notes: 気になった点を短く（例: 「ナトリウム表記」「写真がぼやけている」）。無ければ空文字。'
  ].join('\n');

  /** POST ocr.parse { image_base64, media_type } */
  function parse(params, ctx) {
    var data = str_(params.image_base64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    if (!data) throw new ApiError('validation', '画像がありません。', { field: 'image_base64' });
    if (data.length > 7000000) throw new ApiError('validation', '画像が大きすぎます（5MB以下にしてください）。', { field: 'image_base64' });
    var mediaType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].indexOf(params.media_type) >= 0 ? params.media_type : 'image/jpeg';
    var provider = prop_('OCR_PROVIDER', 'claude');
    var raw = provider === 'gemini' ? gemini_(data, mediaType) : claude_(data, mediaType);
    return { result: normalize_(raw.json), provider: provider, model: raw.model };
  }

  function claude_(data, mediaType) {
    var key = prop_('CLAUDE_API_KEY');
    if (!key) throw new ApiError('internal', 'スクリプトプロパティ CLAUDE_API_KEY が設定されていません。');
    var model = prop_('CLAUDE_MODEL', 'claude-opus-5-5');
    var body = {
      model: model,
      max_tokens: 1024,
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: data } },
        { type: 'text', text: PROMPT }
      ] }]
    };
    var res = fetchJson_('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
      headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' }
    });
    if (res.code === 401 || res.code === 403) throw new ApiError('internal', 'Claude API キーが無効です。');
    if (res.code === 429 || res.code === 529) throw new ApiError('rate_limited', '読み取りが混み合っています。しばらくしてからもう一度お試しください。');
    if (res.code !== 200 || !res.json) throw new ApiError('upstream', '読み取りサービスでエラーが起きました（' + res.code + '）。', { body: (res.text || '').slice(0, 300) });
    var msg = res.json;
    if (msg.stop_reason === 'refusal') throw new ApiError('ocr_refused', 'この画像は読み取れませんでした。別の写真でお試しください。');
    if (msg.stop_reason === 'max_tokens') throw new ApiError('ocr_failed', '読み取り結果が長すぎて解釈できませんでした。');
    var text = (msg.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    return { json: parseJson_(text), model: msg.model || model };
  }

  function gemini_(data, mediaType) {
    var key = prop_('GEMINI_API_KEY');
    if (!key) throw new ApiError('internal', 'スクリプトプロパティ GEMINI_API_KEY が設定されていません。');
    var model = prop_('GEMINI_MODEL', 'gemini-2.5-flash');
    var body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: data } }, { text: PROMPT + '\n\n次のキーを持つJSONオブジェクトだけを返してください: ' + SCHEMA.required.join(', ') }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 }
    };
    var res = fetchJson_('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body)
    });
    if (res.code === 429) throw new ApiError('rate_limited', '読み取りが混み合っています。しばらくしてからもう一度お試しください。');
    if (res.code !== 200 || !res.json) throw new ApiError('upstream', '読み取りサービスでエラーが起きました（' + res.code + '）。', { body: (res.text || '').slice(0, 300) });
    var cand = (res.json.candidates || [])[0];
    var text = cand && cand.content && cand.content.parts ? cand.content.parts.map(function (p) { return p.text || ''; }).join('') : '';
    return { json: parseJson_(text), model: model };
  }

  function parseJson_(text) {
    var t = str_(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t); } catch (e) {
      var m = t.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fallthrough */ } }
      throw new ApiError('ocr_failed', '読み取り結果を解釈できませんでした。もう一度撮影してください。');
    }
  }
  function normalize_(d) {
    if (!d || typeof d !== 'object') throw new ApiError('ocr_failed', '読み取り結果を解釈できませんでした。');
    var out = {}, num = L().num;
    out.basis = L().BASES.indexOf(d.basis) >= 0 ? d.basis : null;
    ['serving_g', 'package_g', 'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'sodium_mg', 'sugar_g', 'fiber_g', 'satfat_g'].forEach(function (k) {
      var v = num(d[k]); out[k] = (v == null || v < 0) ? null : v;
    });
    if (out.salt_g == null && out.sodium_mg != null) out.salt_g = L().sodiumToSalt(out.sodium_mg);
    if (out.carb_g == null && out.sugar_g != null) out.carb_g = L().round(out.sugar_g + (out.fiber_g || 0), 1);
    out.name = typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 120) : null;
    var c = num(d.confidence); out.confidence = c == null ? 0.5 : Math.max(0, Math.min(1, c));
    out.notes = typeof d.notes === 'string' ? d.notes.slice(0, 200) : '';
    out.filled = ['energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g'].filter(function (k) { return out[k] != null; }).length;
    return out;
  }
  return { parse: parse, SCHEMA: SCHEMA };
})();

/* ===================== Code.gs ===================== */
/* ============================================================================
 * Code.gs — ピッと栄養 GAS Web App（JSON API）エントリポイント（設計書 9節）
 *
 *  呼び出し規約
 *   - 1つのURL（.../exec）に action で振り分ける。GET は認証不要の商品照会と health だけ、他は POST。
 *   - POST は Content-Type: text/plain で JSON 文字列を送る（application/json だとプリフライトで失敗する）。
 *   - 認証はヘッダーではなく body.token（Google の ID トークン）。
 *   - レスポンスは常に { ok, data?, error?: { code, message } }。HTTP ステータスは常に 200。
 *   - 書き込みは client_id（端末生成のUUID）で冪等化する（log.create）。
 *
 *  デプロイ: 「ウェブアプリ」/ 実行ユーザー: 自分 / アクセス: 全員（匿名ユーザーを含む）
 * ========================================================================== */

function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  return jsonOutput_(handleRequest_('GET', p, p.token));
}

function doPost(e) {
  var body = null;
  try {
    var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    body = JSON.parse(raw);
  } catch (err) {
    return jsonOutput_(fail_('bad_request', 'リクエストのJSONを解釈できません。'));
  }
  if (!body || typeof body !== 'object') body = {};
  return jsonOutput_(handleRequest_('POST', body, body.token));
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(code, message, details) {
  var err = { code: code, message: message };
  if (details) err.details = details;
  return { ok: false, error: err };
}

/** action → ハンドラ。モジュールの読み込み順に依存しないよう関数内で組み立てる */
function routes_() {
  return {
    'health':          { fn: function () { return { version: API_VERSION, time: nowIso_(), auth_mode: prop_('AUTH_MODE', 'google') }; }, auth: false, methods: ['GET', 'POST'] },
    'product.get':     { fn: Products.get,     auth: false, methods: ['GET', 'POST'] },
    'product.create':  { fn: Products.create,  auth: true,  write: true },
    'product.update':  { fn: Products.update,  auth: true,  write: true },
    'product.suggest': { fn: Products.suggest, auth: true,  write: true },
    'products.recent': { fn: Products.recent,  auth: true },
    'ocr.parse':       { fn: Ocr.parse,        auth: true },
    'log.create':      { fn: Logs.create,      auth: true,  write: true },
    'log.update':      { fn: Logs.update,      auth: true,  write: true },
    'log.delete':      { fn: Logs.remove,      auth: true,  write: true },
    'logs.list':       { fn: Logs.list,        auth: true },
    'summary.daily':   { fn: Summary.daily,    auth: true },
    'summary.monthly': { fn: Summary.monthly,  auth: true },
    'profile.get':     { fn: Profile.get,      auth: true },
    'profile.update':  { fn: Profile.update,   auth: true,  write: true },
    'account.delete':  { fn: Profile.deleteAccount, auth: true, write: true },
    'sync.bootstrap':  { fn: Sync.bootstrap,   auth: true }
  };
}

function handleRequest_(method, params, token) {
  var action = str_(params && params.action);
  try {
    var route = routes_()[action];
    if (!route) throw new ApiError('unknown_action', '不明な action です: ' + (action || '(なし)'));
    var methods = route.methods || ['POST'];
    if (methods.indexOf(method) < 0) throw new ApiError('method_not_allowed', action + ' は ' + methods.join('/') + ' で呼び出してください。');
    var ctx = { method: method, user: null, isAdmin: false };
    if (route.auth) {
      ctx.user = Auth.authenticate(token);
      ctx.isAdmin = Auth.isAdmin(ctx.user);
      Db.ensureUser(ctx.user);
    }
    var data = route.write ? Db.withLock(function () { return route.fn(params, ctx); }) : route.fn(params, ctx);
    return { ok: true, data: data === undefined ? null : data };
  } catch (err) {
    if (err instanceof ApiError) return fail_(err.code, err.message, err.details);
    if (err && err.name === 'ValidationError') return fail_('validation', err.message, err.field ? { field: err.field } : null);
    try { console.error('[' + action + '] ' + (err && err.stack ? err.stack : err)); } catch (e) { /* noop */ }
    var debug = prop_('DEBUG') === '1';
    return fail_('internal', 'サーバーでエラーが起きました。' + (debug && err ? ' ' + err.message : ''));
  }
}

/** Apps Script エディタから実行: 全モジュールが読み込まれているか・共通ロジックが動くかを確認する（貼り付けミスの検出用） */
function selfCheck() {
  var modules = ['PittoLogic', 'Db', 'Auth', 'Products', 'External', 'Logs', 'Summary', 'Profile', 'Sync', 'Ocr'];
  var missing = modules.filter(function (m) { try { return typeof eval(m) !== 'object' && typeof eval(m) !== 'function'; } catch (e) { return true; } });
  var T = PittoLogic.computeTargets({ sex: 'm', birth_year: 1986, weight_kg: 70, activity_level: 'normal' }, 2026);
  var result = {
    version: API_VERSION,
    modules_ok: missing.length === 0, missing: missing,
    logic_ok: T.kcal === 2760 && PittoLogic.eanValid('4901234567894'),
    tables: Object.keys(Db.SCHEMA),
    auth_mode: prop_('AUTH_MODE', 'google'),
    properties_set: ['GOOGLE_CLIENT_ID', 'CLAUDE_API_KEY', 'GEMINI_API_KEY', 'YAHOO_CLIENT_ID', 'ALLOWED_EMAILS', 'ADMIN_EMAILS', 'SPREADSHEET_ID'].filter(function (k) { return !!prop_(k); }),
    timezone: TZ, today: todayJst_()
  };
  result.ok = result.modules_ok && result.logic_ok;
  try { console.log(JSON.stringify(result)); } catch (e) { /* noop */ }
  return result;
}

/* ===================== END OF BUNDLE ===================== */
