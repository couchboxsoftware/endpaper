// In-app updates via electron-updater. New versions are published to GitHub Releases
// (see "build.publish" in package.json and tools/release.js).
//
// Flow: check quietly on start-up and every few hours -> tell the window "update available"
// -> the user clicks "Update now" -> download with progress -> make sure the open design is
// saved (prepare) -> remember what was open -> restart into the new version, which reopens it.
// Nothing is downloaded until the user asks, and nothing installs while work is unsaved.
//
// Testing: set EP_UPDATE_URL to a local folder server (http://localhost:PORT/) that holds
// latest.yml and the installer. Only localhost addresses are accepted. EP_UPDATE_DRY=1 stops
// short of installing (the test checks everything up to that point).
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8000;

// prepare(): asks the window to save the open design. Resolves { ok, files } where files are
// what to reopen after the update; ok is false when the user hasn't saved (yet).
// beforeInstall(files): remembers the files and lets the window close without asking.
function create({ send, prepare, beforeInstall }) {
  const testUrl = (process.env.EP_UPDATE_URL || '').trim();
  const useTestUrl = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(testUrl);
  const dry = process.env.EP_UPDATE_DRY === '1';
  const enabled = app.isPackaged || useTestUrl;

  // Endpaper's own version (app.getVersion() can report Electron's when run from source).
  const current = require('../../package.json').version;
  const state = { status: enabled ? 'idle' : 'off', current, version: null, notes: '', percent: 0, error: null, lastChecked: null };
  const emit = (patch) => {
    Object.assign(state, patch);
    send('update', { ...state });
  };

  let autoUpdater = null;
  if (enabled) {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = false; // ask first
    autoUpdater.autoInstallOnAppQuit = false; // only update when the user says so
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    if (useTestUrl) {
      autoUpdater.forceDevUpdateConfig = true;
      if (!app.isPackaged) autoUpdater.updateConfigPath = path.join(__dirname, '..', '..', 'dev-app-update.yml');
      autoUpdater.setFeedURL({ provider: 'generic', url: testUrl });
      // Use electron-updater's own copy of semver, or its version comparisons reject the object.
      const semver = require(require.resolve('semver', { paths: [path.dirname(require.resolve('electron-updater'))] }));
      autoUpdater.currentVersion = semver.parse(current);
    }

    autoUpdater.on('checking-for-update', () => emit({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => emit({ status: 'latest', lastChecked: Date.now() }));
    autoUpdater.on('update-available', (info) => emit({ status: 'available', version: info.version, notes: plainNotes(info.releaseNotes), percent: 0, lastChecked: Date.now() }));
    autoUpdater.on('download-progress', (p) => emit({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      state.version = info.version;
      // The user already chose "Update now": install as soon as the work is saved.
      installNow();
    });
    autoUpdater.on('error', (err) => {
      // A failed background check (offline, GitHub down) isn't worth bothering anyone about.
      const wasDownloading = state.status === 'downloading';
      emit({ status: wasDownloading ? 'error' : state.version ? 'available' : 'idle', error: wasDownloading ? short(err) : null, lastCheckError: short(err) });
    });
  }

  async function check(manual = false) {
    if (!autoUpdater) return { ...state };
    if (['checking', 'downloading', 'saving', 'ready'].includes(state.status)) return { ...state };
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      emit({ status: 'idle', error: manual ? short(err) : null });
    }
    return { ...state };
  }

  async function download() {
    if (!autoUpdater || !state.version) return { ...state };
    if (state.status === 'waiting') return installNow();
    emit({ status: 'downloading', percent: 0, error: null });
    autoUpdater.downloadUpdate().catch((err) => emit({ status: 'error', error: short(err) }));
    return { ...state };
  }

  // Saves (with the user's say-so), remembers what's open, then restarts into the update.
  let installing = false;
  async function installNow() {
    if (!autoUpdater || installing) return { ...state };
    installing = true;
    try {
      emit({ status: 'saving', percent: 100 });
      const r = await prepare();
      if (!r || !r.ok) {
        // Downloaded, waiting for the design to be saved.
        emit({ status: 'waiting', percent: 100 });
        return { ...state };
      }
      beforeInstall(r.files || []);
      emit({ status: 'ready', percent: 100 });
      if (dry) {
        send('update-dry', { files: r.files || [] });
        return { ...state };
      }
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200);
      return { ...state };
    } finally {
      installing = false;
    }
  }

  function start() {
    if (!autoUpdater) return;
    setTimeout(() => check(false), FIRST_CHECK_DELAY_MS);
    setInterval(() => check(false), CHECK_EVERY_MS).unref?.();
  }

  function releasePage() {
    try {
      const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
      const owner = /owner:\s*(\S+)/.exec(yml)?.[1];
      const repo = /repo:\s*(\S+)/.exec(yml)?.[1];
      if (owner && repo) return `https://github.com/${owner}/${repo}/releases`;
    } catch (_) {}
    return 'https://github.com/couchboxsoftware/endpaper/releases';
  }

  return { start, check, download, installNow, openReleases: () => shell.openExternal(releasePage()), getState: () => ({ ...state }) };
}

function plainNotes(notes) {
  if (!notes) return '';
  const text = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes);
  return text
    .replace(/<\/(li|p|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()
    .slice(0, 800);
}

const short = (err) => String((err && err.message) || err).split('\n')[0].slice(0, 200);

module.exports = { create };
