// Cover pages: when the cover is single pages (front, back, inside front, inside back), they're
// windows onto one cover sheet, so a box across the fold shows on two of them. Changing it on one
// redraws the other's thumbnail in the Pages panel too, both ways, and on the inside cover.
// Run: node test/cover-pages-check.js
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const run = await H.launch(__filename, { userData: H.tempUserData('cover-pages') });
    H.finish('cover-pages-check', [run]);
  })();
} else {
  module.exports = async ({ exec }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    await appReady();
    // A book with a single-page cover and its inside, a box across the outside fold and one
    // across the inside fold.
    await exec(`(async () => {
      await App.newDocument({ name: 'Cover pages', w: 129, h: 198, pages: 120, kind: 'book', bleed: 3 });
      const d = App.S.doc; const c = Model.cover(d);
      d.cover.inside.enabled = true;
      const across = (list, name) => { const it = Model.newItem('rect', c.back[1] - 40, 80, c.spine + 80, 40, d); it.name = name; it.fill = { c: 100, m: 0, y: 0, k: 0 }; list.push(it); };
      across(d.cover.items, 'Outside band');
      across(d.cover.inside.items, 'Inside band');
      Layout.invalidate(); App.markDirty();
      App.setCoverLayout('single');
    })()`);
    await wait(800);
    // The colour of a thumbnail where the band shows (near the spine edge, at the band's height).
    const thumbAt = (key, side) => exec(`(() => {
      const cv = document.querySelector('[data-thumb="cover:${key}"] canvas');
      if (!cv) return null;
      const x = Math.round(cv.width * ${side === 'right' ? 0.95 : 0.05}), y = Math.round(cv.height * 100 / 198);
      const [r, g, b] = cv.getContext('2d').getImageData(x, y, 1, 1).data;
      return r + ',' + g + ',' + b;
    })()`);
    const isCyan = (rgb) => rgb && rgb.split(',').map(Number)[0] < 80;
    const isMagenta = (rgb) => rgb && (([r, g, b]) => r > 150 && g < 80 && b > 60)(rgb.split(',').map(Number));
    const recolour = (name, fill) => exec(`(() => { const list = [...App.S.doc.cover.items, ...App.S.doc.cover.inside.items]; const it = list.find(i => i.name === ${JSON.stringify(name)}); App.change('Colour', () => { it.fill = ${JSON.stringify(fill)}; }); })()`);
    const MAGENTA = { c: 0, m: 100, y: 0, k: 0 };
    const CYAN = { c: 100, m: 0, y: 0, k: 0 };

    check('the band shows on both the front and the back thumbnails', isCyan(await thumbAt('outside:front', 'left')) && isCyan(await thumbAt('outside:back', 'right')), `${await thumbAt('outside:front', 'left')} / ${await thumbAt('outside:back', 'right')}`);

    // Changed while on the front: the back's thumbnail follows.
    await exec(`App.goTo({ kind: 'cover', part: 'front' })`);
    await wait(300);
    await recolour('Outside band', MAGENTA);
    check('changed on the front, the back cover thumbnail updates', await waitFor(async () => isMagenta(await thumbAt('outside:back', 'right')), 3000), await thumbAt('outside:back', 'right'));
    check('...and the front cover thumbnail too', isMagenta(await thumbAt('outside:front', 'left')), await thumbAt('outside:front', 'left'));

    // Changed while on the back: the front's thumbnail follows.
    await exec(`App.goTo({ kind: 'cover', part: 'back' })`);
    await wait(300);
    await recolour('Outside band', CYAN);
    check('changed on the back, the front cover thumbnail updates', await waitFor(async () => isCyan(await thumbAt('outside:front', 'left')), 3000), await thumbAt('outside:front', 'left'));

    // The inside cover's two pages, the same way.
    await exec(`App.goTo({ kind: 'cover', side: 'inside', part: 'front' })`);
    await wait(300);
    await recolour('Inside band', MAGENTA);
    check('changed on the inside front, the inside back thumbnail updates', await waitFor(async () => isMagenta(await thumbAt('inside:back', 'left')), 3000), await thumbAt('inside:back', 'left'));

    // Undo puts every thumbnail back.
    await exec(`App.history.doUndo()`);
    check('undo puts the other side\'s thumbnail back too', await waitFor(async () => isCyan(await thumbAt('inside:back', 'left')), 3000), await thumbAt('inside:back', 'left'));
    await exec(`App.S.dirty = false`);
  };
}
