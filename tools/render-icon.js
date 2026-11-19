// Renders the app icon from renderer/brand.js into build/icon.png (512x512, see-through corners),
// plus the icon check sheet build/icon-preview.png (820x300, not committed): the tile at 160, 64,
// 32 and 16px and the mark with the wordmark, on a dark half and a light half. Look at the sheet
// whenever the mark changes; the 16px tile on a light taskbar is the hardest test.
// Run: node_modules\electron\dist\electron.exe tools/render-icon.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const BRAND = require('../renderer/brand.js');

const build = path.join(__dirname, '..', 'build');

async function render(html, w, h) {
  const win = new BrowserWindow({ width: w, height: h, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(30);
  const tmp = path.join(os.tmpdir(), `endpaper-render-${Date.now()}.html`);
  fs.writeFileSync(tmp, html);
  // did-finish-load is more forgiving than the loadFile promise for offscreen windows.
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.loadFile(tmp).catch(() => {});
  });
  fs.unlinkSync(tmp);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  win.destroy();
  return img.resize({ width: w, height: h, quality: 'best' });
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // keep running between renders
app.whenReady().then(async () => {
  fs.mkdirSync(build, { recursive: true });
  const page = (body, bg = 'transparent') => `<!doctype html><html><body style="margin:0;background:${bg};overflow:hidden">${body}</body></html>`;
  const icon = await render(page(BRAND.tile(512)), 512, 512);
  fs.writeFileSync(path.join(build, 'icon.png'), icon.toPNG());

  // The wordmark in the standard style (1.6), the same as .ep-word in styles.css.
  const word = (size) => `<span style="font:700 ${size}px 'Segoe UI',sans-serif;letter-spacing:${size >= 30 ? 1 : 0.8}px;color:#eee;line-height:1;white-space:nowrap">end<b style="font-weight:700;color:${BRAND.magenta}">paper</b></span>`;
  const half = (bg) => `<div style="flex:1;background:${bg};display:flex;flex-direction:column;justify-content:center;gap:26px;padding:0 30px">
      <div style="display:flex;align-items:flex-end;gap:22px">${BRAND.tile(160)}${BRAND.tile(64)}${BRAND.tile(32)}${BRAND.tile(16)}</div>
      <div style="display:flex;align-items:center;gap:12px"><svg viewBox="5 9 38 31" width="44" height="36">${BRAND.bookPaths(BRAND.magenta, 3)}</svg>${word(30)}</div></div>`;
  const preview = await render(page(`<div style="display:flex;height:100vh">${half('#121212')}${half('#f2f2f2')}</div>`, '#000'), 820, 300);
  fs.writeFileSync(path.join(build, 'icon-preview.png'), preview.toPNG());
  console.log('icon written: build/icon.png (512x512) and build/icon-preview.png');
  app.quit();
});
