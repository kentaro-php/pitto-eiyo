/* ============================================================================
 * Auth.gs — 認証（設計書 9節 呼び出し規約2）
 *  - 本番: フロント（Google Identity Services）が得た ID トークンを body.token で受け取り、
 *          https://oauth2.googleapis.com/tokeninfo で検証。aud がこのアプリの Client ID か確認。
 *          検証結果は CacheService に有効期限まで保存する。
 *  - 開発: スクリプトプロパティ AUTH_MODE=dev のとき、token が DEV_TOKEN（既定 "dev"）に一致すれば
 *          固定ユーザーとして扱う（ログイン実装前に自分専用で動作確認するため。公開前に必ず google に戻す）。
 *  - 利用者の制限: ALLOWED_EMAILS（カンマ区切り）/ ALLOWED_DOMAINS（例 example.co.jp）を設定すると、それ以外は forbidden。
 *  - 長期セッション: ID トークンは 1 時間で切れて毎回ログインになるので、auth.session で "ps_…" のセッショントークンを発行し
 *          sessions タブに保存する（既定 90 日 = SESSION_DAYS、設定画面のログアウトで無効化）。以後の呼び出しは token にこれを渡す。
 *          セッションでも ALLOWED_EMAILS / ALLOWED_DOMAINS は毎回確認する（許可リストから外せば即座に使えなくなる）。
 * ========================================================================== */
var Auth = (function () {
  var SESSION_PREFIX = 'ps_';
  function isSessionToken(token) { return str_(token).indexOf(SESSION_PREFIX) === 0; }
  function authenticate(token) {
    var mode = prop_('AUTH_MODE', 'google');
    if (mode === 'dev') return devUser_(token);
    token = str_(token).trim();
    if (!token) throw new ApiError('unauthorized', 'ログインが必要です。');
    if (isSessionToken(token)) return sessionUser_(token);
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
  /* ---------- 長期セッション ---------- */
  function sessionDays_() { var d = Number(prop_('SESSION_DAYS', '90')); return d > 0 && d <= 365 ? d : 90; }
  function sessionId_(token) { return sha256Hex_(token); }
  function sessionUser_(token) {
    var cache = CacheService.getScriptCache();
    var key = 'sess:' + sessionId_(token);
    var hit = cache.get(key);
    var user = hit ? JSON.parse(hit) : null;
    if (!user) {
      var id = sessionId_(token);
      var row = Db.findOne('sessions', function (r) { return r.id === id && !r.deleted_at; });
      if (!row || !(new Date(row.expires_at).getTime() > Date.now())) throw new ApiError('unauthorized', 'ログインの有効期限が切れました。もう一度ログインしてください。');
      user = { id: str_(row.user_id), email: str_(row.email).toLowerCase(), name: str_(row.display_name), picture: str_(row.picture) };
      touchSession_(row);
      cache.put(key, JSON.stringify(user), 900); // 15 分。ログアウト・退会時は明示的に消す
    }
    checkAllowed_(user);
    return user;
  }
  /** 最終利用日を 1 日 1 回だけ更新する（読み出し API のたびにシートへ書かないため）。
   *  認証段階（ロック外）から呼ばれるので、ロックを待たずに試し、取れなければ次回に回す（退会の deleteWhere と重ならないように） */
  function touchSession_(row) {
    var today = nowIso_().slice(0, 10);
    if (str_(row.last_used_at).slice(0, 10) === today) return;
    try {
      Db.tryWithLock(function () {
        var fresh = Db.findOne('sessions', function (r) { return r.id === row.id && !r.deleted_at; });
        if (!fresh) return;
        fresh.last_used_at = nowIso_(); Db.update('sessions', fresh);
      });
    } catch (e) { /* noop */ }
  }
  /** POST auth.session — Google の ID トークンで認証済みの利用者に長期セッションを発行する。
   *  セッショントークンからの再発行は不可（漏れたトークンで期限を無限に延ばせないように） */
  function createSession(params, ctx) {
    if (isSessionToken(params && params.token)) throw new ApiError('forbidden', 'セッションの再発行には Google ログインが必要です。');
    var token = SESSION_PREFIX + (uuid_() + uuid_()).replace(/-/g, '');
    var now = nowIso_();
    var exp = Utilities.formatDate(new Date(Date.now() + sessionDays_() * 86400000), TZ, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
    cleanupSessions_();
    Db.insert('sessions', { id: sessionId_(token), user_id: ctx.user.id, email: ctx.user.email || '', display_name: ctx.user.name || '', picture: ctx.user.picture || '', created_at: now, expires_at: exp, last_used_at: now, deleted_at: '' });
    return { session: token, expires_at: exp, days: sessionDays_(), user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name } };
  }
  /** POST auth.signout — このセッションを無効化する（ID トークンで呼ばれたときは何もしない） */
  function revokeSession(params, ctx) {
    var token = str_(params.token).trim();
    if (!isSessionToken(token)) return { revoked: false };
    var id = sessionId_(token);
    var row = Db.findOne('sessions', function (r) { return r.id === id && !r.deleted_at; });
    if (row) { row.deleted_at = nowIso_(); Db.update('sessions', row); }
    try { CacheService.getScriptCache().remove('sess:' + id); } catch (e) { /* noop */ }
    return { revoked: !!row };
  }
  /** 発行のついでに、無効化済み・期限切れのセッション行を物理削除する（溜まり続けないように） */
  function cleanupSessions_() {
    var now = Date.now();
    try { Db.deleteWhere('sessions', function (r) { return !!r.deleted_at || !(new Date(r.expires_at).getTime() > now); }); } catch (e) { /* noop */ }
  }
  /** 退会時: 本人のセッションをすべて物理削除し、キャッシュも消す */
  function purgeSessionsOf(userId) {
    var ids = Db.findAll('sessions', function (r) { return r.user_id === userId; }).map(function (r) { return r.id; });
    try { var cache = CacheService.getScriptCache(); ids.forEach(function (id) { cache.remove('sess:' + id); }); } catch (e) { /* noop */ }
    return Db.deleteWhere('sessions', function (r) { return r.user_id === userId; });
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
  return { authenticate: authenticate, isAdmin: isAdmin, isSessionToken: isSessionToken, createSession: createSession, revokeSession: revokeSession, purgeSessionsOf: purgeSessionsOf };
})();
