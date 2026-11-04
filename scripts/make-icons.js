'use strict';
/* web/icons/icon.svg から icon-192.png / icon-512.png を作る（Playwright の Chromium を使用） */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
(async () => {
  const dir = path.join(__dirname, '..', 'web', 'icons');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<body style="margin:0;background:transparent">${svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}</body>`);
    await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
  await browser.close();
  console.log('icons written');
})();
