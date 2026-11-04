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
