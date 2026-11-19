// Closing: windows (dialogs) only close on a press AND release outside them, so dragging out of
// a field never closes one, and Esc closes the top one; closing Endpaper with nothing unsaved
// just closes; with unsaved work it asks first, Cancel keeps it open and "Don't save" closes.
// Real mouse presses are sent to the window; the "Save changes?" question is answered by the
// check, so no real dialog waits for anyone.
// Run: node test/close-check.js
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const { check, tally } = H.runnerCheck();
    const r1 = await H.launch(__filename, { userData: H.tempUserData('close'), env: { ENDPAPER_CHECK: 'clean' }, label: '[nothing unsaved]', timeout: 60000 });
    const r2 = await H.launch(__filename, { userData: H.tempUserData('close-dirty'), env: { ENDPAPER_CHECK: 'unsaved' }, label: '[unsaved work]', timeout: 60000 });
    check('with nothing unsaved, closing just closes, asking nothing', r1.lines.some((l) => /WINDOW CLOSED after 0 questions/.test(l.line)));
    check(`with unsaved work, "Don't save" closes it (one question each time)`, r2.lines.some((l) => /WINDOW CLOSED after 2 questions/.test(l.line)));
    H.finish('close-check', [r1, r2], tally);
  })();
} else {
  module.exports = async ({ win, exec }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    const { dialog } = require('electron');
    await appReady();
    const wc = win.webContents;
    win.focus();
    wc.focus();
    const move = (x, y, buttons) => wc.sendInputEvent({ type: 'mouseMove', x, y, ...(buttons ? { button: 'left' } : {}) });
    const down = (x, y) => wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    const up = (x, y) => wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    const open = () => exec(`!!document.querySelector('.modal-overlay')`);

    // Every "Save changes?" question is answered here, and noted.
    const asked = [];
    let answer = 2; // Cancel
    dialog.showMessageBox = async (_w, o) => (asked.push(o.message), { response: answer });
    win.on('closed', () => console.log(`WINDOW CLOSED after ${asked.length} question${asked.length === 1 ? '' : 's'}`));

    if (process.env.ENDPAPER_CHECK === 'clean') {
      // Windows close only on a press and release outside them.
      await exec(`window.__m = openModal({ title: 'A window', body: '<label class="field"><span>Name</span><input class="input" value="Drag out of me"></label>' }); true`);
      await wait(200);
      const r = await exec(`(() => { const b = document.querySelector('.modal').getBoundingClientRect(); return { ix: Math.round(b.left + b.width / 2), iy: Math.round(b.top + b.height / 2), ox: Math.round(b.left / 2), oy: Math.round(b.top + b.height / 2) }; })()`);
      down(r.ix, r.iy); move(r.ox, r.oy, true); up(r.ox, r.oy); await wait(250);
      check('dragging from inside a window to outside it keeps it open', await open());
      down(r.ox, r.oy); move(r.ix, r.iy, true); up(r.ix, r.iy); await wait(250);
      check('pressing outside and letting go inside keeps it open', await open());
      down(r.ox, r.oy); up(r.ox, r.oy); await wait(250);
      check('a press and release outside closes it', !(await open()));
      await exec(`openModal({ title: 'Another window', body: '<p>Esc closes me.</p>' }); true`);
      await wait(150);
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      check('Esc closes the top window', await waitFor(async () => !(await open()), 2000));

      // Nothing unsaved: closing Endpaper just closes (the runner checks no question was asked).
      win.close();
      await waitFor(() => win.isDestroyed(), 5000);
      return;
    }

    // Unsaved work: asked first; Cancel keeps it open; Don't save closes.
    await exec(`(async () => { await App.newDocument({ name: 'Close check', w: 148, h: 210, pages: 1, kind: 'print', bleed: 3 }); App.change('Add', () => { const d = App.S.doc; d.pages[0].items.push(Model.newItem('rect', 10, 10, 40, 40, d)); }); })()`);
    check('there is unsaved work', await exec('App.S.dirty'));
    win.close();
    await wait(1200);
    check('closing asks about the unsaved work', asked.length === 1 && /Save changes to “Close check”\?/.test(asked[0]), asked.join(' | '));
    check('Cancel keeps Endpaper open', !win.isDestroyed() && win.isVisible());
    await wait(2500);
    check('...and nothing else pops up while it waits', asked.length === 1, asked.join(' | '));
    answer = 1; // Don't save
    win.close();
    await waitFor(() => win.isDestroyed(), 5000);
  };
}
