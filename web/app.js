/* ピッと栄養 画面制御（UI）。計算は logic.js、通信は api.js、保存は store.js、カメラは scanner.js。 */
(function () {
  'use strict';
  var L = window.PittoLogic, Api = window.PittoApi, Auth = window.PittoAuth, Store = window.PittoStore, Scanner = window.PittoScanner;
  var cfg = window.PITTO_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var NUT = L.LABELS, MEALS = L.MEALS, BASIS_NAME = L.BASIS_NAME;
  var VIEWS = ['home', 'scan', 'search', 'product', 'register', 'month', 'goal'];

  /* ---------- 小物 ---------- */
  function todayStr() { return L.dateStr(new Date()); }
  function nowTime() { var d = new Date(); return L.pad(d.getHours()) + ':' + L.pad(d.getMinutes()); }
  function fmt(n, d) { return L.fmt(n, d); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { try { return crypto.randomUUID(); } catch (e) { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } }
  var toastTimer = null;
  function sourceTag(p, short) {
    if (p.source === 'off') return '<span class="tag off">' + (short ? 'OFF' : 'Open Food Facts') + '</span>';
    if (p.source === 'web') return '<span class="tag web">' + (short ? 'ウェブ' : 'ウェブ検索・要確認') + '</span>';
    if (p.source === 'food') return '<span class="tag off">' + (short ? '成分表' : '食品標準成分表（八訂）') + '</span>';
    if (L.isCustomJan(p.jan)) return '<span class="tag">' + (short ? '手入力' : 'バーコードなし・手入力') + '</span>';
    return '';
  }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600); }
  function chipHtml(j) { return '<span class="st ' + j.s + '">' + esc(j.t) + '</span>'; }
  function targets() { return Store.S.targets || L.computeTargets(Store.S.profile || {}, new Date().getFullYear()); }
  function online() { return navigator.onLine !== false; }
  function setMsg(id, msg, kind) { var el = $(id); if (!el) return; el.textContent = msg || ''; el.className = kind === 'err' ? 'err' : kind === 'ok' ? 'okmsg' : kind === 'warn' ? 'warnmsg' : 'hint'; }

  var state = {
    authed: false, syncing: false, homeDate: todayStr(), month: todayStr().slice(0, 7),
    product: null, jan: null, hint: null, editId: null, selLog: null, amount: { mode: 'package', amount: 1 }, meal: 'lunch', keepDate: false, ocrUsed: false, hintUsed: false,
    extra: {}, view: 'home'
  };

  /* ---------- 認証と起動 ---------- */
  Api.setTokenProvider(Auth.token);
  function onAuth() {
    var authed = Auth.isValid();
    state.authed = authed;
    $('login-status').textContent = Auth.message() || (Auth.mode() === 'dev' ? '' : '');
    if (!authed) { Scanner.stop(); showLogin(); return; }
    var u = Auth.user() || {};
    Store.load();
    Store.bindUser(u.sub || u.email || 'dev');
    $('view-login').hidden = true; $('tabbar').hidden = false;
    route();
    sync();
  }
  function showLogin() {
    VIEWS.forEach(function (v) { $('view-' + v).hidden = true; });
    $('tabbar').hidden = true;
    $('view-login').hidden = false;
    if (Auth.mode() === 'google') Auth.renderButton();
    else $('login-status').textContent = '開発モード（config.js に googleClientId がありません）';
  }
  function handleApiError(e, opts) {
    opts = opts || {};
    if (!e) return;
    if (e.code === 'unauthorized') { Auth.expire(); return; }
    if (e.code === 'no_api') { if (!opts.silent) toast('APIのURLが未設定です（config.js）'); return; }
    if (Api.isNetworkError(e)) { if (!opts.silent) toast('通信できませんでした。記録は端末に保存されています。'); return; }
    if (!opts.silent) toast(e.message || 'エラーが起きました');
  }

  /* ---------- 同期（起動時・復帰時・オンライン復帰時） ---------- */
  async function sync() {
    if (!state.authed || !Api.isConfigured() || !online() || state.syncing) { renderSyncStatus(); return; }
    state.syncing = true; renderSyncStatus();
    try {
      await flushQueue();
      var data = await Api.request('sync.bootstrap', { days: cfg.syncDays || 35 });
      Store.setLogs(data.range, data.logs);
      (data.products || []).forEach(Store.upsertProduct);
      Store.S.profile = data.profile; Store.S.targets = data.targets; Store.S.lastSync = data.now; Store.S.user = data.user; Store.S.months = {};
      Store.save();
      rerender();
    } catch (e) { handleApiError(e, { silent: true }); }
    finally { state.syncing = false; renderSyncStatus(); }
  }
  async function flushQueue() {
    var q = Store.S.queue.slice();
    for (var i = 0; i < q.length; i++) {
      var op = q[i];
      try {
        if (op.type === 'log.create') {
          var data = await Api.request('log.create', op.params);
          Store.replaceLog(op.params.client_id, data.log);
        } else if (op.type === 'log.delete') {
          try { await Api.request('log.delete', { id: op.id }); } catch (e2) { if (e2.code !== 'not_found') throw e2; }
        }
        Store.dequeue(op);
        Store.S.months = {};
      } catch (e) {
        if (Api.isNetworkError(e) || e.code === 'busy') break;           // つながったら再送
        if (e.code === 'unauthorized') throw e;
        Store.dequeue(op);                                                 // 検証エラー等は破棄
        if (op.type === 'log.create') Store.removeLog(op.params.client_id);
        toast('送信できなかった記録があります: ' + (e.message || e.code));
      }
    }
    Store.save();
  }
  function renderSyncStatus() {
    var el = $('home-sync'); if (!el) return;
    var pending = Store.S.queue.length;
    el.innerHTML = state.syncing ? '<span class="spin"></span>同期中' : !Api.isConfigured() ? 'API未設定' : !online() ? 'オフライン' : pending ? '送信待ち ' + pending + '件' : (Store.S.lastSync ? '同期済み' : '');
  }

  /* ---------- 画面遷移（hash） ---------- */
  function route() {
    if (!state.authed) { showLogin(); return; }
    var v = (location.hash || '#home').slice(1);
    if (VIEWS.indexOf(v) < 0) v = 'home';
    if (v === 'product' && !state.product) v = 'home';
    if (v === 'register' && !state.jan && !state.editId) v = 'home';
    showView(v);
  }
  function goto(v) { if (('#' + v) === location.hash) route(); else location.hash = v; }
  function showView(v) {
    if (state.view === 'scan' && v !== 'scan') Scanner.stop();
    state.view = v;
    VIEWS.forEach(function (n) { $('view-' + n).hidden = (n !== v); });
    $('view-login').hidden = true;
    var tabView = (v === 'month' || v === 'goal') ? v : 'home';
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { if (t.dataset.view === tabView) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
    rerender();
    window.scrollTo(0, 0);
  }
  function rerender() {
    var v = state.view;
    if (v === 'home') renderHome();
    if (v === 'scan') renderScan();
    if (v === 'search') renderSearch();
    if (v === 'product') renderProduct();
    if (v === 'register') renderRegister();
    if (v === 'month') renderMonth();
    if (v === 'goal') renderGoal();
  }
  window.addEventListener('hashchange', route);

  /* ---------- ホーム ---------- */
  function logsFor(date) {
    if (Store.hasDate(date)) return Store.logsForDate(date);
    if (state.extra[date]) return state.extra[date].concat(Store.logsForDate(date).filter(function (l) { return l.pending; }));
    fetchExtra(date);
    return Store.logsForDate(date);
  }
  var fetching = {};
  async function fetchExtra(date) {
    if (fetching[date] || !state.authed || !online() || !Api.isConfigured()) return;
    fetching[date] = true;
    try { var d = await Api.request('logs.list', { from: date, to: date }); state.extra[date] = d.logs; if (state.view === 'home' && state.homeDate === date) renderHome(); }
    catch (e) { handleApiError(e, { silent: true }); }
    finally { fetching[date] = false; }
  }
  function renderHome() {
    var date = state.homeDate, today = todayStr(), isToday = date === today;
    var T = targets(), logs = logsFor(date), tot = L.totals(logs), j = L.judge(tot, T, isToday), ov = L.overall(j, tot, isToday);
    $('home-date').textContent = L.fmtDateJP(date) + (isToday ? '（今日）' : '');
    $('today-btn').setAttribute('aria-pressed', String(isToday));
    $('next-day').disabled = date >= today;
    $('home-side').textContent = tot.count ? tot.count + '件' : '';
    $('home-summary').innerHTML =
      '<div class="big">' + fmt(tot.energy_kcal, 0) + ' <small>/ ' + fmt(T.kcal, 0) + ' kcal</small> ' + chipHtml(ov) + '</div>' +
      '<div>' + esc(L.summarize(j, tot, isToday)) + '</div>';
    $('home-nutrients').innerHTML = NUT.map(function (n) {
      var v = tot[n.k], tgt, upper, zoneL, zoneW;
      if (n.k === 'energy_kcal') { tgt = fmt(T.kcal, 0) + ' kcal'; upper = T.kcal * 1.1; zoneL = 0.9 / 1.1; zoneW = 0.2 / 1.1; }
      else if (n.k === 'salt_g') { tgt = fmt(T.salt, 1) + ' g 未満'; upper = T.salt; zoneL = 0; zoneW = 1; }
      else { var rk = { protein_g: 'p', fat_g: 'f', carb_g: 'c' }[n.k]; tgt = fmt(T[rk][0], 0) + '〜' + fmt(T[rk][1], 0) + ' g'; upper = T[rk][1]; zoneL = T[rk][0] / T[rk][1]; zoneW = 1 - zoneL; }
      var fill = Math.min(1, upper > 0 ? v / upper : 0);
      var cls = j[n.k].s === 'over' ? 'over' : (j[n.k].s === 'ok' ? 'ok' : '');
      return '<div class="nut"><span class="n">' + n.label + '</span><span class="v">' + fmt(v, n.d) + ' / ' + tgt + '</span>' + chipHtml(j[n.k]) +
        '<div class="bar"><span class="zone" style="left:' + (zoneL * 100).toFixed(1) + '%;width:' + (zoneW * 100).toFixed(1) + '%"></span><span class="fill ' + cls + '" style="width:' + (fill * 100).toFixed(1) + '%"></span></div></div>';
    }).join('');
    $('home-hint').hidden = T.hasProfile;
    renderHomeLogs(logs);
    renderSyncStatus();
  }
  function renderHomeLogs(logs) {
    logs = logs.slice().sort(function (a, b) { return String(a.eaten_at || '').localeCompare(String(b.eaten_at || '')); });
    if (!logs.length) { $('home-logs').innerHTML = '<p class="hint">この日の記録はありません。</p>'; return; }
    var html = '';
    MEALS.forEach(function (m) {
      var ls = logs.filter(function (l) { return l.meal_type === m[0]; });
      if (!ls.length) return;
      var sub = 0; ls.forEach(function (l) { sub += Number(l.energy_kcal) || 0; });
      html += '<div class="grp"><span>' + m[1] + '</span><span>' + fmt(sub, 0) + ' kcal</span></div><div class="list">';
      ls.forEach(function (l) {
        var key = l.id || l.client_id, sel = state.selLog === key;
        html += '<button type="button" class="item' + (sel ? ' sel' : '') + (l.pending ? ' pending' : '') + '" data-log="' + esc(key) + '"><span class="name">' + esc(l.product_name) +
          '<div class="sub">' + esc(l.amount_label) + ' · ' + esc(l.time || '') + ' · P ' + fmt(l.protein_g, 1) + ' / F ' + fmt(l.fat_g, 1) + ' / C ' + fmt(l.carb_g, 1) + ' / 塩 ' + fmt(l.salt_g, 1) + '</div></span>' +
          (sel ? '<span class="mini" data-del="' + esc(key) + '">消去</span>' : '<span class="val">' + fmt(l.energy_kcal, 0) + ' kcal</span>') + '</button>';
      });
      html += '</div>';
    });
    $('home-logs').innerHTML = html;
  }
  $('home-logs').addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]');
    if (del) { deleteLog(del.getAttribute('data-del')); return; }
    var it = e.target.closest('[data-log]');
    if (it) { var k = it.getAttribute('data-log'); state.selLog = state.selLog === k ? null : k; renderHome(); }
  });
  async function deleteLog(key) {
    var log = Store.S.logs.filter(function (l) { return l.id === key || l.client_id === key; })[0];
    state.selLog = null;
    if (!log) { if (state.extra[state.homeDate]) { state.extra[state.homeDate] = state.extra[state.homeDate].filter(function (l) { return l.id !== key; }); } }
    Store.removeLog(key);
    if (log && log.pending) { Store.S.queue = Store.S.queue.filter(function (op) { return !(op.type === 'log.create' && op.params.client_id === log.client_id); }); }
    else { Store.enqueue({ type: 'log.delete', id: key, key: 'del:' + key }); }
    Store.S.months = {};
    Store.save(); renderHome(); toast('記録を消去しました');
    try { await flushQueue(); } catch (e) { handleApiError(e); }
    renderHome();
  }
  $('prev-day').addEventListener('click', function () { state.homeDate = L.addDays(state.homeDate, -1); state.selLog = null; renderHome(); });
  $('next-day').addEventListener('click', function () { if (state.homeDate < todayStr()) { state.homeDate = L.addDays(state.homeDate, 1); state.selLog = null; renderHome(); } });
  $('today-btn').addEventListener('click', function () { state.homeDate = todayStr(); state.selLog = null; renderHome(); });
  $('go-scan').addEventListener('click', function () { goto('scan'); });
  $('go-manual').addEventListener('click', function () { state.noCamera = true; goto('scan'); setTimeout(function () { $('jan-input').focus(); }, 50); });
  $('go-recent').addEventListener('click', function () { state.noCamera = true; goto('scan'); setTimeout(function () { $('recent-list').scrollIntoView({ block: 'start' }); }, 50); });
  $('go-search').addEventListener('click', function () { goto('search'); });
  /** バーコードの無い商品（パン屋・惣菜・外食など）を手入力で登録。jan は custom:new で送り、サーバが custom:<id> を振る */
  function startCustom() { state.jan = 'custom:new'; state.editId = null; state.hint = null; goto('register'); }
  $('go-custom').addEventListener('click', startCustom);
  $('scan-custom').addEventListener('click', startCustom);

  /* ---------- 料理・食品の検索 ---------- */
  var searchTimer = null, searchSeq = 0, lastSearched = '';
  function renderSearch() {
    var q = $('search-input').value.trim();
    if (q && q !== lastSearched) runSearch(q); else if (!q) { $('search-list').innerHTML = ''; lastSearched = ''; }
    setTimeout(function () { $('search-input').focus(); }, 50);
  }
  function foodItemHtml(p) {
    return '<button type="button" class="item" data-pid="' + esc(p.id) + '"><span class="name">' + esc(p.name) + sourceTag(p, true) + '<div class="sub">' + esc(p.quantity_text || '') + (p.quantity_text ? ' · ' : '') + BASIS_NAME[p.serving_basis] + 'あたり ' + fmt(p.energy_kcal, 0) + ' kcal</div></span><span class="val">›</span></button>';
  }
  function localSearch(q) {
    var nq = L.normSearchText(q);
    return Object.keys(Store.S.products).map(function (id) { return Store.S.products[id]; }).filter(function (p) { return L.normSearchText(p.name).indexOf(nq) >= 0; }).slice(0, 10);
  }
  async function runSearch(q) {
    var seq = ++searchSeq;
    var local = localSearch(q);
    if (!Api.isConfigured() || !online()) {
      $('search-list').innerHTML = local.length ? local.map(foodItemHtml).join('') : '<p class="hint">オフラインのため、端末に残っている商品だけ検索しています。</p>';
      return;
    }
    $('search-status').innerHTML = '<span class="spin"></span>検索中…';
    try {
      var data = await Api.request('products.search', { q: q, limit: 30 });
      if (seq !== searchSeq) return;
      data.products.forEach(function (p) { Store.upsertProduct(p); });
      Store.save();
      $('search-list').innerHTML = data.products.length ? data.products.map(foodItemHtml).join('') : '<p class="hint">見つかりませんでした。別の言い方（例: ごはん → 白米）で試すか、「バーコードを読む」から商品を登録してください。</p>';
      setMsg('search-status', data.products.length ? data.total + ' 件' : '');
      lastSearched = q;
    } catch (e) {
      if (seq !== searchSeq) return;
      $('search-list').innerHTML = local.map(foodItemHtml).join('');
      setMsg('search-status', Api.isNetworkError(e) ? '通信できませんでした。端末内の商品だけ表示しています。' : (e.message || '検索に失敗しました。'), 'err');
      handleApiError(e, { silent: true });
    }
  }
  $('search-input').addEventListener('input', function () {
    var q = this.value.trim();
    clearTimeout(searchTimer);
    if (!q) { $('search-list').innerHTML = ''; setMsg('search-status', ''); return; }
    searchTimer = setTimeout(function () { runSearch(q); }, 300);
  });
  $('search-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); var q = this.value.trim(); if (q) runSearch(q); } });
  $('search-back').addEventListener('click', function () { goto('home'); });
  $('search-list').addEventListener('click', function (e) {
    var it = e.target.closest('[data-pid]'); if (!it) return;
    var p = Store.productById(it.getAttribute('data-pid')); if (p) openProduct(p, true);
  });

  /* ---------- スキャン ---------- */
  function recentProducts() {
    var lastUsed = {};
    Store.S.logs.forEach(function (l) { var k = l.created_at || ''; if (!lastUsed[l.product_id] || lastUsed[l.product_id] < k) lastUsed[l.product_id] = k; });
    var list = Object.keys(Store.S.products).map(function (id) { return Store.S.products[id]; });
    list.sort(function (a, b) { return String(lastUsed[b.id] || b.updated_at || '').localeCompare(String(lastUsed[a.id] || a.updated_at || '')); });
    return list.slice(0, 20);
  }
  function renderScan() {
    $('jan-error').hidden = true;
    var list = recentProducts();
    $('recent-list').innerHTML = list.length ? list.map(function (p) {
      return '<button type="button" class="item" data-pid="' + esc(p.id) + '"><span class="name">' + esc(p.name) + sourceTag(p, true) + '<div class="sub">' + esc(p.quantity_text || '') + (p.quantity_text ? ' · ' : '') + BASIS_NAME[p.serving_basis] + 'あたり ' + fmt(p.energy_kcal, 0) + ' kcal</div></span><span class="val">›</span></button>';
    }).join('') : '<p class="hint">まだ商品がありません。</p>';
    if (state.noCamera) { state.noCamera = false; setScannerOff('「カメラを起動」を押すとスキャンできます'); return; }
    startCamera();
  }
  function setScannerOff(msg) {
    var sc = $('scanner');
    sc.classList.add('off');
    $('scan-video').hidden = true;
    $('scan-msg').textContent = msg || '';
    $('scan-start').hidden = !Scanner.supportsLive();
  }
  async function startCamera() {
    var sc = $('scanner');
    if (!Scanner.supportsLive()) { setScannerOff('この環境ではカメラのライブ読み取りが使えません。「写真から読む」か JAN を入力してください。'); return; }
    sc.classList.remove('off'); $('scan-video').hidden = false; $('scan-start').hidden = true;
    $('scan-msg').textContent = '枠の中にバーコードを合わせてください';
    setScanStatus('');
    try {
      await Scanner.start($('scan-video'), function (code) { setScanStatus('読み取り成功: ' + code, 'ok'); handleCode(code); },
        function (mode) { if (mode === 'zxing') $('scan-msg').textContent = '枠の中にバーコードを合わせてください（水平に、明るい場所で）'; });
    } catch (e) {
      var msg = e && e.name === 'NotAllowedError' ? 'カメラの使用が許可されませんでした。ブラウザの設定で許可するか、「写真から読む」を使ってください。' :
        e && e.name === 'NotFoundError' ? 'カメラが見つかりません。' : 'カメラを起動できませんでした（' + (e && (e.name || e.message)) + '）。「写真から読む」か JAN を入力してください。';
      setScannerOff(msg);
    }
  }
  $('scan-start').addEventListener('click', startCamera);
  $('scan-back').addEventListener('click', function () { goto('home'); });
  $('recent-list').addEventListener('click', function (e) {
    var it = e.target.closest('[data-pid]'); if (!it) return;
    var p = Store.productById(it.getAttribute('data-pid')); if (p) openProduct(p);
  });
  function setScanStatus(msg, kind) { setMsg('scan-status', msg, kind); }
  $('jan-search').addEventListener('click', function () {
    var code = L.normJan($('jan-input').value);
    if (!L.eanValid(code)) { $('jan-error').textContent = code.length ? 'JANコードが正しくありません（桁数またはチェックデジット）。' : 'JANコードを入力してください。'; $('jan-error').hidden = false; return; }
    $('jan-error').hidden = true;
    handleCode(code);
  });
  $('jan-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('jan-search').click(); } });
  $('scan-file').addEventListener('change', async function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    setScanStatus('写真から読み取り中…');
    try {
      var code = await Scanner.decodeFile(f);
      if (!code) { setScanStatus('読み取れませんでした。バーコード全体が水平に、画面の幅いっぱいに写るように撮ってください。', 'err'); return; }
      setScanStatus('読み取り成功: ' + code, 'ok');
      handleCode(code);
    } catch (e) { setScanStatus('読み取りでエラーが起きました: ' + (e && e.message ? e.message : e), 'err'); }
  });
  var lookupBusy = false;
  async function handleCode(code) {
    if (lookupBusy) return;
    $('jan-input').value = code;
    var local = Store.productByJan(code);
    if (local) { openProduct(local); return; }
    if (!Api.isConfigured()) { state.jan = code; state.editId = null; state.hint = null; goto('register'); return; }
    lookupBusy = true;
    setScanStatus('<span class="spin"></span>商品を照会中…');
    $('scan-status').innerHTML = '<span class="spin"></span>商品を照会中…';
    try {
      var data = await Api.request('product.get', { jan: code, external: '1' }, { timeout: 90000 });
      if (data.product) {
        Store.upsertProduct(data.product); Store.save(); setScanStatus(''); openProduct(data.product);
        if (data.found === 'web') toast('ウェブ検索で見つけた商品です。数値はパッケージと照合してください');
      }
      else { state.jan = code; state.editId = null; state.hint = data.hint || null; setScanStatus(''); goto('register'); }
    } catch (e) {
      if (Api.isNetworkError(e)) { setScanStatus('通信できないため商品を照会できません。つながってからもう一度お試しください。', 'err'); }
      else { setScanStatus(e.message || '照会に失敗しました。', 'err'); }
    } finally { lookupBusy = false; }
  }
  function openProduct(p, fromSearch) {
    state.fromSearch = !!fromSearch;
    state.product = p;
    state.amount = L.defaultAmount(p);
    state.meal = L.mealByHour(new Date().getHours());
    state.keepDate = false;
    goto('product');
  }

  /* ---------- 商品カード ---------- */
  function amountOptions(p) {
    var modes = L.availableModes(p), opts = [];
    if (modes.indexOf('package') >= 0) opts.push(['package', 1, '1個'], ['package', 0.5, '半分'], ['package', 2, '2個']);
    if (modes.indexOf('serving') >= 0 && p.serving_basis === 'per_serving') opts.push(['serving', 1, '1食'], ['serving', 0.5, '半分'], ['serving', 2, '2食']);
    if (modes.indexOf('grams') >= 0) {
      var u = L.isLiquid(p) ? 'ml' : 'g';
      opts.push(['grams', 100, '100' + u], ['grams', 200, '200' + u]);
      if (p.package_g && p.serving_basis === 'per_100g') opts.push(['grams', p.package_g, '全量 ' + fmt(p.package_g, 0) + u]);
    }
    return opts;
  }
  function unitFor(p, mode) { return mode === 'grams' ? (L.isLiquid(p) ? 'ml' : 'g') : mode === 'serving' ? '食' : '個'; }
  function renderProduct() {
    var p = state.product; if (!p) return;
    $('p-name').innerHTML = esc(p.name) + sourceTag(p, false) + (p.verified ? '<span class="tag">確認済み</span>' : '');
    $('p-sub').textContent = (p.brand ? p.brand + ' · ' : '') + (p.quantity_text ? p.quantity_text + ' · ' : '') + (L.isPseudoJan(p.jan) ? '' : 'JAN ' + p.jan + ' · ') + BASIS_NAME[p.serving_basis] + (p.serving_basis !== 'per_100g' && p.serving_g ? '（' + fmt(p.serving_g, 0) + (L.isLiquid(p) ? 'ml' : 'g') + '）' : '') + 'あたりの表示';
    var opts = amountOptions(p);
    if (!opts.length) { state.amount = L.defaultAmount(p); }
    $('amount-chips').innerHTML = opts.map(function (o) {
      var pressed = state.amount.mode === o[0] && state.amount.amount === o[1];
      return '<button type="button" class="chip" data-mode="' + o[0] + '" data-v="' + o[1] + '" aria-pressed="' + String(pressed) + '">' + esc(o[2]) + '</button>';
    }).join('');
    $('amount-unit').textContent = unitFor(p, state.amount.mode);
    $('amount-input').value = state.amount.amount;
    $('meal-chips').innerHTML = MEALS.map(function (m) { return '<button type="button" class="chip" data-meal="' + m[0] + '" aria-pressed="' + String(state.meal === m[0]) + '">' + m[1] + '</button>'; }).join('');
    var dateEl = $('log-date');
    if (!dateEl.value || !state.keepDate) dateEl.value = state.homeDate <= todayStr() ? state.homeDate : todayStr();
    dateEl.max = todayStr();
    renderProductTable();
  }
  function renderProductTable() {
    var p = state.product; if (!p) return;
    var f = L.factorFor(p, state.amount.mode, state.amount.amount);
    var n = f == null ? null : L.scaleN(p, f);
    var head = '<span class="h">項目</span><span class="h r">' + BASIS_NAME[p.serving_basis] + 'あたり</span><span class="h r">この量</span>';
    $('p-table').innerHTML = head + NUT.map(function (x) { return '<span>' + x.label + '</span><span class="r">' + fmt(p[x.k], x.d) + ' ' + x.unit + '</span><span class="r b">' + (n ? fmt(n[x.k], x.d) + ' ' + x.unit : '—') + '</span>'; }).join('');
    var date = $('log-date').value || todayStr();
    var tot = L.totals(logsFor(date)), T = targets();
    $('p-preview').textContent = n ? '登録すると ' + L.fmtDateJP(date) + ' は ' + fmt(tot.energy_kcal + n.energy_kcal, 0) + ' / ' + fmt(T.kcal, 0) + ' kcal（たんぱく質 ' + fmt(tot.protein_g + n.protein_g, 0) + ' / ' + fmt(T.p[0], 0) + '〜' + fmt(T.p[1], 0) + ' g）になります。' : '量を入力してください。';
    $('log-save').disabled = !n;
  }
  $('amount-chips').addEventListener('click', function (e) {
    var c = e.target.closest('[data-v]'); if (!c) return;
    state.amount = { mode: c.getAttribute('data-mode'), amount: Number(c.getAttribute('data-v')) };
    renderProduct();
  });
  $('amount-input').addEventListener('input', function () {
    var v = Number(this.value);
    if (!(v > 0)) { $('log-save').disabled = true; return; }
    state.amount.amount = v;
    Array.prototype.forEach.call($('amount-chips').querySelectorAll('.chip'), function (c) { c.setAttribute('aria-pressed', String(c.getAttribute('data-mode') === state.amount.mode && Number(c.getAttribute('data-v')) === v)); });
    renderProductTable();
  });
  $('meal-chips').addEventListener('click', function (e) {
    var c = e.target.closest('[data-meal]'); if (!c) return;
    state.meal = c.getAttribute('data-meal');
    Array.prototype.forEach.call($('meal-chips').querySelectorAll('.chip'), function (x) { x.setAttribute('aria-pressed', String(x === c)); });
  });
  $('log-date').addEventListener('change', function () { state.keepDate = true; renderProductTable(); });
  $('product-back').addEventListener('click', function () { if (state.fromSearch) { state.fromSearch = false; goto('search'); return; } if (state.product && L.isCustomJan(state.product.jan)) { goto('home'); return; } state.noCamera = true; goto('scan'); });
  $('p-edit').addEventListener('click', function () { if (!state.product) return; state.editId = state.product.id; state.jan = state.product.jan; goto('register'); });
  $('log-save').addEventListener('click', async function () {
    var p = state.product; if (!p) return;
    var amount = Number($('amount-input').value);
    if (!(amount > 0)) { toast('量を入力してください'); return; }
    var factor = L.factorFor(p, state.amount.mode, amount);
    if (factor == null) { toast('この量の指定方法は使えません'); return; }
    var date = $('log-date').value || todayStr();
    var time = date === todayStr() ? nowTime() : '12:00';
    var n = L.scaleN(p, factor);
    var clientId = uid();
    var log = {
      id: null, client_id: clientId, product_id: p.id, product_name: p.name, date: date, time: time, eaten_at: date + 'T' + time + ':00+09:00',
      meal_type: state.meal, amount_mode: state.amount.mode, amount: amount, amount_label: L.amountLabel(p, state.amount.mode, amount),
      energy_kcal: n.energy_kcal, protein_g: n.protein_g, fat_g: n.fat_g, carb_g: n.carb_g, salt_g: n.salt_g, created_at: new Date().toISOString(), pending: true
    };
    Store.addLog(log);
    Store.enqueue({ type: 'log.create', key: 'add:' + clientId, params: { client_id: clientId, product_id: p.id, date: date, time: time, meal_type: state.meal, amount_mode: state.amount.mode, amount: amount } });
    Store.S.months = {};
    Store.save();
    state.homeDate = date; state.selLog = null; state.keepDate = false;
    toast(p.name + ' を登録しました');
    goto('home');
    try { await flushQueue(); } catch (e) { handleApiError(e, { silent: true }); }
    if (state.view === 'home') renderHome();
  });

  /* ---------- 商品登録 / 修正 ---------- */
  var FIELDS = ['name', 'brand', 'qty', 'basis', 'serving-g', 'package-g', 'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'sodium_mg', 'sugar_g', 'fiber_g', 'satfat_g'];
  function renderRegister() {
    var p = state.editId ? Store.productById(state.editId) : null;
    if (state.editId && !p) state.editId = null;
    var editing = !!p, custom = L.isCustomJan(editing ? p.jan : state.jan);
    $('reg-title').textContent = editing ? '商品情報を修正' : (custom ? 'バーコードなしで登録' : '商品を登録');
    $('reg-intro').textContent = editing ? '数値を修正して保存します。登録した本人（または管理者）以外の修正は「修正提案」として記録されます。'
      : custom ? 'バーコードが無い・読めない商品やお店の料理を、名前と栄養成分で登録します（自分だけに表示されます）。栄養成分表示があれば撮影で自動入力できます。無ければ熱量だけでも登録できます。'
      : 'この商品はまだ登録されていません。パッケージの栄養成分表示を撮影すると、数値を自動で入力します。';
    $('f-jan-field').hidden = custom;
    $('f-error').hidden = true; setMsg('ocr-status', '');
    FIELDS.forEach(function (f) { var el = $('f-' + f); el.classList.remove('lowconf'); });
    $('f-jan').value = editing ? p.jan : (state.jan || '');
    $('f-name').value = editing ? p.name : (state.hint && state.hint.name ? state.hint.name : '');
    $('f-brand').value = editing ? (p.brand || '') : (state.hint && state.hint.brand ? state.hint.brand : '');
    $('f-qty').value = editing ? (p.quantity_text || '') : (state.hint && state.hint.quantity_text ? state.hint.quantity_text : '');
    $('f-basis').value = editing ? p.serving_basis : (custom ? 'per_serving' : 'per_package');
    $('f-serving-g').value = editing && p.serving_g != null ? p.serving_g : '';
    $('f-package-g').value = editing && p.package_g != null ? p.package_g : '';
    L.KEYS.concat(L.OPTIONAL_KEYS).forEach(function (k) { $('f-' + k).value = editing && p[k] != null ? p[k] : ''; });
    $('f-sodium_mg').value = '';
    state.ocrUsed = false; state.hintUsed = false;
    syncBasisLabel();
    var h = state.hint;
    if (!editing && h && h.provider === 'web' && h.filled > 0) applyLookup(h, 'web');
    else if (!editing && h && h.name) setMsg('ocr-status', h.provider === 'web' ? '商品名はウェブ検索から取得しました。栄養成分は見つからなかったので、撮影または手入力してください。' : '商品名は Yahoo!ショッピングから取得しました。栄養成分は撮影または手入力してください。');
  }
  /** ウェブ照会の結果をフォームに流し込む（OCR と同じ要確認扱い） */
  function applyLookup(h, kind) {
    var low = (h.confidence || 0) < 0.7, filled = 0;
    L.KEYS.concat(L.OPTIONAL_KEYS).forEach(function (k) { var el = $('f-' + k); if (typeof h[k] === 'number') { el.value = h[k]; filled++; el.classList.toggle('lowconf', low); } });
    if (h.sodium_mg != null) $('f-sodium_mg').value = h.sodium_mg;
    if (h.basis) { $('f-basis').value = h.basis; syncBasisLabel(); }
    if (typeof h.serving_g === 'number') $('f-serving-g').value = h.serving_g;
    if (typeof h.package_g === 'number') $('f-package-g').value = h.package_g;
    state.hintUsed = kind === 'web' && filled > 0;
    var conf = Math.round((h.confidence || 0) * 100);
    var src = h.source_url ? ' 出典: <a href="' + esc(h.source_url) + '" target="_blank" rel="noopener">' + esc(h.source_url.replace(/^https?:\/\//, '').slice(0, 40)) + '</a>' : '';
    var el = $('ocr-status');
    el.className = low ? 'warnmsg' : 'okmsg';
    el.innerHTML = esc('ウェブ検索で ' + filled + ' 項目を取得しました（信頼度 ' + conf + '%）。' + (low ? '黄色の欄をパッケージと照合してください。' : 'パッケージの表示と照合して保存してください。') + (h.notes ? ' ' + h.notes : '')) + src;
  }
  function syncBasisLabel() {
    var b = $('f-basis').value;
    var opt = b === 'per_100g' || $('f-jan-field').hidden ? '・任意' : ''; // 手入力登録（バーコードなし）は質量が無くても 1食／1個単位で記録できる
    $('f-serving-g-label').textContent = b === 'per_100g' ? '1食の質量（g / ml' + opt + '）' : b === 'per_serving' ? '1食の質量（g / ml' + opt + '）' : '1包装の質量（g / ml' + opt + '）';
  }
  $('f-basis').addEventListener('change', syncBasisLabel);
  $('f-sodium_mg').addEventListener('input', function () { var mg = Number(this.value); if (mg > 0) $('f-salt_g').value = L.sodiumToSalt(mg); });
  $('reg-back').addEventListener('click', function () { if (state.editId) { state.editId = null; goto('product'); } else if (L.isCustomJan(state.jan)) { state.jan = null; goto('home'); } else { state.noCamera = true; goto('scan'); } });
  function collectForm() {
    var o = { jan: $('f-jan').value, name: $('f-name').value, brand: $('f-brand').value, quantity_text: $('f-qty').value, serving_basis: $('f-basis').value, serving_g: $('f-serving-g').value, package_g: $('f-package-g').value, sodium_mg: $('f-sodium_mg').value };
    L.KEYS.concat(L.OPTIONAL_KEYS).forEach(function (k) { o[k] = $('f-' + k).value; });
    return o;
  }
  $('reg-save').addEventListener('click', async function () {
    var input = collectForm(), norm;
    try { norm = L.normalizeProduct(input); }
    catch (e) { $('f-error').textContent = e.message; $('f-error').hidden = false; return; }
    $('f-error').hidden = true;
    if (!Api.isConfigured() || !online()) { $('f-error').textContent = '商品の登録には通信が必要です。つながってからもう一度お試しください。'; $('f-error').hidden = false; return; }
    var btn = $('reg-save'); btn.disabled = true;
    try {
      var data;
      if (state.editId) {
        data = await Api.request('product.update', Object.assign({ id: state.editId }, norm));
        Store.upsertProduct(data.product); Store.save();
        toast(data.applied ? '商品情報を更新しました' : '修正提案として送りました');
        state.editId = null;
        openProduct(data.product);
      } else {
        data = await Api.request('product.create', Object.assign({ source: state.ocrUsed ? 'ocr' : (state.hintUsed ? 'web' : 'manual') }, norm));
        Store.upsertProduct(data.product); Store.save();
        toast(data.created ? '商品を登録しました' : '登録済みの商品を開きます');
        state.jan = null; state.hint = null;
        openProduct(data.product);
      }
    } catch (e) {
      if (e.code === 'validation') { $('f-error').textContent = e.message; $('f-error').hidden = false; }
      else handleApiError(e);
    } finally { btn.disabled = false; }
  });
  $('ocr-file').addEventListener('change', async function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    if (!Api.isConfigured() || !online()) { setMsg('ocr-status', '自動読み取りには通信が必要です。表示を見ながら手入力してください。', 'err'); return; }
    $('ocr-status').innerHTML = '<span class="spin"></span>読み取り中…（10秒ほどかかります）';
    try {
      var img = await Scanner.shrinkToJpeg(f, 1600, 0.85);
      if (img.bytes > 4500000) img = await Scanner.shrinkToJpeg(f, 1100, 0.8);
      var data = await Api.request('ocr.parse', { image_base64: img.base64, media_type: img.mediaType }, { timeout: 90000 });
      applyOcr(data.result);
    } catch (e) {
      var msg = e.code === 'ocr_refused' || e.code === 'ocr_failed' || e.code === 'rate_limited' || e.code === 'upstream' ? e.message : (Api.isNetworkError(e) ? '通信できませんでした。' : (e.message || '読み取りに失敗しました。'));
      setMsg('ocr-status', msg + ' 手入力もできます。', 'err');
    }
  });
  function applyOcr(r) {
    if (!r) { setMsg('ocr-status', '読み取り結果を解釈できませんでした。手入力してください。', 'err'); return; }
    var low = r.confidence < 0.7, filled = 0;
    L.KEYS.concat(L.OPTIONAL_KEYS).forEach(function (k) { var el = $('f-' + k); if (typeof r[k] === 'number') { el.value = r[k]; filled++; el.classList.toggle('lowconf', low); } });
    if (r.sodium_mg != null) $('f-sodium_mg').value = r.sodium_mg;
    if (r.basis) { $('f-basis').value = r.basis; syncBasisLabel(); }
    if (typeof r.serving_g === 'number') $('f-serving-g').value = r.serving_g;
    if (typeof r.package_g === 'number') $('f-package-g').value = r.package_g;
    if (r.name && !$('f-name').value.trim()) $('f-name').value = r.name;
    state.ocrUsed = filled > 0;
    var conf = Math.round((r.confidence || 0) * 100);
    if (!filled) setMsg('ocr-status', '数値を読み取れませんでした。表示が大きく写るように撮り直すか、手入力してください。', 'err');
    else if (low) setMsg('ocr-status', filled + '項目を読み取りました（信頼度 ' + conf + '%）。黄色の欄をパッケージと照合してください。' + (r.notes ? ' ' + r.notes : ''), 'warn');
    else setMsg('ocr-status', filled + '項目を読み取りました（信頼度 ' + conf + '%）。数値を確認して保存してください。' + (r.notes ? ' ' + r.notes : ''), 'ok');
  }

  /* ---------- 月次 ---------- */
  async function renderMonth() {
    var m = state.month, thisM = todayStr().slice(0, 7);
    $('month-title').textContent = L.fmtMonthJP(m) + (m === thisM ? '（今月）' : '');
    $('this-month').setAttribute('aria-pressed', String(m === thisM));
    $('next-month').disabled = m >= thisM;
    var data = Store.S.months[m];
    if (!data) {
      if (!Api.isConfigured() || !online()) { $('month-summary').innerHTML = '<p class="hint">月次集計はサーバーから取得します。' + (online() ? 'APIのURLを設定してください。' : 'オンラインになったら表示されます。') + '</p>'; $('month-chart').innerHTML = ''; $('month-nutrients').innerHTML = ''; return; }
      $('month-summary').innerHTML = '<p class="hint"><span class="spin"></span>集計中…</p>'; $('month-nutrients').innerHTML = '';
      try { data = await Api.request('summary.monthly', { month: m }); Store.S.months[m] = data; Store.save(); }
      catch (e) { handleApiError(e); $('month-summary').innerHTML = '<p class="err">取得できませんでした。</p>'; return; }
      if (state.month !== m || state.view !== 'month') return;
    }
    var T = data.targets || targets();
    $('month-summary').innerHTML = data.recorded_days ?
      '<div class="big">' + fmt(data.avg.energy_kcal, 0) + ' <small>kcal / 日（平均）</small></div>' +
      '<div>記録 ' + data.recorded_days + '日 · 5項目すべて目標内 <b>' + data.achieved_days + '日</b> · 合計 ' + fmt(data.sum.energy_kcal, 0) + ' kcal</div>' :
      '<p class="hint">この月の記録はありません。</p>';
    $('month-nutrients').innerHTML = data.recorded_days ? NUT.map(function (n) {
      var rk = { protein_g: 'p', fat_g: 'f', carb_g: 'c' }[n.k];
      var tgt = n.k === 'energy_kcal' ? fmt(T.kcal, 0) + ' kcal' : n.k === 'salt_g' ? fmt(T.salt, 1) + ' g 未満' : fmt(T[rk][0], 0) + '〜' + fmt(T[rk][1], 0) + ' g';
      return '<div class="nut"><span class="n">' + n.label + '<span class="sub"> 1日平均</span></span><span class="v">' + fmt(data.avg[n.k], n.d) + ' / ' + tgt + '</span>' + chipHtml(data.avg_verdict[n.k]) + '</div>';
    }).join('') : '';
    renderChart(data.days, T);
  }
  function renderChart(days, T) {
    var W = 330, H = 160, padL = 34, padR = 8, padT = 16, padB = 22;
    var maxV = Math.max(T.kcal * 1.25, 1); days.forEach(function (x) { if (x.totals.energy_kcal > maxV) maxV = x.totals.energy_kcal; });
    var n = days.length, iw = W - padL - padR, bw = iw / n, ih = H - padT - padB;
    var y = function (v) { return padT + ih - (v / maxV) * ih; };
    var s = '';
    [0, Math.round(maxV / 2 / 100) * 100, Math.round(maxV / 100) * 100].forEach(function (t) {
      if (t > maxV) return;
      s += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '"/><text x="' + (padL - 4) + '" y="' + (y(t) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(t, 0) + '</text>';
    });
    days.forEach(function (x, i) {
      if (!x.totals.count) return;
      var h = Math.max(1, ih - (y(x.totals.energy_kcal) - padT));
      var cls = x.verdict && x.verdict.energy_kcal.s === 'over' ? ' over' : (x.all_ok ? ' ok' : '');
      s += '<rect class="cbar' + cls + '" x="' + (padL + i * bw + bw * 0.15).toFixed(1) + '" y="' + y(x.totals.energy_kcal).toFixed(1) + '" width="' + (bw * 0.7).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1.5"><title>' + (i + 1) + '日 ' + fmt(x.totals.energy_kcal, 0) + ' kcal</title></rect>';
    });
    s += '<line class="target" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(T.kcal).toFixed(1) + '" y2="' + y(T.kcal).toFixed(1) + '"/>';
    s += '<text x="' + (W - padR) + '" y="' + (y(T.kcal) - 4).toFixed(1) + '" text-anchor="end">目標 ' + fmt(T.kcal, 0) + '</text>';
    [1, 5, 10, 15, 20, 25, 30].forEach(function (d) { if (d <= n) s += '<text x="' + (padL + (d - 0.5) * bw).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + d + '</text>'; });
    $('month-chart').innerHTML = s;
  }
  $('prev-month').addEventListener('click', function () { state.month = L.addMonths(state.month, -1); renderMonth(); });
  $('next-month').addEventListener('click', function () { if (state.month < todayStr().slice(0, 7)) { state.month = L.addMonths(state.month, 1); renderMonth(); } });
  $('this-month').addEventListener('click', function () { state.month = todayStr().slice(0, 7); renderMonth(); });

  /* ---------- 設定 ---------- */
  function renderGoal() {
    var pr = Store.S.profile || {};
    Array.prototype.forEach.call($('sex-chips').querySelectorAll('.chip'), function (c) { c.setAttribute('aria-pressed', String(c.getAttribute('data-v') === pr.sex)); });
    $('s-birth').value = pr.birth_year || '';
    $('s-height').value = pr.height_cm || '';
    $('s-weight').value = pr.weight_kg || '';
    $('s-pal').value = pr.activity_level || 'normal';
    $('s-kcal').value = pr.target_mode === 'manual' && pr.target_kcal ? pr.target_kcal : '';
    $('s-adjust').value = pr.kcal_adjust || '';
    $('s-htn').checked = !!pr.htn;
    $('s-error').hidden = true;
    renderTargets();
    var u = Auth.user() || {}, su = Store.S.user || {};
    $('account-info').textContent = (su.name || u.name || '') + (u.email ? '（' + u.email + '）' : '') + (Auth.mode() === 'dev' ? ' · 開発モード' : '') + (su.is_admin ? ' · 管理者' : '');
    var pending = Store.S.queue.length;
    $('data-stats').textContent = '端末内の記録 ' + Store.S.logs.length + '件 · 商品 ' + Object.keys(Store.S.products).length + '件' + (pending ? ' · 送信待ち ' + pending + '件' : '') + (Store.S.lastSync ? ' · 最終同期 ' + String(Store.S.lastSync).replace('T', ' ').slice(0, 16) : '');
    $('del-confirm').hidden = true;
    $('app-version').textContent = (cfg.appName || 'ピッと栄養') + ' v' + (cfg.version || '') + (Api.isConfigured() ? '' : ' · API未設定（config.js の apiUrl を設定してください）');
  }
  function renderTargets() {
    var T = targets();
    var rows = [
      ['熱量', fmt(T.kcal, 0) + ' kcal' + (T.auto ? (T.hasProfile ? '（自動計算）' : '（仮の値）') : '（手動）')],
      ['たんぱく質', fmt(T.p[0], 0) + '〜' + fmt(T.p[1], 0) + ' g'],
      ['脂質', fmt(T.f[0], 0) + '〜' + fmt(T.f[1], 0) + ' g'],
      ['炭水化物', fmt(T.c[0], 0) + '〜' + fmt(T.c[1], 0) + ' g'],
      ['食塩相当量', fmt(T.salt, 1) + ' g 未満']
    ];
    if (T.bmr) rows.splice(1, 0, ['基礎代謝量（参考）', fmt(T.bmr, 0) + ' kcal']);
    $('targets-table').innerHTML = rows.map(function (r) { return '<span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span>'; }).join('');
  }
  $('sex-chips').addEventListener('click', function (e) {
    var c = e.target.closest('[data-v]'); if (!c) return;
    Array.prototype.forEach.call($('sex-chips').querySelectorAll('.chip'), function (x) { x.setAttribute('aria-pressed', String(x === c)); });
  });
  $('s-save').addEventListener('click', async function () {
    var sexEl = $('sex-chips').querySelector('[aria-pressed="true"]');
    var manual = Number($('s-kcal').value) > 0;
    var input = { sex: sexEl ? sexEl.getAttribute('data-v') : '', birth_year: $('s-birth').value, height_cm: $('s-height').value, weight_kg: $('s-weight').value, activity_level: $('s-pal').value, target_mode: manual ? 'manual' : 'auto', target_kcal: $('s-kcal').value, kcal_adjust: $('s-adjust').value, htn: $('s-htn').checked };
    var norm;
    try { norm = L.normalizeProfile(input); } catch (e) { $('s-error').textContent = e.message; $('s-error').hidden = false; return; }
    $('s-error').hidden = true;
    Store.S.profile = norm; Store.S.targets = L.computeTargets(norm, new Date().getFullYear()); Store.S.months = {}; Store.save(); renderTargets();
    if (!Api.isConfigured() || !online()) { toast('目標を端末に保存しました（通信時にサーバーへ反映）'); Store.enqueue({ type: 'profile.update', key: 'profile', params: norm }); return; }
    var btn = $('s-save'); btn.disabled = true;
    try { var data = await Api.request('profile.update', norm); Store.S.profile = data.profile; Store.S.targets = data.targets; Store.save(); renderTargets(); toast('目標を保存しました'); }
    catch (e) { if (e.code === 'validation') { $('s-error').textContent = e.message; $('s-error').hidden = false; } else handleApiError(e); }
    finally { btn.disabled = false; }
  });
  $('sync-now').addEventListener('click', async function () { await sync(); renderGoal(); toast(Store.S.lastSync ? '同期しました' : '同期できませんでした'); });
  $('logout').addEventListener('click', function () { Scanner.stop(); Store.reset(); Auth.signOut(); });
  $('del-all').addEventListener('click', function () { $('del-confirm').hidden = false; });
  $('del-no').addEventListener('click', function () { $('del-confirm').hidden = true; });
  $('del-yes').addEventListener('click', async function () {
    if (!Api.isConfigured() || !online()) { toast('退会には通信が必要です'); return; }
    var btn = $('del-yes'); btn.disabled = true;
    try { await Api.request('account.delete', { confirm: 'DELETE' }); Store.reset(); toast('記録を削除しました'); Auth.signOut(); }
    catch (e) { handleApiError(e); }
    finally { btn.disabled = false; }
  });

  /* ---------- オンライン/オフライン・タブ・SW ---------- */
  function updateOnline() { $('offline-banner').hidden = online(); renderSyncStatus(); }
  window.addEventListener('online', function () { updateOnline(); sync(); });
  window.addEventListener('offline', updateOnline);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && state.authed) sync(); });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.addEventListener('click', function () { goto(t.dataset.view); }); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') { navigator.serviceWorker.register('./sw.js').catch(function () { /* noop */ }); }
  /* プロフィール更新の送信待ちも flush する */
  var _flush = flushQueue;
  flushQueue = async function () {
    var pq = Store.S.queue.filter(function (o) { return o.type === 'profile.update'; });
    for (var i = 0; i < pq.length; i++) {
      try { var d = await Api.request('profile.update', pq[i].params); Store.S.profile = d.profile; Store.S.targets = d.targets; Store.dequeue(pq[i]); }
      catch (e) { if (Api.isNetworkError(e)) return; if (e.code === 'unauthorized') throw e; Store.dequeue(pq[i]); }
    }
    return _flush();
  };
  updateOnline();
  Auth.init(onAuth);
})();
