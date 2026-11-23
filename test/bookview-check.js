// Preview book: View, Preview book (Ctrl+Shift+P) shows the design as a book, for books with a
// cover only. The covers, spine and pages come from the design itself, pages turn and the labels
// follow, the closed book turns over to its spine and back, the editor's own keys stay quiet while
// it's open, and Esc closes it.
// Run: node test/bookview-check.js
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const run = await H.launch(__filename, { userData: H.tempUserData('bookview') });
    H.finish('bookview-check', [run]);
  })();
} else {
  module.exports = async ({ exec, shot }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    await appReady();
    const key = (k, mods = {}) => exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, bubbles: true, cancelable: true }))`);
    const state = () => exec('BookView.test.state()');
    const where = async () => (await state())?.where;
    // The colour in the middle of a picture shown on the screen (a page side or the turning page).
    const colourOf = (sel) => exec(`(async () => {
      const el = document.querySelector(${JSON.stringify(sel)});
      const m = el && /url\\("?([^")]+)"?\\)/.exec(el.style.backgroundImage || el.style.background);
      if (!m) return null;
      const img = new Image(); img.src = m[1]; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const [r, gg, b] = g.getImageData(Math.round(img.width / 2), Math.round(img.height / 2), 1, 1).data;
      return [r, gg, b];
    })()`);
    const near = (rgb, want) => rgb && rgb.every((v, i) => Math.abs(v - want[i]) < 60);
    const CMYK = { cyan: { c: 100, m: 0, y: 0, k: 0 }, magenta: { c: 0, m: 100, y: 0, k: 0 }, yellow: { c: 0, m: 0, y: 100, k: 0 }, green: { c: 80, m: 0, y: 100, k: 0 } };
    const rgbOf = (cmyk) => exec(`Color.rgb(${JSON.stringify(cmyk)})`);

    // A single-page design (a poster) has no preview.
    await exec(`App.newDocument({ name: 'Poster', w: 210, h: 297, pages: 1, kind: 'print', bleed: 3 })`);
    await wait(500);
    check('a design without a cover has no preview', (await exec('BookView.available(App.S.doc)')) === false);
    await key('P', { ctrl: true, shift: true });
    await wait(300);
    check('...and Ctrl+Shift+P does nothing there', (await exec('BookView.isOpen()')) === false);

    // A six-page book with a cyan cover, a green spine, a yellow inside cover and coloured pages.
    await exec(`(async () => {
      await App.newDocument({ name: 'Preview test', w: 129, h: 198, pages: 6, kind: 'book', bleed: 3 });
      const d = App.S.doc; const c = Model.cover(d);
      d.cover.spineExtra = 12; // a spine wide enough to see
      const c2 = Model.cover(d);
      const rect = (list, x, w, fill, name) => { const it = Model.newItem('rect', x, -3, w, d.h + 6, d); it.fill = fill; it.name = name; list.push(it); };
      rect(d.cover.items, -3, c2.w + 6, ${JSON.stringify(CMYK.cyan)}, 'Cover');
      rect(d.cover.items, c2.spineX[0], c2.spine, ${JSON.stringify(CMYK.green)}, 'Spine');
      d.cover.inside.enabled = true;
      rect(d.cover.inside.items, -3, c2.w + 6, ${JSON.stringify(CMYK.yellow)}, 'Inside');
      rect(d.pages[0].items, -3, d.w + 6, ${JSON.stringify(CMYK.magenta)}, 'Page 1');
      rect(d.pages[1].items, -3, d.w + 6, ${JSON.stringify(CMYK.cyan)}, 'Page 2');
      rect(d.pages[2].items, -3, d.w + 6, ${JSON.stringify(CMYK.yellow)}, 'Page 3');
      Layout.invalidate(); App.markDirty(); App.render();
    })()`);
    await wait(600);
    check('a book with a cover can be previewed', (await exec('BookView.available(App.S.doc)')) === true);
    // Open View with Alt+V and look at its first item.
    await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', altKey: true, bubbles: true, cancelable: true }))`);
    await wait(200);
    const item = await exec(`(() => { const b = document.querySelector('.mb-drop button'); return b && { text: b.querySelector('span').textContent, key: b.querySelector('kbd')?.textContent, disabled: b.disabled }; })()`);
    check('View starts with Preview book (Ctrl+Shift+P), not greyed out', item && item.text === 'Preview book' && item.key === 'Ctrl+Shift+P' && !item.disabled, JSON.stringify(item));
    await exec('Menu.close()');

    // Open it with the shortcut.
    await key('P', { ctrl: true, shift: true });
    check('Ctrl+Shift+P opens the preview', await waitFor(() => exec('BookView.isOpen() && !!document.getElementById("bookview")'), 5000));
    let s = await state();
    check('it opens closed, on the front cover', s && s.state === 0 && (await where()) === 'Front cover', JSON.stringify(s));
    check('the book has a leaf for each pair of pages plus the two covers', s && s.leaves === 5, s && s.leaves);
    const cyan = await rgbOf(CMYK.cyan), magenta = await rgbOf(CMYK.magenta), yellow = await rgbOf(CMYK.yellow), green = await rgbOf(CMYK.green);
    check('the front cover shows the design\'s cover', near(await colourOf('#bookview .bv-R'), cyan), JSON.stringify(await colourOf('#bookview .bv-R')));
    if (shot) await shot(require('path').join(require('os').tmpdir(), 'endpaper-bookview-front.png'));

    // The editor's own keys stay quiet: R would pick the rectangle tool.
    await key('r');
    check('editor shortcuts are ignored while the preview is open', (await exec('App.S.tool')) === 'select', await exec('App.S.tool'));

    // Turn into the book.
    await key('ArrowRight');
    check('the right arrow opens the cover', await waitFor(async () => (await where()) === 'Inside front cover and page 1', 4000), await where());
    check('...showing the inside cover on the left', near(await colourOf('#bookview .bv-L'), yellow), JSON.stringify(await colourOf('#bookview .bv-L')));
    check('...and page 1 on the right', near(await colourOf('#bookview .bv-R'), magenta), JSON.stringify(await colourOf('#bookview .bv-R')));
    await key('ArrowRight');
    check('the next spread is pages 2 and 3', await waitFor(async () => (await where()) === 'Pages 2–3', 4000), await where());
    check('...with page 2 on the left and page 3 on the right', near(await colourOf('#bookview .bv-L'), cyan) && near(await colourOf('#bookview .bv-R'), yellow));
    // A page part way over, for the picture.
    await exec('BookView.test.setTurn(2, 70)');
    await wait(100);
    if (shot) await shot(require('path').join(require('os').tmpdir(), 'endpaper-bookview-turning.png'));
    await exec('BookView.test.setTurn(2, null)');

    // Back to the front, then turn the closed book over.
    await key('Home');
    check('Home closes the book on the front cover', await waitFor(async () => (await where()) === 'Front cover', 6000), await where());
    await key('ArrowLeft');
    check('the left arrow turns the closed book to its spine', await waitFor(async () => (await where()) === 'Spine', 4000), await where());
    check('...which shows the design\'s spine', near(await exec(`(async () => {
      const el = [...document.querySelectorAll('#bookview .bv-cf')][2];
      const m = /url\\("?([^")]+)"?\\)/.exec(el.style.background); if (!m) return null;
      const img = new Image(); img.src = m[1]; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return [...g.getImageData(Math.round(img.width / 2), Math.round(img.height / 2), 1, 1).data].slice(0, 3);
    })()`), green));
    if (shot) await shot(require('path').join(require('os').tmpdir(), 'endpaper-bookview-spine.png'));
    await key('ArrowLeft');
    check('the left arrow again reaches the back cover', await waitFor(async () => (await where()) === 'Back cover', 4000), await where());
    await key('ArrowRight');
    await waitFor(async () => (await where()) === 'Spine', 4000);
    await key('ArrowRight');
    check('the right arrow turns it back via the spine to the front', await waitFor(async () => (await where()) === 'Front cover', 4000), await where());

    // Esc closes it, and the editor's keys work again.
    await key('Escape');
    check('Esc closes the preview', await waitFor(() => exec('!BookView.isOpen() && !document.getElementById("bookview")'), 3000));
    await key('r');
    check('editor shortcuts work again after closing', (await exec('App.S.tool')) === 'rect', await exec('App.S.tool'));
    await exec(`App.setTool('select'); App.S.dirty = false`);
  };
}
