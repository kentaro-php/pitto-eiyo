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
