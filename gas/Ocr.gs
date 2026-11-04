/* ============================================================================
 * Ocr.gs — 栄養成分表示の写真 → 5項目（設計書 7節）
 *  - 既定は Claude（Anthropic Messages API）。スクリプトプロパティ OCR_PROVIDER=gemini で Gemini に切替。
 *  - API キーはスクリプトプロパティ CLAUDE_API_KEY / GEMINI_API_KEY に置く（コードに書かない）。
 *  - 返却スキーマ: { basis, serving_g, package_g, name, energy_kcal, protein_g, fat_g, carb_g, salt_g,
 *                   sodium_mg, sugar_g, fiber_g, satfat_g, confidence, notes }
 *  - 誤読があり得るのでフロントは必ず確認画面を挟む（confidence が低い項目は強調）。
 * ========================================================================== */
var Ocr = (function () {
  var L = function () { return PittoLogic; };
  var NUM_OR_NULL = { anyOf: [{ type: 'number' }, { type: 'null' }] };
  var SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['basis', 'serving_g', 'package_g', 'name', 'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'sodium_mg', 'sugar_g', 'fiber_g', 'satfat_g', 'confidence', 'notes'],
    properties: {
      basis: { anyOf: [{ type: 'string', enum: ['per_100g', 'per_package', 'per_serving'] }, { type: 'null' }] },
      serving_g: NUM_OR_NULL, package_g: NUM_OR_NULL,
      name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      energy_kcal: NUM_OR_NULL, protein_g: NUM_OR_NULL, fat_g: NUM_OR_NULL, carb_g: NUM_OR_NULL, salt_g: NUM_OR_NULL,
      sodium_mg: NUM_OR_NULL, sugar_g: NUM_OR_NULL, fiber_g: NUM_OR_NULL, satfat_g: NUM_OR_NULL,
      confidence: { type: 'number' }, notes: { type: 'string' }
    }
  };
  var SYSTEM = '日本の食品パッケージの「栄養成分表示」を読み取り、指定のJSONだけを返す読取係です。説明文は書きません。';
  var PROMPT = [
    'この画像の栄養成分表示を読み取ってください。',
    'ルール:',
    '- basis: 「100gあたり」「100mlあたり」なら per_100g、「1包装あたり」「1袋あたり」「1本あたり」「1個あたり」なら per_package、「1食（○g）あたり」なら per_serving。読めなければ null。',
    '- serving_g: basis が per_package / per_serving のときの基準量の質量（gまたはml）。per_100g なら null。',
    '- package_g: 内容量（総量）が読めればその数値（gまたはml）。読めなければ null。',
    '- name: 商品名が読めれば入れる。読めなければ null。',
    '- energy_kcal / protein_g / fat_g / carb_g / salt_g: 熱量・たんぱく質・脂質・炭水化物・食塩相当量。単位を付けず数値だけ。',
    '- 「食塩相当量」が無く「ナトリウム(mg)」だけの場合は sodium_mg に入れ、salt_g は null。',
    '- 「炭水化物」が無く「糖質」「食物繊維」だけなら sugar_g / fiber_g に入れ、carb_g は null。飽和脂肪酸があれば satfat_g。',
    '- 読めない項目は null。推測で埋めない。',
    '- confidence: 読み取り全体の確からしさ（0〜1）。不鮮明・一部欠けなら低くする。notes: 気になった点を短く（例: 「ナトリウム表記」「写真がぼやけている」）。無ければ空文字。'
  ].join('\n');

  /** POST ocr.parse { image_base64, media_type } */
  function parse(params, ctx) {
    var data = str_(params.image_base64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    if (!data) throw new ApiError('validation', '画像がありません。', { field: 'image_base64' });
    if (data.length > 7000000) throw new ApiError('validation', '画像が大きすぎます（5MB以下にしてください）。', { field: 'image_base64' });
    var mediaType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].indexOf(params.media_type) >= 0 ? params.media_type : 'image/jpeg';
    var provider = prop_('OCR_PROVIDER', 'claude');
    var raw = provider === 'gemini' ? gemini_(data, mediaType) : claude_(data, mediaType);
    return { result: normalize_(raw.json), provider: provider, model: raw.model };
  }

  function claude_(data, mediaType) {
    var key = prop_('CLAUDE_API_KEY');
    if (!key) throw new ApiError('internal', 'スクリプトプロパティ CLAUDE_API_KEY が設定されていません。');
    var model = prop_('CLAUDE_MODEL', 'claude-opus-5-5');
    var body = {
      model: model,
      max_tokens: 1024,
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: data } },
        { type: 'text', text: PROMPT }
      ] }]
    };
    var res = fetchJson_('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
      headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' }
    });
    if (res.code === 401 || res.code === 403) throw new ApiError('internal', 'Claude API キーが無効です。');
    if (res.code === 429 || res.code === 529) throw new ApiError('rate_limited', '読み取りが混み合っています。しばらくしてからもう一度お試しください。');
    if (res.code !== 200 || !res.json) throw new ApiError('upstream', '読み取りサービスでエラーが起きました（' + res.code + '）。', { body: (res.text || '').slice(0, 300) });
    var msg = res.json;
    if (msg.stop_reason === 'refusal') throw new ApiError('ocr_refused', 'この画像は読み取れませんでした。別の写真でお試しください。');
    if (msg.stop_reason === 'max_tokens') throw new ApiError('ocr_failed', '読み取り結果が長すぎて解釈できませんでした。');
    var text = (msg.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    return { json: parseJson_(text), model: msg.model || model };
  }

  function gemini_(data, mediaType) {
    var key = prop_('GEMINI_API_KEY');
    if (!key) throw new ApiError('internal', 'スクリプトプロパティ GEMINI_API_KEY が設定されていません。');
    var model = prop_('GEMINI_MODEL', 'gemini-2.5-flash');
    var body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: data } }, { text: PROMPT + '\n\n次のキーを持つJSONオブジェクトだけを返してください: ' + SCHEMA.required.join(', ') }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 }
    };
    var res = fetchJson_('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body)
    });
    if (res.code === 429) throw new ApiError('rate_limited', '読み取りが混み合っています。しばらくしてからもう一度お試しください。');
    if (res.code !== 200 || !res.json) throw new ApiError('upstream', '読み取りサービスでエラーが起きました（' + res.code + '）。', { body: (res.text || '').slice(0, 300) });
    var cand = (res.json.candidates || [])[0];
    var text = cand && cand.content && cand.content.parts ? cand.content.parts.map(function (p) { return p.text || ''; }).join('') : '';
    return { json: parseJson_(text), model: model };
  }

  function parseJson_(text) {
    var t = str_(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t); } catch (e) {
      var m = t.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fallthrough */ } }
      throw new ApiError('ocr_failed', '読み取り結果を解釈できませんでした。もう一度撮影してください。');
    }
  }
  function normalize_(d) {
    if (!d || typeof d !== 'object') throw new ApiError('ocr_failed', '読み取り結果を解釈できませんでした。');
    var out = {}, num = L().num;
    out.basis = L().BASES.indexOf(d.basis) >= 0 ? d.basis : null;
    ['serving_g', 'package_g', 'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g', 'sodium_mg', 'sugar_g', 'fiber_g', 'satfat_g'].forEach(function (k) {
      var v = num(d[k]); out[k] = (v == null || v < 0) ? null : v;
    });
    if (out.salt_g == null && out.sodium_mg != null) out.salt_g = L().sodiumToSalt(out.sodium_mg);
    if (out.carb_g == null && out.sugar_g != null) out.carb_g = L().round(out.sugar_g + (out.fiber_g || 0), 1);
    out.name = typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 120) : null;
    var c = num(d.confidence); out.confidence = c == null ? 0.5 : Math.max(0, Math.min(1, c));
    out.notes = typeof d.notes === 'string' ? d.notes.slice(0, 200) : '';
    out.filled = ['energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'salt_g'].filter(function (k) { return out[k] != null; }).length;
    return out;
  }
  return { parse: parse, SCHEMA: SCHEMA };
})();
