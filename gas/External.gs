/* ============================================================================
 * External.gs — 外部データソース（設計書 7節）
 *  - Open Food Facts API v2: JAN → 100gあたりの栄養成分（ODbL。source=off で分離保持）
 *  - Yahoo!ショッピング 商品検索API v3: JAN → 商品名・画像（栄養は無い）。YAHOO_CLIENT_ID が必要
 *  どちらも失敗時は null を返し、呼び出し側は手入力（OCR登録）へ進む。
 * ========================================================================== */
var External = (function () {
  var L = function () { return PittoLogic; };
  function ua_() { return prop_('APP_USER_AGENT', 'PittoEiyo/1.0 (GAS)'); }

  function parseQuantity_(s) {
    s = str_(s).toLowerCase().replace(/,/g, '.');
    var m = s.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|cl)\b/);
    if (!m) return null;
    var v = Number(m[1]);
    if (m[2] === 'kg' || m[2] === 'l') v *= 1000;
    if (m[2] === 'cl') v *= 10;
    return v > 0 ? v : null;
  }

  function openFoodFacts(jan) {
    if (prop_('DISABLE_OFF') === '1') return null;
    try {
      var url = 'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(jan) + '.json?fields=code,product_name,product_name_ja,brands,quantity,serving_size,nutriments';
      var res = fetchJson_(url, { method: 'get', headers: { 'User-Agent': ua_() }, followRedirects: true });
      if (res.code !== 200 || !res.json || Number(res.json.status) !== 1 || !res.json.product) return null;
      var pr = res.json.product, n = pr.nutriments || {};
      var num = L().num;
      var kcal = num(n['energy-kcal_100g']);
      if (kcal == null && num(n['energy_100g']) != null) kcal = Math.round(num(n['energy_100g']) / 4.184);
      if (kcal == null) return null;
      var salt = num(n['salt_100g']);
      if (salt == null && num(n['sodium_100g']) != null) salt = L().round(num(n['sodium_100g']) * 2.54, 2);
      var out = {
        jan: jan, name: str_(pr.product_name_ja || pr.product_name).trim().slice(0, 120), brand: str_(pr.brands).slice(0, 80),
        quantity_text: str_(pr.quantity).slice(0, 40), serving_basis: 'per_100g',
        serving_g: parseQuantity_(pr.serving_size), package_g: parseQuantity_(pr.quantity),
        energy_kcal: kcal, protein_g: num(n['proteins_100g']) || 0, fat_g: num(n['fat_100g']) || 0,
        carb_g: num(n['carbohydrates_100g']) || 0, salt_g: salt || 0
      };
      if (!out.name) out.name = 'JAN ' + jan;
      var sugar = num(n['sugars_100g']), fiber = num(n['fiber_100g']), sat = num(n['saturated-fat_100g']);
      if (sugar != null) out.sugar_g = sugar;
      if (fiber != null) out.fiber_g = fiber;
      if (sat != null) out.satfat_g = sat;
      return out;
    } catch (e) {
      return null;
    }
  }

  function yahooProductName(jan) {
    var appid = prop_('YAHOO_CLIENT_ID');
    if (!appid) return null;
    try {
      var url = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?appid=' + encodeURIComponent(appid) + '&jan_code=' + encodeURIComponent(jan) + '&results=1';
      var res = fetchJson_(url, { method: 'get' });
      if (res.code !== 200 || !res.json || !res.json.hits || !res.json.hits.length) return null;
      var hit = res.json.hits[0];
      return { name: str_(hit.name).slice(0, 120), brand: hit.brand ? str_(hit.brand.name).slice(0, 80) : '', image_url: hit.image ? str_(hit.image.medium) : '' };
    } catch (e) {
      return null;
    }
  }
  return { openFoodFacts: openFoodFacts, yahooProductName: yahooProductName, parseQuantity_: parseQuantity_ };
})();
