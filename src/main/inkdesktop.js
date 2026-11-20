// Inkdesktop, Couchbox Software's PDF app: finding it on this computer and opening exported PDFs
// in it. Endpaper offers it after export ("Open in Inkdesktop after export"), and when it isn't
// installed, asks once in a while whether you'd like to try it (renderer/inkdesktop.js).
//
// Finding it: Inkdesktop's installer registers it as a PDF app (the file type "Inkdesktop.pdf"),
// whose open command names the exe. If that's missing, the usual per-user install folder.
//
// Testing: ENDPAPER_TEST_INKDESKTOP=none pretends it isn't installed, or names a file to treat as
// its exe. While ENDPAPER_TEST is set nothing is really opened: each launch is recorded in
// global.endpaperOpened instead, for the checks in test/ to read.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { shell } = require('electron');

const DOWNLOAD_PAGE = 'https://github.com/couchboxsoftware/inkdesktop/releases/latest';
const testing = !!process.env.ENDPAPER_TEST;
if (testing) global.endpaperOpened = [];

const regDefault = (key) =>
  new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err) return resolve(null);
      const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(String(out));
      resolve(m ? m[1].trim() : null);
    });
  });

// The exe in an open command: "C:\…\Inkdesktop.exe" "%1", or the same without quotes (which is
// how Inkdesktop's installer writes it), even with spaces in the path.
function exeFrom(cmd) {
  if (!cmd) return null;
  return /^"([^"]+\.exe)"/i.exec(cmd) || /^(.+?\.exe)(?=\s|$)/i.exec(cmd);
}

// The exe's path, or null when Inkdesktop isn't installed.
async function find() {
  const t = process.env.ENDPAPER_TEST_INKDESKTOP;
  if (t) return t === 'none' ? null : fs.existsSync(t) ? t : null;
  for (const root of ['HKCU', 'HKLM']) {
    const cmd = await regDefault(`${root}\\Software\\Classes\\Inkdesktop.pdf\\shell\\open\\command`);
    const exe = exeFrom(cmd);
    if (exe && fs.existsSync(exe[1])) return exe[1];
  }
  const usual = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'inkdesktop', 'Inkdesktop.exe');
  return fs.existsSync(usual) ? usual : null;
}

const isExport = (p) => typeof p === 'string' && /\.(pdf|png|jpe?g)$/i.test(p) && fs.existsSync(p);
const record = (what, target) => {
  global.endpaperOpened.push({ what, target });
  return true;
};

// Opens a PDF in Inkdesktop. If it's already running, it takes the file over.
async function open(pdf) {
  if (!isExport(pdf) || !/\.pdf$/i.test(pdf)) return false;
  const exe = await find();
  if (!exe) return false;
  if (testing) return record('inkdesktop', pdf);
  spawn(exe, [pdf], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return true;
}

// Opens an exported file in Windows' default app for it (a PDF viewer, a picture app).
async function openDefault(p) {
  if (!isExport(p)) return false;
  if (testing) return record('default', p);
  return (await shell.openPath(p)) === '';
}

// Shows a file (or the folder it's in) in File Explorer.
function showFolder(p) {
  if (typeof p !== 'string' || !fs.existsSync(p)) return false;
  if (testing) return record('folder', p);
  shell.showItemInFolder(p);
  return true;
}

// Inkdesktop's download page: its latest release on GitHub.
function getIt() {
  if (testing) return record('download-page', DOWNLOAD_PAGE);
  shell.openExternal(DOWNLOAD_PAGE);
  return true;
}

module.exports = { find, open, openDefault, showFolder, getIt, exeFrom, DOWNLOAD_PAGE };
