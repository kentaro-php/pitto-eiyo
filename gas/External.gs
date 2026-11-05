/* ============================================================================
 * External.gs — 外部データソース（設計書 7節）
 *  - Open Food Facts API v2: JAN → 100gあたりの栄養成分（ODbL。source=off で分離保持）
 *  - Yahoo!ショッピング 商品検索API v3: JAN → 商品名・画像（栄養は無い）。YAHOO_CLIENT_ID が必要
 *  - ウェブ照会（Claude + web_search / web_fetch）: JAN → 商品名と栄養成分表示をメーカー・通販ページから読む。
 *    CLAUDE_API_KEY が必要。WEB_LOOKUP=0 で無効。結果は CacheService に 6 時間保持（同じ JAN で課金を繰り返さない）
 *  どれも失敗時は null を返し、呼び出し側は手入力（OCR登録）へ進む。
 * ========================================================================== */
var External = (function () {
  var L = function () { return PittoLogic; };
  function ua_() { return prop_('APP_USER_AGENT', 'PittoEiyo/1.0 (GAS)'); }
  var WEB_CACHE_SEC = 21600;
  var lastWebError = '';
  var WEB_SYSTEM = '日本で販売されている食品のJANコードから、商品名と栄養成分表示をウェブで調べ、指定のJSONだけを返す調査係です。' +
    '数値は根拠ページに書かれた値だけを使い、推測で埋めません。説明文は書きません。';
  function webPrompt_(jan, nameHint) {
    return [
      'JANコード ' + jan + ' の食品を調べてください。' + (nameHint ? '（商品名の候補: ' + nameHint + '）' : ''),
      '手順: "' + jan + '" でウェブ検索し、メーカー公式サイトか大手通販の商品ページで、商品名と栄養成分表示（熱量・たんぱく質・脂質・炭水化物・食塩相当量）を確認する。' +
        '栄養成分表が検索結果に無ければ該当ページを取得して読む。検索は3回、取得は2回まで。',
      '結果は次のキーを持つ JSON オブジェクトを ```json コードブロックで 1 つだけ返す:',
      '{"found": true か false, "name": 商品名, "brand": メーカー名, "quantity_text": 内容量の表記(例 "110g"), ' +
        '"basis": "per_100g" | "per_package" | "per_serving" | null, "serving_g": 基準量の質量(gかml) か null, "package_g": 内容量の数値(gかml) か null, ' +
        '"energy_kcal": 数値 か null, "protein_g": 数値 か null, "fat_g": 数値 か null, "carb_g": 数値 か null, "salt_g": 数値 か null, ' +
        '"sodium_mg": 数値 か null, "sugar_g": 数値 か null, "fiber_g": 数値 か null, "satfat_g": 数値 か null, ' +
        '"confidence": 0〜1, "source_url": 根拠ページのURL, "notes": 短い補足}',
      'ルール:',
      '- 商品を特定できなければ found=false にする。栄養成分が見つからない項目は null（推測禁止）。',
      '- basis: 「100gあたり」「100mlあたり」なら per_100g、「1包装/1袋/1本/1個あたり」なら per_package、「1食（○g）あたり」なら per_serving。',
      '- serving_g: basis が per_package / per_serving のときの基準量の質量。per_100g なら null。',
      '- 「食塩相当量」が無く「ナトリウム(mg)」だけなら sodium_mg に入れ salt_g は null。「炭水化物」が無く糖質・食物繊維だけなら sugar_g / fiber_g に入れ carb_g は null。',
      '- 数値は単位を付けず数値だけ。日本語の商品名を優先する。',
      '- confidence: 商品の同定と数値の確からしさ。公式サイトで確認できたら高く、通販サイトの転記だけなら中程度、同定が怪しければ低く。'
    ].join('\n');
  }

  /** JAN → ウェブ検索で商品名と栄養成分を読む。見つからない／未設定／失敗は null */
  function webLookup(jan, nameHint) {
    if (prop_('WEB_LOOKUP', '1') !== '1') return null;
    var key = prop_('CLAUDE_API_KEY');
    if (!key) return null;
    var cache = null, cacheKey = 'weblookup:' + jan;
    try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
    if (cache) {
      var hit = cache.get(cacheKey);
      if (hit) { try { var parsed = JSON.parse(hit); return parsed && parsed.found ? parsed : null; } catch (e) { /* 再取得 */ } }
    }
    var result = null;
    lastWebError = '';
    if (!webBudgetOk_()) { lastWebError = '本日のウェブ照会の上限（WEB_LOOKUP_DAILY_LIMIT）に達しました。'; return null; }
    try {
      result = webLookupClaude_(key, jan, nameHint);
    } catch (e) {
      lastWebError = str_(e && e.message ? e.message : e).slice(0, 300);
      try { console.warn('[web_lookup] ' + jan + ': ' + lastWebError); } catch (e2) { /* noop */ }
      return null;
    }
    if (cache) { try { cache.put(cacheKey, JSON.stringify(result || { found: false }), WEB_CACHE_SEC); } catch (e) { /* noop */ } }
    return result && result.found ? result : null;
  }

  /** 1 日の照会回数の上限（課金の暴走防止。既定 100 回／日。スクリプトプロパティ WEB_LOOKUP_COUNT に "yyyy-MM-dd:n" で記録） */
  function webBudgetOk_() {
    var limit = Number(prop_('WEB_LOOKUP_DAILY_LIMIT', '100'));
    if (!(limit > 0)) return true;
    var today = todayJst_(), props = PropertiesService.getScriptProperties();
    var cur = str_(props.getProperty('WEB_LOOKUP_COUNT')).split(':');
    var n = cur[0] === today ? Number(cur[1]) || 0 : 0;
    if (n >= limit) return false;
    props.setProperty('WEB_LOOKUP_COUNT', today + ':' + (n + 1));
    return true;
  }
  function webLookupClaude_(key, jan, nameHint) {
    var model = prop_('WEB_LOOKUP_MODEL', prop_('CLAUDE_MODEL', 'claude-opus-5-5'));
    var messages = [{ role: 'user', content: webPrompt_(jan, nameHint) }];
    var body = {
      model: model, max_tokens: 2048, fallbacks: 'default', system: WEB_SYSTEM, messages: messages,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' } },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, max_content_tokens: 20000 }
      ]
    };
    var text = '';
    for (var round = 0; round < 4; round++) {
      var res = fetchJson_('https://api.anthropic.com/v1/messages', {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
        headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' }
      });
      if (res.code !== 200 || !res.json) throw new Error('claude ' + res.code + ' ' + str_(res.text).slice(0, 200));
      var msg = res.json;
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content || [] }); continue; }
      if (msg.stop_reason === 'refusal') return { found: false };
      text = (msg.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
      break;
    }
    var json = parseJsonLoose_(text);
    if (!json) return { found: false };
    return normalizeWeb_(json, jan);
  }

  function parseJsonLoose_(text) {
    var t = str_(text);
    var fences = t.match(/```(?:json)?\s*([\s\S]*?)```/g);
    if (fences && fences.length) t = fences[fences.length - 1].replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t.trim()); } catch (e) {
      var m = t.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fallthrough */ } }
      return null;
    }
  }
  function normalizeWeb_(d, jan) {
    if (!d || typeof d !== 'object') return { found: false };
    var out = Ocr.normalize(d);
    out.found = d.found !== false && !!out.name;
    out.brand = typeof d.brand === 'string' ? d.brand.trim().slice(0, 80) : '';
    out.quantity_text = typeof d.quantity_text === 'string' ? d.quantity_text.trim().slice(0, 40) : '';
    var url = typeof d.source_url === 'string' ? d.source_url.trim() : '';
    out.source_url = /^https?:\/\/\S+$/.test(url) ? url.slice(0, 500) : '';
    out.jan = jan;
    if (out.package_g == null && out.quantity_text) out.package_g = parseQuantity_(out.quantity_text);
    out.provider = 'web';
    return out;
  }

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
  function webLookupError() { return lastWebError; }
  return { openFoodFacts: openFoodFacts, yahooProductName: yahooProductName, webLookup: webLookup, webLookupError: webLookupError, parseQuantity_: parseQuantity_ };
})();
