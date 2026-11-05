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
    'product.delete':  { fn: Products.remove,  auth: true,  write: true },
    'products.recent': { fn: Products.recent,  auth: true },
    'products.search': { fn: Products.search,  auth: true },
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
    'auth.session':    { fn: Auth.createSession,  auth: true, write: true },
    'auth.signout':    { fn: Auth.revokeSession,  auth: true, write: true },
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
  var modules = ['PittoLogic', 'Db', 'Auth', 'Products', 'Foods', 'External', 'Logs', 'Summary', 'Profile', 'Sync', 'Ocr'];
  var missing = modules.filter(function (m) { try { return typeof eval(m) !== 'object' && typeof eval(m) !== 'function'; } catch (e) { return true; } });
  var T = PittoLogic.computeTargets({ sex: 'm', birth_year: 1986, weight_kg: 70, activity_level: 'normal' }, 2026);
  var result = {
    version: API_VERSION,
    modules_ok: missing.length === 0, missing: missing,
    logic_ok: T.kcal === 2760 && PittoLogic.eanValid('4901234567894'),
    tables: Object.keys(Db.SCHEMA),
    auth_mode: prop_('AUTH_MODE', 'google'),
    properties_set: ['GOOGLE_CLIENT_ID', 'CLAUDE_API_KEY', 'GEMINI_API_KEY', 'YAHOO_CLIENT_ID', 'ALLOWED_EMAILS', 'ADMIN_EMAILS', 'SPREADSHEET_ID'].filter(function (k) { return !!prop_(k); }),
    foods_registered: (function () { try { return Db.findAll('products', function (r) { return r.source === 'food' && !r.deleted_at; }).length; } catch (e) { return -1; } })(),
    timezone: TZ, today: todayJst_()
  };
  result.ok = result.modules_ok && result.logic_ok;
  try { console.log(JSON.stringify(result)); } catch (e) { /* noop */ }
  return result;
}
