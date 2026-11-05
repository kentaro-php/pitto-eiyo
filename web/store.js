/* ピッと栄養 ローカルキャッシュ（localStorage）
 *  - 直近の記録・商品・目標を端末に持ち、起動直後はキャッシュで表示してから同期する。
 *  - オフライン中の操作は queue に積み、つながったら API へ送る（client_id で冪等）。 */
window.PittoStore = (function () {
  'use strict';
  var KEY = 'pitto.data.v1';
  var S = blank();
  function blank() { return { logs: [], products: {}, profile: null, targets: null, queue: [], lastSync: null, range: null, months: {}, userKey: null }; }
  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && typeof o === 'object') S = Object.assign(blank(), o);
    } catch (e) { S = blank(); }
    return S;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* 容量超過などは無視 */ } }
  function reset() { S = blank(); try { localStorage.removeItem(KEY); } catch (e) { /* noop */ } }
  /** 別のアカウントでログインしたらキャッシュを捨てる */
  function bindUser(key) { if (S.userKey && S.userKey !== key) { reset(); } S.userKey = key; save(); }
  function upsertProduct(p) { if (p && p.id) { S.products[p.id] = p; trimProducts(); } }
  function trimProducts() {
    var ids = Object.keys(S.products);
    if (ids.length <= 300) return;
    ids.sort(function (a, b) { return String(S.products[a].updated_at || '').localeCompare(String(S.products[b].updated_at || '')); });
    ids.slice(0, ids.length - 300).forEach(function (id) { delete S.products[id]; });
  }
  function productByJan(jan) {
    var ids = Object.keys(S.products);
    for (var i = 0; i < ids.length; i++) if (S.products[ids[i]].jan === jan) return S.products[ids[i]];
    return null;
  }
  function productById(id) { return S.products[id] || null; }
  function removeProduct(id) { delete S.products[id]; }
  function logsForDate(date) { return S.logs.filter(function (l) { return l.date === date; }); }
  function hasDate(date) { return !!(S.range && date >= S.range.from && date <= S.range.to); }
  /** サーバーから取り込んだ期間の記録で置き換える（送信待ちのローカル記録は残す） */
  function setLogs(range, logs) {
    var pending = S.logs.filter(function (l) { return l.pending; });
    var ids = {}; logs.forEach(function (l) { ids[l.client_id || l.id] = true; });
    S.logs = logs.concat(pending.filter(function (l) { return !ids[l.client_id]; }));
    S.range = range;
  }
  function addLog(log) { S.logs.push(log); }
  function removeLog(id) { S.logs = S.logs.filter(function (l) { return l.id !== id && l.client_id !== id; }); }
  function replaceLog(clientId, log) { S.logs = S.logs.map(function (l) { return l.client_id === clientId ? log : l; }); }
  function enqueue(op) { S.queue.push(op); save(); }
  function dequeue(op) { S.queue = S.queue.filter(function (o) { return o !== op && o.key !== op.key; }); save(); }
  return {
    get S() { return S; },
    load: load, save: save, reset: reset, bindUser: bindUser,
    upsertProduct: upsertProduct, removeProduct: removeProduct, productByJan: productByJan, productById: productById,
    logsForDate: logsForDate, hasDate: hasDate, setLogs: setLogs, addLog: addLog, removeLog: removeLog, replaceLog: replaceLog,
    enqueue: enqueue, dequeue: dequeue
  };
})();
