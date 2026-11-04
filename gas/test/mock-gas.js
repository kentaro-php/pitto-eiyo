'use strict';
/* GAS のサービスをメモリ上でモックし、gas/*.gs を vm コンテキストで読み込んで API を直接呼べるようにする。
 * - シートは配列。Sheets の自動型変換（"2026-11-04" → Date、"4901234567894" → 数値）も再現して、
 *   Db.gs の読み出し正規化が効くことを確認する。
 * - UrlFetchApp は options.fetch(url, opts) に委譲（既定は例外 = ネットワーク無し）。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const FILE_ORDER = ['logic.js', 'Util.gs', 'Db.gs', 'Auth.gs', 'Products.gs', 'External.gs', 'Logs.gs', 'Summary.gs', 'Profile.gs', 'Sync.gs', 'Ocr.gs', 'Code.gs'];

function formatDate(date, tz, pattern) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' })
    .formatToParts(date).forEach(p => { parts[p.type] = p.value; });
  let off = (parts.timeZoneName || 'GMT').replace('GMT', '') || '+00:00';
  if (/^[+-]\d{2}$/.test(off)) off += ':00';
  if (/^[+-]\d:\d\d$/.test(off)) off = off[0] + '0' + off.slice(1);
  const map = { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour === '24' ? '00' : parts.hour, mm: parts.minute, ss: parts.second, SSS: String(date.getMilliseconds()).padStart(3, '0'), XXX: off };
  let out = '', i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "'") { const j = pattern.indexOf("'", i + 1); out += pattern.slice(i + 1, j); i = j + 1; continue; }
    let matched = false;
    for (const k of ['yyyy', 'XXX', 'SSS', 'MM', 'dd', 'HH', 'mm', 'ss']) {
      if (pattern.startsWith(k, i)) { out += map[k]; i += k.length; matched = true; break; }
    }
    if (!matched) out += pattern[i++];
  }
  return out;
}

function autoParse(v) {
  if (typeof v !== 'string') return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?[+-]\d{2}:\d{2}$/.test(v)) return new Date(v);
  if (/^\d{1,15}$/.test(v) && v !== '') return Number(v);
  if (v === 'TRUE') return true;
  if (v === 'FALSE') return false;
  return v;
}

class Range {
  constructor(sheet, row, col, numRows, numCols) { Object.assign(this, { sheet, row, col, numRows, numCols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) { const v = src[this.col - 1 + c]; line.push(v === undefined ? '' : v); }
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    for (let r = 0; r < vals.length; r++) {
      const idx = this.row - 1 + r;
      while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
      for (let c = 0; c < vals[r].length; c++) this.sheet.rows[idx][this.col - 1 + c] = this.sheet.autoParse ? autoParse(vals[r][c]) : vals[r][c];
    }
    return this;
  }
  clearContent() { for (let r = 0; r < this.numRows; r++) { const idx = this.row - 1 + r; if (this.sheet.rows[idx]) for (let c = 0; c < this.numCols; c++) this.sheet.rows[idx][this.col - 1 + c] = ''; } return this; }
  setNumberFormat() { return this; }
}
class Sheet {
  constructor(name, autoParseFlag) { this.name = name; this.rows = []; this.autoParse = autoParseFlag; }
  getName() { return this.name; }
  appendRow(arr) {
    const last = this.getLastRow();
    this.rows.length = last;
    this.rows.push(arr.map(v => this.autoParse ? autoParse(v) : v));
    return this;
  }
  getLastRow() { for (let i = this.rows.length - 1; i >= 0; i--) if ((this.rows[i] || []).some(v => v !== '' && v !== null && v !== undefined)) return i + 1; return 0; }
  getLastColumn() { return Math.max(0, ...this.rows.map(r => r.length)); }
  getMaxRows() { return Math.max(1000, this.rows.length); }
  getRange(row, col, numRows, numCols) { return new Range(this, row, col, numRows || 1, numCols || 1); }
  getDataRange() { return new Range(this, 1, 1, this.getLastRow() || 1, this.getLastColumn() || 1); }
  setFrozenRows() { return this; }
}
class Spreadsheet {
  constructor(autoParseFlag) { this.sheets = new Map(); this.autoParse = autoParseFlag; }
  getSheetByName(n) { return this.sheets.get(n) || null; }
  insertSheet(n) { const s = new Sheet(n, this.autoParse); this.sheets.set(n, s); return s; }
  getSheets() { return [...this.sheets.values()]; }
  getId() { return 'mock-spreadsheet'; }
}

function createGas(options = {}) {
  const props = Object.assign({ AUTH_MODE: 'dev', DEBUG: '1' }, options.properties || {});
  const ss = new Spreadsheet(options.autoParse !== false);
  const cache = new Map();
  const logs = [];
  const state = { props, ss, cache, logs, fetchCalls: [] };
  const fetchHandler = options.fetch || ((url) => { throw new Error('mock: no network for ' + url); });
  const sandbox = {
    console: { log: (...a) => logs.push(['log', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) },
    Logger: { log: (...a) => logs.push(['log', ...a]) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {}, hasLock: () => true }) },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = cache.get(k); if (!e) return null; if (e.exp < Date.now()) { cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => { cache.set(k, { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }); },
      remove: k => cache.delete(k)
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props[k] === undefined || props[k] === null) ? null : String(props[k]),
      setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props })
    }) },
    UrlFetchApp: { fetch: (url, opts) => {
      state.fetchCalls.push({ url, opts });
      const r = fetchHandler(url, opts || {});
      return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
    } },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate,
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      base64Decode: s => Array.from(Buffer.from(s, 'base64')), newBlob: () => ({}), sleep: () => {}
    },
    ContentService: { createTextOutput: s => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }), MimeType: { JSON: 'JSON' } },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => { const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, create: () => ({}) }; return b; } },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isFinite, isNaN
  };
  const ctx = vm.createContext(sandbox);
  const dir = path.join(__dirname, '..');
  for (const f of FILE_ORDER) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  const parse = out => JSON.parse(out.getContent());
  return {
    state, ctx, sandbox,
    get(params) { return parse(ctx.doGet({ parameter: params || {} })); },
    post(body) { return parse(ctx.doPost({ postData: { contents: JSON.stringify(body || {}) } })); },
    postRaw(text) { return parse(ctx.doPost({ postData: { contents: text } })); },
    call(action, params, token) { return this.post(Object.assign({ action, token: token === undefined ? 'dev' : token }, params || {})); },
    sheet(name) { return ss.getSheetByName(name); },
    run(fn, ...args) { return ctx[fn](...args); }
  };
}
module.exports = { createGas, formatDate, autoParse };
