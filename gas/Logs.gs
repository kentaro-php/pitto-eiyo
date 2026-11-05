/* ============================================================================
 * Logs.gs — 食事記録（設計書 6節: 登録時点の栄養5項目をスナップショットで保持）
 * ========================================================================== */
var Logs = (function () {
  var L = function () { return PittoLogic; };

  function pub(l) {
    if (!l) return null;
    var out = {
      id: l.id, client_id: l.client_id || '', product_id: l.product_id, product_name: l.product_name || '',
      date: l.date, time: timeOf_(l), eaten_at: l.eaten_at, meal_type: l.meal_type, amount_mode: l.amount_mode,
      amount: L().num(l.amount) || 0, amount_label: l.amount_label || '', created_at: l.created_at || '', updated_at: l.updated_at || ''
    };
    L().KEYS.forEach(function (k) { out[k] = L().num(l[k]) || 0; });
    return out;
  }
  function timeOf_(l) { var m = str_(l.eaten_at).match(/T(\d{2}:\d{2})/); return m ? m[1] : ''; }
  function own_(userId, id) {
    id = str_(id);
    return id ? Db.findOne('food_logs', function (r) { return r.id === id && r.user_id === userId && !r.deleted_at; }) : null;
  }
  function validateCommon_(p, existing) {
    var date = str_(p.date || (existing && existing.date));
    if (!L().isValidDate(date)) throw new ApiError('validation', '日付の形式が正しくありません（YYYY-MM-DD）。', { field: 'date' });
    var today = todayJst_();
    if (date > L().addDays(today, 1) || date < L().addDays(today, -400)) throw new ApiError('validation', '日付が範囲外です。', { field: 'date' });
    var time = str_(p.time || (existing && timeOf_(existing)));
    if (!time) time = date === today ? nowTimeJst_() : '12:00';
    if (!L().isValidTime(time)) throw new ApiError('validation', '時刻の形式が正しくありません（HH:MM）。', { field: 'time' });
    var meal = str_(p.meal_type || (existing && existing.meal_type));
    if (!L().MEAL_NAME[meal]) meal = L().mealByHour(Number(time.slice(0, 2)));
    var mode = str_(p.amount_mode || (existing && existing.amount_mode));
    if (L().AMOUNT_MODES.indexOf(mode) < 0) throw new ApiError('validation', '量の指定方法が不正です。', { field: 'amount_mode' });
    var amount = L().num(p.amount !== undefined ? p.amount : (existing && existing.amount));
    if (!(amount > 0) || amount > 5000) throw new ApiError('validation', '量を正しく入力してください。', { field: 'amount' });
    return { date: date, time: time, meal_type: meal, amount_mode: mode, amount: amount };
  }

  /** POST log.create — client_id で冪等化（オフラインキューの再送で二重登録しない） */
  function create(params, ctx) {
    var user = ctx.user;
    var clientId = str_(params.client_id).trim();
    if (!clientId || clientId.length > 64) throw new ApiError('validation', 'client_id が必要です。', { field: 'client_id' });
    var dup = Db.findOne('food_logs', function (r) { return r.user_id === user.id && r.client_id === clientId; });
    if (dup) return { log: pub(dup), daily_summary: Summary.getOrCompute(user, dup.date), duplicate: true };
    var product = Products.visibleById(params.product_id, ctx);
    if (!product) throw new ApiError('not_found', '商品が見つかりません。', { field: 'product_id' });
    var v = validateCommon_(params, null);
    var factor = L().factorFor(product, v.amount_mode, v.amount);
    if (factor == null) throw new ApiError('validation', 'この商品ではその量の指定方法が使えません（内容量が未登録）。', { field: 'amount_mode' });
    var n = L().scaleN(product, factor);
    var now = nowIso_();
    var log = {
      id: uuid_(), client_id: clientId, user_id: user.id, product_id: product.id, product_name: product.name,
      date: v.date, eaten_at: v.date + 'T' + v.time + ':00+09:00', meal_type: v.meal_type, amount_mode: v.amount_mode, amount: v.amount,
      amount_label: L().amountLabel(product, v.amount_mode, v.amount),
      energy_kcal: n.energy_kcal, protein_g: n.protein_g, fat_g: n.fat_g, carb_g: n.carb_g, salt_g: n.salt_g,
      created_at: now, updated_at: now, deleted_at: ''
    };
    Db.insert('food_logs', log);
    return { log: pub(log), daily_summary: Summary.recompute(user, v.date), duplicate: false };
  }

  /** POST log.update — 日付・時刻・区分・量の変更。栄養値は商品マスタの現在値から再計算 */
  function update(params, ctx) {
    var user = ctx.user;
    var log = own_(user.id, params.id);
    if (!log) throw new ApiError('not_found', '記録が見つかりません。');
    var v = validateCommon_(params, log);
    var product = Products.byId(log.product_id);
    var n;
    if (product) {
      var factor = L().factorFor(product, v.amount_mode, v.amount);
      if (factor == null) throw new ApiError('validation', 'この商品ではその量の指定方法が使えません。', { field: 'amount_mode' });
      n = L().scaleN(product, factor);
      log.amount_label = L().amountLabel(product, v.amount_mode, v.amount);
    } else {
      if (v.amount_mode !== log.amount_mode) throw new ApiError('validation', '商品マスタに無い商品は量の指定方法を変えられません。');
      var ratio = v.amount / (L().num(log.amount) || 1);
      n = L().scaleN(log, ratio);
      log.amount_label = L().amountLabel({ quantity_text: '' }, v.amount_mode, v.amount);
    }
    var oldDate = log.date;
    log.date = v.date; log.eaten_at = v.date + 'T' + v.time + ':00+09:00'; log.meal_type = v.meal_type;
    log.amount_mode = v.amount_mode; log.amount = v.amount;
    L().KEYS.forEach(function (k) { log[k] = n[k]; });
    log.updated_at = nowIso_();
    Db.update('food_logs', log);
    var summary = Summary.recompute(user, log.date);
    if (oldDate !== log.date) Summary.recompute(user, oldDate);
    return { log: pub(log), daily_summary: summary };
  }

  /** POST log.delete — 論理削除 */
  function remove(params, ctx) {
    var user = ctx.user;
    var log = own_(user.id, params.id);
    if (!log) throw new ApiError('not_found', '記録が見つかりません。');
    log.deleted_at = nowIso_(); log.updated_at = log.deleted_at;
    Db.update('food_logs', log);
    return { id: log.id, daily_summary: Summary.recompute(user, log.date) };
  }

  /** POST logs.list — from〜to（両端含む、最大366日） */
  function list(params, ctx) {
    var from = str_(params.from), to = str_(params.to || params.from);
    if (!L().isValidDate(from) || !L().isValidDate(to) || from > to) throw new ApiError('validation', '期間の指定が正しくありません。');
    if (L().parseDate(to) - L().parseDate(from) > 366 * 86400000) throw new ApiError('validation', '期間が長すぎます（最大366日）。');
    return { logs: listRange(ctx.user.id, from, to).map(pub) };
  }
  function listRange(userId, from, to) {
    var rows = Db.findAll('food_logs', function (r) { return r.user_id === userId && !r.deleted_at && r.date >= from && r.date <= to; });
    rows.sort(function (a, b) { return str_(a.eaten_at).localeCompare(str_(b.eaten_at)) || str_(a.created_at).localeCompare(str_(b.created_at)); });
    return rows;
  }
  return { pub: pub, create: create, update: update, remove: remove, list: list, listRange: listRange };
})();
