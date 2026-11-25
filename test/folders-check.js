// Remembered folders: Endpaper remembers three folders, each on its own, and keeps them after it's
// closed and opened again: where you last saved a design (also where File, Open starts), where you
// last brought in a picture, and where you last exported. Save as starts beside the design that's
// open. A remembered folder that's gone is ignored.
// Windows' own file windows are stood in for: the check notes where each one would start and
// answers with folders it made, so nothing waits for a click.
// Run: node test/folders-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'endpaper-folders-'));
    const dirs = {};
    for (const d of ['designs', 'other', 'pictures', 'exports', 'gone']) fs.mkdirSync((dirs[d] = path.join(base, d)));
    // A small picture to bring in, in the pictures folder and in the one that will vanish.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(path.join(dirs.pictures, 'photo.png'), png);
    fs.writeFileSync(path.join(dirs.gone, 'old.png'), png);
    const userData = H.tempUserData('folders');
    const env = { ENDPAPER_FOLDERS: JSON.stringify(dirs) };
    const r1 = await H.launch(__filename, { userData, env: { ...env, ENDPAPER_CHECK: 'first' }, label: '[first time]' });
    fs.rmSync(dirs.gone, { recursive: true, force: true });
    const r2 = await H.launch(__filename, { userData, env: { ...env, ENDPAPER_CHECK: 'again' }, label: '[opened again]' });
    H.finish('folders-check', [r1, r2]);
  })();
} else {
  module.exports = async ({ exec }) => {
    const { check, appReady, wait } = H.inApp({ exec });
    const { dialog } = require('electron');
    await appReady();
    const dirs = JSON.parse(process.env.ENDPAPER_FOLDERS);

    // Stand-ins for Windows' file windows: note where each starts, answer with the given file.
    const seen = [];
    let answer = null;
    dialog.showSaveDialog = async (_w, o) => (seen.push({ kind: 'save', at: o.defaultPath }), { canceled: !answer, filePath: answer });
    dialog.showOpenDialog = async (_w, o) => (seen.push({ kind: 'open', at: o.defaultPath }), { canceled: !answer, filePaths: answer ? [].concat(answer) : [] });
    const last = () => seen[seen.length - 1].at || '';
    const startsIn = (dir, file) => path.normalize(last()) === path.normalize(file ? path.join(dir, file) : dir);
    const saved = () => JSON.parse(fs.readFileSync(path.join(require('electron').app.getPath('userData'), 'settings.json'), 'utf8')).folders || {};

    if (process.env.ENDPAPER_CHECK === 'first') {
      await exec(`(async () => { await App.newDocument({ name: 'Folders', w: 148, h: 210, pages: 1, kind: 'print', bleed: 3 }); })()`);
      await wait(300);
      // Saving a new design: nowhere remembered yet, then the folder it went to is.
      answer = path.join(dirs.designs, 'Folders.endpaper');
      await exec(`App.save()`);
      check('the first save starts where Windows chooses (nothing remembered yet)', last() === 'Folders.endpaper', last());
      check('...and remembers the designs folder', saved().designs === dirs.designs, saved().designs);

      // A second new design: its Save starts in the designs folder.
      await exec(`(async () => { await App.newDocument({ name: 'Second', w: 148, h: 210, pages: 1, kind: 'print', bleed: 3 }); })()`);
      await wait(300);
      answer = path.join(dirs.designs, 'Second.endpaper');
      await exec(`App.save()`);
      check('saving a new design starts in the last folder you saved to', startsIn(dirs.designs, 'Second.endpaper'), last());

      // Save as on a design that lives elsewhere starts beside it.
      fs.copyFileSync(path.join(dirs.designs, 'Second.endpaper'), path.join(dirs.other, 'Elsewhere.endpaper'));
      await exec(`(async () => { const t = await ep.file.read(${JSON.stringify(path.join(dirs.other, 'Elsewhere.endpaper'))}); await App.loadDoc(JSON.parse(t.text), t.path); App.S.doc.name = 'Elsewhere'; })()`);
      answer = null; // cancelled, so nothing's remembered from it
      await exec(`App.save(true)`);
      check('Save as starts beside the design that\'s open', startsIn(dirs.other, 'Elsewhere.endpaper'), last());
      check('...and cancelling it changes nothing', saved().designs === dirs.designs);

      // File, Open starts in the designs folder.
      await exec(`ep.file.open()`);
      check('File, Open starts in the designs folder', startsIn(dirs.designs), last());

      // Pictures: their own folder.
      answer = [path.join(dirs.gone, 'old.png')];
      await exec(`ep.image.pick(true)`);
      check('the first picture picker starts where Windows chooses', last() === '', last());
      answer = [path.join(dirs.pictures, 'photo.png')];
      await exec(`ep.image.pick(true)`);
      check('the next one starts where you last brought in a picture', startsIn(dirs.gone), last());
      check('...and the pictures folder is kept apart from the designs folder', saved().pictures === dirs.pictures && saved().designs === dirs.designs, JSON.stringify(saved()));

      // Exports: their own folder too.
      answer = path.join(dirs.exports, 'Folders.pdf');
      await exec(`ep.file.export({ bytes: new Uint8Array([37, 80, 68, 70]), name: 'Folders.pdf', ext: 'pdf', label: 'PDF' })`);
      check('the first export starts where Windows chooses', last() === 'Folders.pdf', last());
      await exec(`ep.file.export({ bytes: new Uint8Array([37, 80, 68, 70]), name: 'Folders again.pdf', ext: 'pdf', label: 'PDF' })`);
      check('the next export starts where you last exported', startsIn(dirs.exports, 'Folders again.pdf'), last());
      answer = dirs.exports;
      await exec(`ep.file.exportMany({ files: [{ name: 'Page 1.png', bytes: new Uint8Array([1]) }] })`);
      check('...and so does choosing a folder for several pictures', startsIn(dirs.exports), last());
      check('all three folders are kept, each on its own', saved().designs === dirs.designs && saved().pictures === dirs.pictures && saved().exports === dirs.exports, JSON.stringify(saved()));
      await exec(`App.S.dirty = false`);
      return;
    }

    // Opened again: every window starts where you left off.
    answer = null;
    await exec(`ep.file.open()`);
    check('after opening again, File, Open starts in the designs folder', startsIn(dirs.designs), last());
    await exec(`ep.image.pick(true)`);
    check('...the picture picker starts in the pictures folder', startsIn(dirs.pictures), last());
    await exec(`ep.file.export({ bytes: new Uint8Array([1]), name: 'Again.pdf', ext: 'pdf', label: 'PDF' })`);
    check('...and Export starts in the exports folder', startsIn(dirs.exports, 'Again.pdf'), last());

    // A remembered folder that's gone is ignored.
    await exec(`(async () => { await ep.settings.set({ folders: { ...(await ep.settings.get()).folders, pictures: ${JSON.stringify(path.join(dirs.gone))} } }); })()`);
    await exec(`ep.image.pick(true)`);
    check('a remembered folder that\'s gone is ignored', last() === '', last());
  };
}
