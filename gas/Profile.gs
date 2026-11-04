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
