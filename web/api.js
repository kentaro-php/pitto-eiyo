/* ピッと栄養 API クライアント（GAS Web App）— 設計書 9節の呼び出し規約
 *  - POST は text/plain で JSON を送る（プリフライト回避）、redirect: 'follow'
 *  - 認証は body.token、レスポンスは { ok, data, error } */
window.PittoApi = (function () {
  'use strict';
  var cfg = window.PITTO_CONFIG || {};
  var tokenProvider = function () { return null; };

  function ApiError(code, message, details) { this.name = 'ApiError'; this.code = code; this.message = message; this.details = details || null; }
  ApiError.prototype = Object.create(Error.prototype);

  function isConfigured() { return !!cfg.apiUrl; }
  function signal(ms) {
    try { if (AbortSignal.timeout) return AbortSignal.timeout(ms); } catch (e) { /* fallthrough */ }
    var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal;
  }
  async function parse(res) {
    var json = null;
    try { json = await res.json(); } catch (e) { throw new ApiError('bad_response', 'サーバーの応答を解釈できませんでした（' + res.status + '）。'); }
    if (!json || json.ok !== true) {
      var err = (json && json.error) || { code: 'unknown', message: '不明なエラーです。' };
      throw new ApiError(err.code || 'unknown', err.message || '不明なエラーです。', err.details);
    }
    return json.data;
  }
  /** POST action */
  async function request(action, params, opts) {
    opts = opts || {};
    if (!isConfigured()) throw new ApiError('no_api', 'APIのURLが設定されていません（config.js の apiUrl）。');
    var body = Object.assign({ action: action }, params || {});
    if (opts.auth !== false) {
      var token = tokenProvider();
      if (!token) throw new ApiError('unauthorized', 'ログインが必要です。');
      body.token = token;
    }
    var res;
    try {
      res = await fetch(cfg.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body), redirect: 'follow', signal: signal(opts.timeout || 30000) });
    } catch (e) {
      throw new ApiError('network', '通信できませんでした。電波状況を確認してください。');
    }
    return parse(res);
  }
  /** GET action（認証不要の商品照会など） */
  async function get(action, params, opts) {
    opts = opts || {};
    if (!isConfigured()) throw new ApiError('no_api', 'APIのURLが設定されていません（config.js の apiUrl）。');
    var q = Object.assign({ action: action }, params || {});
    var qs = Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
    var res;
    try { res = await fetch(cfg.apiUrl + (cfg.apiUrl.indexOf('?') >= 0 ? '&' : '?') + qs, { method: 'GET', redirect: 'follow', signal: signal(opts.timeout || 30000) }); }
    catch (e) { throw new ApiError('network', '通信できませんでした。電波状況を確認してください。'); }
    return parse(res);
  }
  return {
    ApiError: ApiError, isConfigured: isConfigured, request: request, get: get,
    setTokenProvider: function (fn) { tokenProvider = fn; },
    isNetworkError: function (e) { return !!e && (e.code === 'network' || e.code === 'bad_response'); }
  };
})();
