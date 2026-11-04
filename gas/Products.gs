/* ============================================================================
 * Products.gs — 共有の商品マスタ（設計書 7節: 自前マスタ → Open Food Facts → Yahoo!商品名 → OCR登録）
 * ========================================================================== */
var Products = (function () {
  var L = function () { return PittoLogic; };

  function pub(p) {
    if (!p) return null;
    var out = {
      id: p.id, jan: p.jan, name: p.name, brand: p.brand || '', quantity_text: p.quantity_text || '',
      serving_basis: p.serving_basis, serving_g: L().num(p.serving_g), package_g: L().num(p.package_g),
      source: p.source || 'manual', verified: !!p.verified, created_at: p.created_at || '', updated_at: p.updated_at || ''
    };
    L().KEYS.forEach(function (k) { out[k] = L().num(p[k]) || 0; });
    L().OPTIONAL_KEYS.forEach(function (k) { var v = L().num(p[k]); if (v != null) out[k] = v; });
    return out;
  }
  function byId(id) {
    id = str_(id);
    if (!id) return null;
    return Db.findOne('products', function (r) { return r.id === id && !r.deleted_at; });
  }
  function byJan(jan) { return Db.findOne('products', function (r) { return r.jan === jan && !r.deleted_at; }); }

  /** GET product.get?jan=…&external=1 — 認証不要。外部でヒットした商品はマスタに保存して返す */
  function get(params, ctx) {
    var jan = L().normJan(params.jan);
    if (!L().eanValid(jan)) throw new ApiError('validation', 'JANコードが正しくありません（桁数またはチェックデジット）。', { field: 'jan' });
    var p = byJan(jan);
    if (p) return { product: pub(p), found: 'master' };
    if (str_(params.external) !== '1') return { product: null, found: null };
    var off = External.openFoodFacts(jan);
    if (off) {
      var saved = Db.withLock(function () {
        var again = byJan(jan);
        if (again) return again;
        var now = nowIso_();
        var row = Object.assign({ id: uuid_(), source: 'off', verified: false, created_by: '', created_at: now, updated_at: now, deleted_at: '' }, off);
        return Db.insert('products', row);
      });
      return { product: pub(saved), found: 'off' };
    }
    var hint = External.yahooProductName(jan);
    return { product: null, found: null, hint: hint };
  }

  /** POST product.create — jan が既存なら既存を返す（409にしない） */
  function create(params, ctx) {
    var input = params.product || params;
    var norm = L().normalizeProduct(input);
    var existing = byJan(norm.jan);
    if (existing) return { product: pub(existing), created: false };
    var now = nowIso_();
    var source = ['ocr', 'manual'].indexOf(input.source) >= 0 ? input.source : 'manual';
    var row = Object.assign({ id: uuid_(), source: source, verified: !!ctx.isAdmin, created_by: ctx.user.id, created_at: now, updated_at: now, deleted_at: '' }, norm);
    Db.insert('products', row);
    saveImage_(row.id, input.image_base64, input.image_media_type, ctx);
    return { product: pub(row), created: true };
  }

  /** POST product.update — 登録者本人か管理者ならその場で修正、それ以外は修正提案として記録 */
  function update(params, ctx) {
    var input = params.product || params;
    var existing = byId(input.id || params.id);
    if (!existing) throw new ApiError('not_found', '商品が見つかりません。');
    var norm = L().normalizeProduct(Object.assign({}, input, { jan: existing.jan }));
    var canEdit = ctx.isAdmin || (existing.created_by && existing.created_by === ctx.user.id);
    if (!canEdit) {
      var s = suggest({ product_id: existing.id, fields: norm, note: str_(input.note) }, ctx);
      return { product: pub(existing), applied: false, suggestion_id: s.suggestion_id };
    }
    Object.assign(existing, norm);
    existing.updated_at = nowIso_();
    if (ctx.isAdmin && input.verified !== undefined) existing.verified = truthy_(input.verified);
    Db.update('products', existing);
    return { product: pub(existing), applied: true };
  }

  /** POST product.suggest — 修正提案（v1.1: 管理者がシート上で確認して反映する） */
  function suggest(params, ctx) {
    var product = byId(params.product_id);
    if (!product) throw new ApiError('not_found', '商品が見つかりません。');
    var fields = params.fields && typeof params.fields === 'object' ? params.fields : {};
    var row = { id: uuid_(), product_id: product.id, user_id: ctx.user.id, fields_json: JSON.stringify(fields), note: str_(params.note).slice(0, 500), status: 'open', created_at: nowIso_() };
    Db.insert('product_suggestions', row);
    return { suggestion_id: row.id };
  }

  /** POST products.recent — 本人が最近記録した／登録した商品（スキャン無しで再記録するため） */
  function recent(params, ctx) {
    var limit = Math.min(50, Math.max(1, Number(params.limit) || 30));
    return { products: recentForUser(ctx.user.id, limit).map(pub) };
  }
  function recentForUser(userId, limit) {
    var lastUsed = {};
    Db.findAll('food_logs', function (r) { return r.user_id === userId && !r.deleted_at; }).forEach(function (l) {
      var k = str_(l.created_at);
      if (!lastUsed[l.product_id] || lastUsed[l.product_id] < k) lastUsed[l.product_id] = k;
    });
    var all = Db.findAll('products', function (r) { return !r.deleted_at && (lastUsed[r.id] || r.created_by === userId); });
    all.sort(function (a, b) { return str_(lastUsed[b.id] || b.created_at).localeCompare(str_(lastUsed[a.id] || a.created_at)); });
    return all.slice(0, limit);
  }

  /** 商品画像（任意）。スクリプトプロパティ DRIVE_FOLDER_ID があるときだけ Drive に保存する */
  function saveImage_(productId, base64, mediaType, ctx) {
    var folderId = prop_('DRIVE_FOLDER_ID');
    if (!folderId || !base64) return;
    try {
      var data = String(base64).replace(/^data:[^;]+;base64,/, '');
      var blob = Utilities.newBlob(Utilities.base64Decode(data), mediaType || 'image/jpeg', productId + '.jpg');
      var file = DriveApp.getFolderById(folderId).createFile(blob);
      Db.insert('product_images', { id: uuid_(), product_id: productId, drive_file_id: file.getId(), kind: 'label', created_by: ctx.user.id, created_at: nowIso_() });
    } catch (e) { try { console.warn('画像の保存に失敗: ' + e); } catch (e2) { /* noop */ } }
  }

  return { pub: pub, byId: byId, byJan: byJan, get: get, create: create, update: update, suggest: suggest, recent: recent, recentForUser: recentForUser };
})();
