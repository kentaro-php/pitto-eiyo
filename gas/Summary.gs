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
