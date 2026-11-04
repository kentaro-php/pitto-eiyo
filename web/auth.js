/* ピッと栄養 認証（Google Identity Services）
 *  - config.googleClientId があれば Google ログイン（ID トークンを API に渡す）。無ければ開発モード（devToken）。
 *  - ID トークンは約1時間で切れる。期限が来たら再ログイン（auto_select で静かに再取得を試みる）。 */
window.PittoAuth = (function () {
  'use strict';
  var cfg = window.PITTO_CONFIG || {};
  var KEY = 'pitto.auth.v1';
  var listeners = [];
  var state = { mode: cfg.googleClientId ? 'google' : 'dev', user: null, token: null, exp: 0, ready: false, message: '' };
  var expireTimer = null;

  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && o.token && o.exp > Date.now() / 1000 + 30) { state.token = o.token; state.exp = o.exp; state.user = o.user; }
    } catch (e) { /* noop */ }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ token: state.token, exp: state.exp, user: state.user })); } catch (e) { /* noop */ } }
  function parseJwt(t) {
    var p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var bin = atob(p + '==='.slice((p.length + 3) % 4));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function emit() { listeners.forEach(function (fn) { try { fn(state); } catch (e) { console.error(e); } }); }
  function isValid() { return !!state.token && state.exp > Date.now() / 1000 + 30; }
  function scheduleExpiry() {
    clearTimeout(expireTimer);
    if (!isFinite(state.exp) || !state.token) return;
    var ms = Math.max(1000, (state.exp - 30) * 1000 - Date.now());
    expireTimer = setTimeout(expire, Math.min(ms, 2147000000));
  }
  function expire() {
    if (state.mode === 'dev') return;
    state.token = null; state.exp = 0; save();
    state.message = 'ログインの有効期限が切れました。もう一度ログインしてください。';
    emit();
    prompt();
  }
  function onCredential(resp) {
    try {
      var payload = parseJwt(resp.credential);
      state.token = resp.credential; state.exp = Number(payload.exp) || (Date.now() / 1000 + 3000);
      state.user = { sub: payload.sub, email: payload.email || '', name: payload.name || '', picture: payload.picture || '' };
      state.message = '';
      save(); scheduleExpiry(); emit();
    } catch (e) {
      state.message = 'ログイン情報を読み取れませんでした。'; emit();
    }
  }
  function whenGisReady(fn) {
    var tries = 0;
    (function poll() {
      if (window.google && google.accounts && google.accounts.id) return fn();
      if (++tries > 75) { state.message = 'Googleログインを読み込めませんでした。通信状態を確認して再読み込みしてください。'; emit(); return; }
      setTimeout(poll, 200);
    })();
  }
  function renderButton() {
    var el = document.getElementById('gsi-button');
    if (!el || !(window.google && google.accounts && google.accounts.id)) return;
    el.innerHTML = '';
    google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ja', width: 280 });
  }
  function prompt() { try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.prompt(); } catch (e) { /* noop */ } }
  function init(onChange) {
    if (onChange) listeners.push(onChange);
    if (state.mode === 'dev') {
      state.token = cfg.devToken || 'dev'; state.exp = Infinity; state.ready = true;
      state.user = { sub: 'dev', email: 'dev@example.com', name: '開発ユーザー', picture: '', dev: true };
      emit();
      return;
    }
    load();
    state.ready = true;
    if (isValid()) { scheduleExpiry(); emit(); } else { state.token = null; emit(); }
    whenGisReady(function () {
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onCredential, auto_select: true, itp_support: true, use_fedcm_for_prompt: true });
      renderButton();
      if (!isValid()) prompt();
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && state.ready && !isValid() && state.exp) expire(); });
  }
  function signOut() {
    try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) { /* noop */ }
    state.token = null; state.user = null; state.exp = 0; state.message = '';
    try { localStorage.removeItem(KEY); } catch (e) { /* noop */ }
    emit();
  }
  return {
    init: init, isValid: isValid, signOut: signOut, expire: expire, renderButton: renderButton, prompt: prompt,
    token: function () { return isValid() ? state.token : null; },
    user: function () { return state.user; }, mode: function () { return state.mode; }, message: function () { return state.message; }
  };
})();
