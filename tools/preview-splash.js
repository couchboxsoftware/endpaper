// Preview only: shows renderer/splash.html without starting the app, over a stand-in desktop
// colour, and saves frames to build/splash-preview-*.png (not committed): the book opening, the
// page set and loading, the page turning once "ready", and the empty page before it fades.
// Run: node_modules\electron\dist\electron.exe tools/preview-splash.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const build = path.join(__dirname, '..', 'build');
const version = require('../package.json').version;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(build, { recursive: true });
  const win = new BrowserWindow({ width: 640, height: 400, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(30);
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'), { query: { v: version } }).catch(() => {});
  });
  // The splash window is see-through; a desktop-like colour shows its shape.
  await win.webContents.executeJavaScript(`document.documentElement.style.background = '#3d5168'`);
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const file = path.join(build, `splash-preview-${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log('wrote', path.relative(path.join(__dirname, '..'), file));
  };
  const t0 = Date.now();
  const at = (ms) => wait(Math.max(0, ms - (Date.now() - t0)));
  await at(450);
  await shot('a-opening');
  // The loading steps main.js would send: settings, fonts, brand kit, colour.
  for (let i = 0; i < 4; i++) await js('step()'), await wait(250);
  await at(2400);
  await shot('b-loading');
  // Ready: the page turns (no sooner than 3 seconds), rests on an empty page, then fades.
  const done = js('finish()');
  await at(3450);
  await shot('c-turning');
  await at(4050);
  await shot('d-empty-page');
  await done;
  console.log('splash finished after', Date.now() - t0, 'ms');
  app.quit();
});
