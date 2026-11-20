// Opening files after export. With Inkdesktop installed: the Export window offers "Open files in
// Inkdesktop after export" (ticked to start with, then as you left it); a book export opens its
// inside pages in Inkdesktop and shows the folder with both PDFs; pictures show the folder.
// Without it: "Open file(s) after export", and before anything opens, the window asking "Do you
// want to try Inkdesktop?" (Endpaper's "Exported" beside Inkdesktop's own panel); its buttons open
// the PDF in the default viewer, or Inkdesktop's download page as well; "Don't ask again" stops it,
// and Settings, Hints brings it back. Nothing is really opened: the app records what it would open.
// Run: node test/export-open-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'endpaper-export-'));
    const fakeExe = path.join(out, 'Inkdesktop.exe');
    fs.writeFileSync(fakeExe, 'stand-in');
    const r1 = await H.launch(__filename, { userData: H.tempUserData('export-ink'), env: { ENDPAPER_CHECK: 'installed', ENDPAPER_TEST_INKDESKTOP: fakeExe, ENDPAPER_TEST_EXPORT_DIR: fs.mkdtempSync(path.join(out, 'a-')) }, label: '[Inkdesktop installed]' });
    const r2 = await H.launch(__filename, { userData: H.tempUserData('export-noink'), env: { ENDPAPER_CHECK: 'missing', ENDPAPER_TEST_INKDESKTOP: 'none', ENDPAPER_TEST_EXPORT_DIR: fs.mkdtempSync(path.join(out, 'b-')), ENDPAPER_SNAP: process.env.ENDPAPER_SNAP || '' }, label: '[no Inkdesktop]' });
    H.finish('export-open-check', [r1, r2]);
  })();
} else {
  module.exports = async ({ win, exec }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    await appReady();
    const dir = process.env.ENDPAPER_TEST_EXPORT_DIR;
    const opened = () => global.endpaperOpened.map((o) => `${o.what}:${o.target === require('../src/main/inkdesktop').DOWNLOAD_PAGE ? 'page' : path.basename(o.target)}`);
    const clear = () => (global.endpaperOpened.length = 0);
    await exec(`(async () => { await App.newDocument({ name: 'Export check', w: 148, h: 210, pages: 4, kind: 'book', bleed: 3 }); })()`);
    await wait(500);

    // Opens Export, picks what and how, leaves the tick as given (or sets it), clicks Export.
    const exportNow = async ({ what = 'all', format = 'pdf', tick } = {}) => {
      await exec(`App.openExport()`);
      await waitFor(() => exec(`!!document.querySelector('[data-x="openAfter"]')`), 5000);
      await exec(`(() => { const s = document.querySelector('[data-x="what"]'); s.value = ${JSON.stringify(what)}; s.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-xseg="format"] [data-v="${format}"]').click(); })()`);
      if (tick !== undefined) await exec(`(() => { const c = document.querySelector('[data-x="openAfter"]'); c.checked = ${tick}; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const label = await exec(`document.querySelector('[data-open-label]').textContent`);
      const ticked = await exec(`document.querySelector('[data-x="openAfter"]').checked`);
      await exec(`document.querySelector('.modal [data-a="go"]').click()`);
      await waitFor(() => exec(`!document.querySelector('[data-x="openAfter"]')`), 30000);
      await wait(400);
      return { label, ticked };
    };

    if (process.env.ENDPAPER_CHECK === 'installed') {
      clear();
      const a = await exportNow({ what: 'book' });
      check('with Inkdesktop installed it says "Open files in Inkdesktop after export"', a.label === 'Open files in Inkdesktop after export', a.label);
      check('...ticked to start with', a.ticked);
      check('a book export makes both PDFs', fs.existsSync(path.join(dir, 'Export check - inside.pdf')) && fs.existsSync(path.join(dir, 'Export check - cover.pdf')));
      check('...opens the inside pages in Inkdesktop and shows the folder', JSON.stringify(opened()) === JSON.stringify(['inkdesktop:Export check - inside.pdf', 'folder:Export check - inside.pdf']), opened().join(', '));
      check('...and says so', /opened Export check - inside\.pdf in Inkdesktop/.test(await exec(`[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' ')`)));

      clear();
      const b = await exportNow({ what: 'all', format: 'png' });
      check('for pictures it says "Open the folder after export"', b.label === 'Open the folder after export', b.label);
      check('...and shows the folder, not a window per picture', JSON.stringify(opened()) === JSON.stringify(['folder:Export check - page 1.png']), opened().join(', '));

      clear();
      await exportNow({ what: 'current', tick: false });
      check('unticked, nothing opens', opened().length === 0, opened().join(', '));
      const again = await exportNow({ what: 'current' });
      check('...and it stays unticked next time', again.ticked === false);
      return;
    }

    // Inkdesktop isn't installed.
    clear();
    await exec(`App.openExport()`);
    await waitFor(() => exec(`!!document.querySelector('[data-open-label]')`), 5000);
    check('without Inkdesktop it says "Open file(s) after export"', (await exec(`document.querySelector('[data-open-label]').textContent`)) === 'Open file(s) after export');
    await exec(`document.querySelector('.modal [data-a="no"]').click()`);
    await wait(200);

    await exportNow({ what: 'book' });
    check('before anything opens, it asks "Do you want to try Inkdesktop?"', await waitFor(() => exec(`!!document.querySelector('.modal.ink-offer') && /Do you want to try Inkdesktop\\?/.test(document.querySelector('.modal.ink-offer').innerText)`), 4000));
    check('...with nothing opened yet', opened().length === 0, opened().join(', '));
    check('...Endpaper\'s "Exported" with both files on the left', await exec(`(() => { const d = document.querySelector('.io-done'); return /Exported/.test(d.innerText) && d.querySelectorAll('.io-files li').length === 2; })()`));
    const look = await exec(`(() => { const s = (q) => getComputedStyle(document.querySelector(q)); return { edge: s('.io-ink').borderLeftColor, panel: s('.io-ink').backgroundColor, button: s('.io-get').backgroundColor, word: s('.io-word b').color, nib: !!document.querySelector('.io-brand svg path[d^="M24 41C21"]') }; })()`);
    check('...and Inkdesktop\'s panel on the right, in its blue with its pen nib', look.edge === 'rgb(47, 107, 232)' && look.button === 'rgb(47, 107, 232)' && look.word === 'rgb(47, 107, 232)' && look.panel === 'rgb(29, 31, 36)' && look.nib, JSON.stringify(look));
    if (process.env.ENDPAPER_SNAP) fs.writeFileSync(process.env.ENDPAPER_SNAP, (await win.webContents.capturePage()).toPNG());
    await exec(`document.querySelector('[data-io="viewer"]').click()`);
    await wait(300);
    check('"Open in my PDF viewer" opens both PDFs in the default viewer', JSON.stringify(opened()) === JSON.stringify(['default:Export check - inside.pdf', 'default:Export check - cover.pdf']), opened().join(', '));

    clear();
    await exportNow({ what: 'current' });
    check('it asks again next time', await waitFor(() => exec(`!!document.querySelector('.modal.ink-offer')`), 4000));
    await exec(`document.querySelector('[data-io-off]').click()`);
    await exec(`document.querySelector('[data-io="get"]').click()`);
    await wait(400);
    check('"Get Inkdesktop" opens its download page and the PDF in the default viewer', JSON.stringify(opened()) === JSON.stringify(['download-page:page', 'default:Export check.pdf']), opened().join(', '));
    check('"Don\'t ask again" is remembered', await waitFor(() => exec(`Hints.isOff('try-inkdesktop')`), 2000));

    clear();
    await exportNow({ what: 'current' });
    await wait(500);
    check('after that the PDF just opens, without asking', !(await exec(`!!document.querySelector('.modal.ink-offer')`)) && JSON.stringify(opened()) === JSON.stringify(['default:Export check.pdf']), opened().join(', '));

    // Settings, Hints lists it, and Show again brings it back.
    await exec(`App.openSettings('hints')`);
    await wait(300);
    check('Settings, Hints lists "Try Inkdesktop" as turned off', await exec(`/Try Inkdesktop/.test(document.querySelector('.hints-section').innerText) && !!document.querySelector('[data-hint-reset="try-inkdesktop"]')`));
    await exec(`document.querySelector('[data-hint-reset="try-inkdesktop"]').click()`);
    await wait(300);
    await exec(`document.querySelector('.modal.settings .modal-x').click()`);
    await wait(200);
    clear();
    await exportNow({ what: 'current' });
    check('...and Show again brings the question back', await waitFor(() => exec(`!!document.querySelector('.modal.ink-offer')`), 4000));
  };
}
