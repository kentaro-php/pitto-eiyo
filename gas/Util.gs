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
