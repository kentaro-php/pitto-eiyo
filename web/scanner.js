/* ピッと栄養 バーコード読取
 *  - ライブ: getUserMedia のプレビューを、端末が BarcodeDetector 対応ならそれで、未対応（iOS Safari）なら
 *    ZXing（純JS）で中央の帯を数回/秒デコードする。同じ値が2回続いたら確定（誤読対策）。
 *  - 写真: <input type=file capture> の静止画から ZXing / BarcodeDetector で読む（ホーム画面モードなど
 *    カメラが使えない環境の予備手段）。
 *  - OCR 用に画像を縮小して JPEG/base64 にする shrinkToJpeg も提供。 */
window.PittoScanner = (function () {
  'use strict';
  var L = window.PittoLogic;
  var stream = null, running = false, timer = null, video = null, onResult = null, onStatus = null;
  var lastCode = null, lastCount = 0, reader = null, detector = null, canvas = null, detectorChecked = false;

  function supportsLive() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false;
  }
  function zxingReader() {
    if (!window.ZXing) return null;
    var Z = window.ZXing, hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
    var r = new Z.MultiFormatReader();
    r.setHints(hints);
    return r;
  }
  async function nativeDetector() {
    if (detectorChecked) return detector;
    detectorChecked = true;
    try {
      if (window.BarcodeDetector) {
        var f = await window.BarcodeDetector.getSupportedFormats();
        if (f && f.indexOf('ean_13') >= 0) detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      }
    } catch (e) { detector = null; }
    return detector;
  }
  async function start(videoEl, cb, statusCb) {
    stop();
    video = videoEl; onResult = cb; onStatus = statusCb || function () {};
    if (!supportsLive()) { var err = new Error('この環境ではカメラを使えません。'); err.code = 'unsupported'; throw err; }
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* autoplay はユーザー操作後なら通る */ }
    running = true; lastCode = null; lastCount = 0;
    await nativeDetector();
    if (!detector) reader = zxingReader();
    onStatus(detector ? 'native' : (reader ? 'zxing' : 'loading'));
    loop();
  }
  async function loop() {
    if (!running) return;
    try {
      var code = null;
      if (video.readyState >= 2) {
        if (detector) {
          var res = await detector.detect(video);
          for (var i = 0; i < res.length; i++) { var v = L.normJan(res[i].rawValue); if (L.eanValid(v)) { code = v; break; } }
        } else {
          if (!reader) reader = zxingReader();
          if (reader) code = decodeFrame();
        }
      }
      if (code) {
        if (code === lastCode) lastCount++; else { lastCode = code; lastCount = 1; }
        if (detector || lastCount >= 2) { var found = code; stop(); onResult(found); return; }
      }
    } catch (e) { /* 1フレームの失敗は無視 */ }
    timer = setTimeout(loop, detector ? 120 : 170);
  }
  function decodeFrame() {
    var Z = window.ZXing;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    var scale = Math.min(1, 800 / vw);
    var w = Math.round(vw * scale), bandH = Math.max(1, Math.round(vh * scale * 0.5));
    if (!canvas) canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = bandH;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, Math.round(vh * 0.25), vw, Math.round(vh * 0.5), 0, 0, w, bandH);
    try {
      var r = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas))));
      var t = L.normJan(r.getText());
      return L.eanValid(t) ? t : null;
    } catch (e) { return null; }
    finally { try { reader.reset(); } catch (e2) { /* noop */ } }
  }
  function stop() {
    running = false;
    clearTimeout(timer);
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (video) { try { video.pause(); video.srcObject = null; } catch (e) { /* noop */ } }
  }
  function isRunning() { return running; }

  /* ---------- 静止画 ---------- */
  async function loadImage(file) {
    if (window.createImageBitmap) {
      try { var b = await createImageBitmap(file, { imageOrientation: 'from-image' }); return { source: b, w: b.width, h: b.height }; } catch (e) { /* fallthrough */ }
      try { var b2 = await createImageBitmap(file); return { source: b2, w: b2.width, h: b2.height }; } catch (e2) { /* fallthrough */ }
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    await new Promise(function (res, rej) { img.onload = res; img.onerror = function () { rej(new Error('画像を開けませんでした')); }; img.src = url; });
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, url: url };
  }
  function renderTo(bmp, side, rot, crop) {
    var sw = bmp.w, sh = bmp.h, sx = 0, sy = 0;
    if (crop < 1) { sw = Math.round(bmp.w * crop); sh = Math.round(bmp.h * crop); sx = Math.round((bmp.w - sw) / 2); sy = Math.round((bmp.h - sh) / 2); }
    var scale = Math.min(1, side / Math.max(sw, sh));
    var dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
    var c = document.createElement('canvas'), ctx;
    if (rot === 90) { c.width = dh; c.height = dw; ctx = c.getContext('2d'); ctx.translate(dh, 0); ctx.rotate(Math.PI / 2); }
    else { c.width = dw; c.height = dh; ctx = c.getContext('2d'); }
    ctx.drawImage(bmp.source, sx, sy, sw, sh, 0, 0, dw, dh);
    return c;
  }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  async function decodeFile(file) {
    var bmp = await loadImage(file);
    try {
      var det = await nativeDetector();
      if (det) {
        var res = await det.detect(bmp.source);
        for (var i = 0; i < res.length; i++) { var v = L.normJan(res[i].rawValue); if (L.eanValid(v)) return v; }
      }
    } catch (e) { /* fallthrough */ }
    var r = zxingReader();
    if (!r) throw new Error('読み取りライブラリを読み込めませんでした。通信状態を確認して再読み込みしてください。');
    var attempts = [[1400, 0, 1], [1400, 90, 1], [1400, 0, 0.6], [1000, 0, 1], [2000, 0, 1], [1000, 90, 1], [1400, 90, 0.6], [2000, 90, 1]];
    var Z = window.ZXing;
    for (var a = 0; a < attempts.length; a++) {
      var at = attempts[a], c = renderTo(bmp, at[0], at[1], at[2]);
      try {
        var rr = r.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c))));
        var t = L.normJan(rr.getText());
        if (L.eanValid(t)) return t;
      } catch (e) { /* 次の試行へ */ }
      try { r.reset(); } catch (e2) { /* noop */ }
      await tick();
    }
    if (bmp.url) URL.revokeObjectURL(bmp.url);
    return null;
  }
  /** OCR 送信用: 長辺 maxSide px の JPEG にして base64 を返す */
  async function shrinkToJpeg(file, maxSide, quality) {
    var bmp = await loadImage(file);
    var c = renderTo(bmp, maxSide || 1600, 0, 1);
    var dataUrl = c.toDataURL('image/jpeg', quality || 0.85);
    if (bmp.url) URL.revokeObjectURL(bmp.url);
    return { base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', bytes: Math.round((dataUrl.length - 23) * 3 / 4) };
  }
  return { supportsLive: supportsLive, start: start, stop: stop, isRunning: isRunning, decodeFile: decodeFile, shrinkToJpeg: shrinkToJpeg };
})();
