// Renders build/icon.png from the brand tile, using Electron's offscreen window.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const BRAND = require('../renderer/brand.js');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent">${BRAND.tile(256)}</body>`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.toPNG());
  app.quit();
});
