/* ============================================================================
 * Db.gs — Googleスプレッドシートをテーブルとして扱う薄い層（設計書 6節）
 *  - 1タブ = 1テーブル、1行目 = ヘッダー。IDはUUID文字列、日時は ISO 8601（JST）文字列。
 *  - 削除は deleted_at を入れる論理削除（退会時だけ物理削除）。
 *  - 書き込みは Db.withLock() で直列化する（LockService）。
 *  - セルの自動型変換（日付や数値化）に備えて、読み出し時に文字列へ正規化する。
 * ========================================================================== */
var Db = (function () {
  var SCHEMA = {
    users: ['id', 'email', 'display_name', 'created_at', 'updated_at', 'deleted_at'],
    user_profiles: ['user_id', 'sex', 'birth_year', 'height_cm', 'weight_kg', 'activity_level', 'target_mode', 'target_kcal', 'kcal_adjust', 'htn', 'updated_at'],
    products: ['id', 'jan', 'name', 'brand', 'quantity_text', 'serving_basis', 'serving_g', 'package_g',
      'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'sugar_g', 'fiber_g', 'satfat_g',
      'source', 'verified', 'created_by', 'created_at', 'updated_at', 'deleted_at'],
    food_logs: ['id', 'client_id', 'user_id', 'product_id', 'product_name', 'date', 'eaten_at', 'meal_type', 'amount_mode', 'amount', 'amount_label',
      'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'created_at', 'updated_at', 'deleted_at'],
    daily_summaries: ['user_id', 'date', 'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'log_count', 'verdict_json', 'updated_at'],
    product_images: ['id', 'product_id', 'drive_file_id', 'kind', 'created_by', 'created_at'],
    product_suggestions: ['id', 'product_id', 'user_id', 'fields_json', 'note', 'status', 'created_at'],
    sessions: ['id', 'user_id', 'email', 'display_name', 'picture', 'created_at', 'expires_at', 'last_used_at', 'deleted_at']
  };
  /* 読み出し時に必ず文字列として扱う列（シートが数値や日付に自動変換しても元に戻す） */
  var TEXT_COLS = {};
  ['id', 'jan', 'client_id', 'user_id', 'product_id', 'created_by', 'drive_file_id', 'email', 'display_name', 'name', 'brand', 'quantity_text',
    'serving_basis', 'meal_type', 'amount_mode', 'amount_label', 'source', 'sex', 'activity_level', 'target_mode', 'kind', 'note', 'status',
    'verdict_json', 'fields_json', 'product_name'].forEach(function (c) { TEXT_COLS[c] = true; });
  var DATE_COLS = { date: true };
  var BOOL_COLS = { verified: true, htn: true };

  var ss_ = null;
  var sheets_ = {};
  var lockDepth_ = 0;

  function spreadsheet_() {
    if (ss_) return ss_;
    var id = prop_('SPREADSHEET_ID');
    ss_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss_) throw new ApiError('internal', 'スプレッドシートが見つかりません。スクリプトプロパティ SPREADSHEET_ID を設定してください。');
    return ss_;
  }
  function sheet_(name) {
    if (sheets_[name]) return sheets_[name];
    if (!SCHEMA[name]) throw new ApiError('internal', '未定義のテーブル: ' + name);
    var ss = spreadsheet_();
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(SCHEMA[name]);
      sh.setFrozenRows(1);
      try { sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), SCHEMA[name].length).setNumberFormat('@'); } catch (e) { /* 書式設定は任意 */ }
    }
    sheets_[name] = sh;
    return sh;
  }
  /** 全テーブルのタブを作る。初回に Apps Script エディタから手動実行する（なくても初回アクセス時に自動で作られる） */
  function setup() { Object.keys(SCHEMA).forEach(function (n) { sheet_(n); }); return Object.keys(SCHEMA); }

  function cell_(col, v) {
    if (v instanceof Date) {
      return DATE_COLS[col] ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
    }
    if (v === '' || v === null || v === undefined) return '';
    if (BOOL_COLS[col]) return truthy_(v);
    if (TEXT_COLS[col] || DATE_COLS[col]) {
      var s = String(v);
      if (col === 'jan') s = PittoLogic.normJan(s); // food:<key> / custom:<id>（疑似 JAN）は normJan が素通しする
      return s;
    }
    return v;
  }
  function toObj_(name, row, rowNumber) {
    var cols = SCHEMA[name], o = { _row: rowNumber };
    for (var i = 0; i < cols.length; i++) o[cols[i]] = cell_(cols[i], row[i]);
    return o;
  }
  function toRow_(name, obj) {
    return SCHEMA[name].map(function (c) {
      var v = obj[c];
      if (v === null || v === undefined) return '';
      if (BOOL_COLS[c]) return !!v;
      if (TEXT_COLS[c] || DATE_COLS[c]) return String(v);
      return v;
    });
  }
  /** テーブル全体を配列で返す（_row にシートの行番号） */
  function readAll(name) {
    var sh = sheet_(name);
    var last = sh.getLastRow();
    if (last < 2) return [];
    var values = sh.getRange(2, 1, last - 1, SCHEMA[name].length).getValues();
    var out = [];
    for (var i = 0; i < values.length; i++) {
      if (values[i][0] === '' && values[i][1] === '') continue; // 空行はスキップ
      out.push(toObj_(name, values[i], i + 2));
    }
    return out;
  }
  function findAll(name, pred) { return readAll(name).filter(pred); }
  function findOne(name, pred) {
    var rows = readAll(name);
    for (var i = 0; i < rows.length; i++) if (pred(rows[i])) return rows[i];
    return null;
  }
  function insert(name, obj) {
    sheet_(name).appendRow(toRow_(name, obj));
    return obj;
  }
  /** 複数行をまとめて追加（1 回の setValues。setupFoods のような一括登録用） */
  function insertMany(name, objs) {
    if (!objs.length) return objs;
    var sh = sheet_(name), last = sh.getLastRow();
    sh.getRange(last + 1, 1, objs.length, SCHEMA[name].length).setValues(objs.map(function (o) { return toRow_(name, o); }));
    return objs;
  }
  function update(name, obj) {
    if (!obj._row) throw new ApiError('internal', '更新対象の行番号がありません。');
    sheet_(name).getRange(obj._row, 1, 1, SCHEMA[name].length).setValues([toRow_(name, obj)]);
    return obj;
  }
  /** 条件に合う行を物理削除する（シートを書き直す）。退会処理専用 */
  function deleteWhere(name, pred) {
    var sh = sheet_(name);
    var rows = readAll(name);
    var keep = rows.filter(function (r) { return !pred(r); });
    if (keep.length === rows.length) return 0;
    var last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, SCHEMA[name].length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, SCHEMA[name].length).setValues(keep.map(function (r) { return toRow_(name, r); }));
    return rows.length - keep.length;
  }
  /** 書き込みの直列化。入れ子で呼ばれても二重取得しない */
  function withLock(fn) {
    if (lockDepth_ > 0) return fn();
    var lock = LockService.getScriptLock();
    var got = false;
    try { got = lock.tryLock(20000); } catch (e) { got = false; }
    if (!got) throw new ApiError('busy', '混み合っています。少し待ってからもう一度お試しください。');
    lockDepth_++;
    try { return fn(); }
    finally { lockDepth_--; try { lock.releaseLock(); } catch (e) { /* noop */ } }
  }
  /** ログインしたユーザーの行を用意する（初回は作成、退会済みなら復活）。結果はキャッシュして毎回の読み出しを省く */
  function ensureUser(user) {
    var cache = CacheService.getScriptCache();
    var key = 'user:' + user.id;
    if (cache.get(key)) return;
    withLock(function () {
      var row = findOne('users', function (r) { return r.id === user.id; });
      var now = nowIso_();
      if (!row) {
        insert('users', { id: user.id, email: user.email || '', display_name: user.name || '', created_at: now, updated_at: now, deleted_at: '' });
      } else if (row.deleted_at || row.email !== (user.email || '')) {
        row.deleted_at = ''; row.email = user.email || row.email; row.updated_at = now;
        update('users', row);
      }
    });
    cache.put(key, '1', 21600);
  }
  return { SCHEMA: SCHEMA, setup: setup, readAll: readAll, findAll: findAll, findOne: findOne, insert: insert, insertMany: insertMany, update: update, deleteWhere: deleteWhere, withLock: withLock, ensureUser: ensureUser };
})();

/** Apps Script エディタから一度実行: 全テーブルのタブを作成する */
function setupSheets() { return Db.setup(); }
