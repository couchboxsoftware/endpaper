/* Endpaper main process: the window, files, fonts, colour profiles, settings, brand kit,
   templates (with a bin), recovery files and What's new. The renderer does the drawing,
   the layout and the PDF; this side only touches the disk and the system. */
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const VERSION = require('./package.json').version;
const FILE_EXT = 'endpaper';
const BIN_DAYS = 30;

// Test mode (EP_TEST=path to a script): a separate settings folder, and the script drives the app.
if (process.env.EP_TEST_USERDATA) app.setPath('userData', process.env.EP_TEST_USERDATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const user = (...p) => path.join(app.getPath('userData'), ...p);
const ensureDir = (d) => (fs.mkdirSync(d, { recursive: true }), d);

/* ---------- small JSON store ---------- */
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

const DEFAULT_PROFILE = 'C:\\Windows\\System32\\spool\\drivers\\color\\CoatedFOGRA39.icc';
const DEFAULTS = {
  openMode: 'last', // window | maximised | fullscreen | last
  bounds: null,
  maximized: false,
  units: 'mm',
  bleed: 3,
  settingsTab: 'general',
  profile: fs.existsSync(DEFAULT_PROFILE) ? DEFAULT_PROFILE : null,
  intent: 'relative', // relative | perceptual
  cropMarks: true,
  imageQuality: 92,
  snap: true,
  showGuides: true,
  lastSeenVersion: null,
  recent: [],
  reopen: [], // designs to open again after an update: [{ path, surface }]
};
let settings = { ...DEFAULTS, ...readJSON(user('settings.json'), {}) };
const saveSettings = () => writeJSON(user('settings.json'), settings);

/* ---------- window ---------- */
let win = null;
let forceClose = false;
let pendingOpen = fileFromArgs(process.argv);

function fileFromArgs(argv) {
  const f = argv.find((a) => a.toLowerCase().endsWith('.' + FILE_EXT) && fs.existsSync(a));
  return f || null;
}

function boundsVisible(b) {
  if (!b) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 10 && b.y < a.y + a.height - 100;
  });
}

function createWindow() {
  const b = settings.openMode === 'last' && boundsVisible(settings.bounds) ? settings.bounds : { width: 1440, height: 900 };
  win = new BrowserWindow({
    ...b,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#17161a',
    title: 'Endpaper',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  win.removeMenu();
  win.once('ready-to-show', () => {
    if (settings.openMode === 'maximised' || (settings.openMode === 'last' && settings.maximized)) win.maximize();
    if (settings.openMode === 'fullscreen') win.setFullScreen(true);
    win.show();
  });
  const remember = () => {
    if (!win || win.isDestroyed() || win.isFullScreen()) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized && !win.isMinimized()) settings.bounds = win.getBounds();
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', (e) => {
    remember();
    saveSettings();
    if (forceClose) return;
    e.preventDefault();
    win.webContents.send('app:close-request');
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  win.loadURL('app://endpaper/renderer/index.html');
  if (process.env.EP_TEST) {
    win.webContents.on('console-message', (e) => console.log('[page]', e.message));
    win.webContents.once('did-finish-load', async () => {
      try {
        await require(process.env.EP_TEST)({
          win,
          exec: (js) => win.webContents.executeJavaScript(js, true),
          shot: async (file) => fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()),
          write: (file, b64) => fs.writeFileSync(file, Buffer.from(b64, 'base64')),
        });
      } catch (e) {
        console.error('TEST FAILED', e);
      }
      forceClose = true;
      app.quit();
    });
  }
}

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const f = fileFromArgs(argv);
  if (f) win.webContents.send('app:open-file', f);
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const file = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname)));
    if (!file.startsWith(ROOT)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  purgeBin();
  createWindow();
  startUpdater();
});

/* ---------- updates ---------- */
let updater = null;
let prepareWaiter = null;
function startUpdater() {
  const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
  updater = require('./src/main/updater').create({
    send,
    // Ask the window to save the open design; it answers through update:prepared.
    prepare: () =>
      new Promise((resolve) => {
        if (!win || win.isDestroyed()) return resolve({ ok: true, files: [] });
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        prepareWaiter = resolve;
        send('update:prepare');
      }),
    beforeInstall: (files) => {
      settings.reopen = files.filter((f) => f && f.path && fs.existsSync(f.path));
      saveSettings();
      forceClose = true;
    },
  });
  win.webContents.once('did-finish-load', () => updater.start());
}
ipcMain.handle('update:state', () => (updater ? updater.getState() : { status: 'off' }));
ipcMain.handle('update:check', () => updater && updater.check(true));
ipcMain.handle('update:download', () => updater && updater.download());
ipcMain.handle('update:install', () => updater && updater.installNow());
ipcMain.handle('update:releases', () => updater && updater.openReleases());
ipcMain.handle('update:prepared', (_e, r) => {
  const w = prepareWaiter;
  prepareWaiter = null;
  if (w) w(r);
});
app.on('window-all-closed', () => app.quit());

/* ---------- IPC: app ---------- */
const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

handle('app:info', () => {
  const version = VERSION;
  const updated = !!settings.lastSeenVersion && settings.lastSeenVersion !== version;
  const firstRun = !settings.lastSeenVersion;
  settings.lastSeenVersion = version;
  // After an update, open what was open before; otherwise a file double-clicked in Explorer.
  const reopen = (settings.reopen || []).filter((f) => f && f.path && fs.existsSync(f.path));
  settings.reopen = [];
  saveSettings();
  const f = pendingOpen;
  pendingOpen = null;
  return { version, updated, firstRun, openFile: f, reopen, userData: app.getPath('userData') };
});
handle('app:close-ok', () => {
  forceClose = true;
  win.close();
});
handle('app:confirm', async (o) => {
  const r = await dialog.showMessageBox(win, { type: o.type || 'question', buttons: o.buttons, defaultId: 0, cancelId: o.cancelId ?? o.buttons.length - 1, title: 'Endpaper', message: o.message, detail: o.detail || '', noLink: true });
  return r.response;
});
handle('app:reveal', (p) => shell.showItemInFolder(p));
handle('app:readAppFile', (rel) => {
  const f = path.normalize(path.join(ROOT, rel));
  if (!f.startsWith(ROOT)) throw new Error('outside app');
  return fs.readFileSync(f);
});
handle('settings:get', () => settings);
handle('settings:set', (patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  return settings;
});

/* ---------- What's new ---------- */
handle('changelog:get', () => {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const entries = [];
  let cur = null;
  let group = null;
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^## (\S+) · (.+)$/))) {
      cur = { version: m[1], date: m[2], headline: '', groups: [] };
      entries.push(cur);
      group = null;
    } else if (!cur) continue;
    else if ((m = line.match(/^### (.+)$/))) {
      group = { name: m[1], items: [] };
      cur.groups.push(group);
    } else if ((m = line.match(/^- (.+)$/)) && group) group.items.push(m[1]);
    else if (line.trim() && !group && !cur.headline) cur.headline = line.trim();
  }
  return entries;
});

/* ---------- files ---------- */
function addRecent(p) {
  settings.recent = [p, ...settings.recent.filter((r) => r.toLowerCase() !== p.toLowerCase())].slice(0, 12);
  saveSettings();
}
function atomicWrite(file, data) {
  const tmp = file + '.saving';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const docFilters = [{ name: 'Endpaper design', extensions: [FILE_EXT] }];

handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: docFilters });
  if (r.canceled || !r.filePaths[0]) return null;
  return readDoc(r.filePaths[0]);
});
function readDoc(p) {
  const text = fs.readFileSync(p, 'utf8');
  addRecent(p);
  return { path: p, text };
}
handle('file:read', (p) => readDoc(p));
handle('file:save', async ({ path: p, text, name, saveAs }) => {
  if (!p || saveAs) {
    const r = await dialog.showSaveDialog(win, { defaultPath: (name || 'Untitled') + '.' + FILE_EXT, filters: docFilters });
    if (r.canceled || !r.filePath) return null;
    p = r.filePath;
  }
  atomicWrite(p, text);
  addRecent(p);
  return p;
});
handle('file:export', async ({ bytes, name, ext, label }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: label, extensions: [ext] }] });
  if (r.canceled || !r.filePath) return null;
  atomicWrite(r.filePath, Buffer.from(bytes));
  return r.filePath;
});
handle('file:exportMany', async ({ files }) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the images', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  for (const f of files) atomicWrite(path.join(r.filePaths[0], f.name), Buffer.from(f.bytes));
  return r.filePaths[0];
});
handle('recent:list', () => settings.recent.filter((p) => fs.existsSync(p)).map((p) => ({ path: p, name: path.basename(p, '.' + FILE_EXT), modified: fs.statSync(p).mtimeMs })));
handle('recent:forget', (p) => {
  settings.recent = settings.recent.filter((r) => r !== p);
  saveSettings();
});

const IMG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
handle('image:pick', async (multi = true) => {
  const r = await dialog.showOpenDialog(win, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }] });
  if (r.canceled) return [];
  return r.filePaths.map((p) => ({ name: path.basename(p), mime: IMG_MIME[path.extname(p).toLowerCase()] || 'image/png', bytes: fs.readFileSync(p) }));
});

/* ---------- fonts ---------- */
// Reads only the 'name' table, so scanning hundreds of fonts stays quick.
function fontNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    const tag = head.toString('latin1', 0, 4);
    if (tag === 'ttcf' || tag === 'wOFF' || tag === 'wOF2') return null;
    const n = head.readUInt16BE(4);
    const dir = Buffer.alloc(n * 16);
    fs.readSync(fd, dir, 0, dir.length, 12);
    let nameOff = -1;
    let nameLen = 0;
    let os2 = -1;
    let fvar = false;
    for (let i = 0; i < n; i++) {
      const t = dir.toString('latin1', i * 16, i * 16 + 4);
      if (t === 'name') {
        nameOff = dir.readUInt32BE(i * 16 + 8);
        nameLen = dir.readUInt32BE(i * 16 + 12);
      }
      if (t === 'OS/2') os2 = dir.readUInt32BE(i * 16 + 8);
      if (t === 'fvar') fvar = true;
    }
    if (nameOff < 0) return null;
    const nb = Buffer.alloc(nameLen);
    fs.readSync(fd, nb, 0, nameLen, nameOff);
    const count = nb.readUInt16BE(2);
    const strOff = nb.readUInt16BE(4);
    const names = {};
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      const plat = nb.readUInt16BE(r);
      const lang = nb.readUInt16BE(r + 4);
      const id = nb.readUInt16BE(r + 6);
      const len = nb.readUInt16BE(r + 8);
      const off = nb.readUInt16BE(r + 10);
      const raw = nb.subarray(strOff + off, strOff + off + len);
      let s;
      if (plat === 3 || plat === 0) {
        if (plat === 3 && lang !== 0x409 && names[id]) continue;
        const sw = Buffer.from(raw);
        sw.swap16();
        s = sw.toString('utf16le');
      } else if (plat === 1 && !names[id]) s = raw.toString('latin1');
      else continue;
      if (s) names[id] = s;
    }
    let weight = 400;
    if (os2 >= 0) {
      const ob = Buffer.alloc(6);
      fs.readSync(fd, ob, 0, 6, os2);
      weight = ob.readUInt16BE(4);
    }
    const family = names[16] || names[1];
    const style = names[17] || names[2] || 'Regular';
    if (!family || family.startsWith('.')) return null;
    return { family, style, full: names[4] || `${family} ${style}`, ps: names[6] || '', weight, italic: /italic|oblique/i.test(style), variable: fvar };
  } finally {
    fs.closeSync(fd);
  }
}
function fontDirs() {
  return [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts'),
    ensureDir(user('fonts')),
  ];
}
handle('fonts:list', () => {
  const cacheFile = user('font-cache.json');
  const cache = readJSON(cacheFile, {});
  const out = [];
  const next = {};
  for (const d of fontDirs()) {
    let files = [];
    try {
      files = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.(ttf|otf)$/i.test(f)) continue;
      const p = path.join(d, f);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      const key = p.toLowerCase();
      let info = cache[key] && cache[key].mtime === st.mtimeMs ? cache[key].info : undefined;
      if (info === undefined) {
        try {
          info = fontNames(p);
        } catch {
          info = null;
        }
      }
      next[key] = { mtime: st.mtimeMs, info };
      if (info) out.push({ ...info, path: p, added: d === user('fonts') });
    }
  }
  writeJSON(cacheFile, next);
  return out;
});
handle('fonts:read', (p) => fs.readFileSync(p));
handle('fonts:add', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }] });
  if (r.canceled) return 0;
  for (const p of r.filePaths) fs.copyFileSync(p, path.join(ensureDir(user('fonts')), path.basename(p)));
  return r.filePaths.length;
});

/* ---------- colour profiles ---------- */
function iccInfo(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(132);
    fs.readSync(fd, b, 0, 132, 0);
    const space = b.toString('latin1', 16, 20);
    const cls = b.toString('latin1', 12, 16);
    return { space, cls };
  } finally {
    fs.closeSync(fd);
  }
}
handle('icc:list', () => {
  const dirs = [path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'spool', 'drivers', 'color'), ensureDir(user('profiles'))];
  const out = [];
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.(icc|icm)$/i.test(f)) continue;
      const p = path.join(d, f);
      try {
        const i = iccInfo(p);
        if (i.space === 'CMYK' && i.cls === 'prtr') out.push({ path: p, name: path.basename(f).replace(/\.(icc|icm)$/i, '') });
      } catch {}
    }
  }
  return out;
});
handle('icc:read', (p) => fs.readFileSync(p));
handle('icc:add', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Colour profiles', extensions: ['icc', 'icm'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  const i = iccInfo(src);
  if (i.space !== 'CMYK') return { error: "That profile isn't a CMYK printing profile." };
  const dest = path.join(ensureDir(user('profiles')), path.basename(src));
  fs.copyFileSync(src, dest);
  return { path: dest };
});

/* ---------- brand kit ---------- */
handle('brandkit:get', () => readJSON(user('brandkit.json'), { swatches: [], styles: [], logos: [], fonts: [] }));
handle('brandkit:set', (kit) => writeJSON(user('brandkit.json'), kit));

/* ---------- templates and the bin ---------- */
const tplDir = () => ensureDir(user('templates'));
const binDir = () => ensureDir(user('bin'));
const safeName = (s) => String(s || 'Template').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80) || 'Template';
handle('templates:list', () =>
  fs
    .readdirSync(tplDir())
    .filter((f) => f.endsWith('.' + FILE_EXT))
    .map((f) => {
      const p = path.join(tplDir(), f);
      let thumb = null;
      try {
        thumb = JSON.parse(fs.readFileSync(p, 'utf8')).thumb || null;
      } catch {}
      return { path: p, name: path.basename(f, '.' + FILE_EXT), modified: fs.statSync(p).mtimeMs, thumb };
    })
    .sort((a, b) => b.modified - a.modified)
);
handle('templates:save', ({ name, text, replace }) => {
  let base = safeName(name);
  let p = path.join(tplDir(), base + '.' + FILE_EXT);
  if (!replace) for (let i = 2; fs.existsSync(p); i++) p = path.join(tplDir(), `${base} ${i}.${FILE_EXT}`);
  atomicWrite(p, text);
  return p;
});
handle('templates:read', (p) => fs.readFileSync(p, 'utf8'));
handle('templates:delete', (p) => {
  if (!p.startsWith(tplDir())) return;
  const dest = path.join(binDir(), `${Date.now()}__${path.basename(p)}`);
  fs.renameSync(p, dest);
  return dest;
});
handle('bin:list', () =>
  fs.readdirSync(binDir()).map((f) => {
    const [t, ...rest] = f.split('__');
    return { path: path.join(binDir(), f), name: rest.join('__').replace('.' + FILE_EXT, ''), deleted: Number(t) };
  })
);
handle('bin:restore', (p) => {
  if (!p.startsWith(binDir())) return;
  const name = path.basename(p).split('__').slice(1).join('__');
  let dest = path.join(tplDir(), name);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(tplDir(), name.replace('.' + FILE_EXT, ` ${i}.${FILE_EXT}`));
  fs.renameSync(p, dest);
  return dest;
});
handle('bin:empty', () => {
  for (const f of fs.readdirSync(binDir())) fs.rmSync(path.join(binDir(), f), { force: true });
});
function purgeBin() {
  try {
    const cutoff = Date.now() - BIN_DAYS * 86400000;
    for (const f of fs.readdirSync(binDir())) if (Number(f.split('__')[0]) < cutoff) fs.rmSync(path.join(binDir(), f), { force: true });
  } catch {}
}

/* ---------- recovery (crash-safe copies of unsaved work) ---------- */
const recDir = () => ensureDir(user('recovery'));
handle('recovery:write', ({ id, text }) => atomicWrite(path.join(recDir(), id + '.json'), text));
handle('recovery:clear', (id) => fs.rmSync(path.join(recDir(), id + '.json'), { force: true }));
handle('recovery:list', () =>
  fs
    .readdirSync(recDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = path.join(recDir(), f);
      try {
        const d = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { id: f.slice(0, -5), name: d.name, path: d.filePath || null, saved: fs.statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
);
handle('recovery:read', (id) => fs.readFileSync(path.join(recDir(), id + '.json'), 'utf8'));
