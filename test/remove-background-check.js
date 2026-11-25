// Remove background: a photo effect. Find the subject (the model, in its helper process), then
// touch up with the wand and the brush, with undo. The mask is kept with the design, follows flip
// and rotate, makes the page's picture a see-through PNG, gives the drop shadow the cut-out's
// shape, and stays behind when effects are copied.
// Run: node test/remove-background-check.js
const path = require('path');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const run = await H.launch(__filename, { userData: H.tempUserData('remove-bg'), timeout: 240000, env: { ENDPAPER_TEST_SHOTS: process.env.ENDPAPER_TEST_SHOTS || null } });
    H.finish('remove-background-check', [run]);
  })();
} else {
  module.exports = async ({ exec, shot }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    await appReady();
    const shots = process.env.ENDPAPER_TEST_SHOTS;

    // A photo: a red disc, left of centre, on a plain grey background.
    await exec(`(async () => {
      await App.newDocument({ name: 'Cut-out', w: 148, h: 210, pages: 1, kind: 'print', bleed: 3 });
      const d = App.S.doc;
      const c = document.createElement('canvas'); c.width = 900; c.height = 600; const g = c.getContext('2d');
      g.fillStyle = '#8a8f96'; g.fillRect(0, 0, 900, 600);
      g.fillStyle = '#d22'; g.beginPath(); g.arc(330, 300, 200, 0, 7); g.fill();
      const bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      const id = await Assets.add(d, { name: 'disc.png', mime: 'image/png', bytes });
      let it; App.change('Add photo', () => { it = Model.newItem('image', 14, 20, 120, 80, d); it.asset = id; Render.fitImage(it, d.assets[id], 'fill'); d.pages[0].items.push(it); });
      window.__id = it.id;
      App.select([it.id]);
    })()`);
    await wait(300);
    const IT = `Model.findItem(App.S.doc, window.__id).item`;
    // See-through-ness of the finished photo at a point (photo pixels, as it came).
    const alphaAt = (x, y) => exec(`(() => { const it = ${IT}; const v = PhotoEdit.view(App.S.doc, it, { scale: 1 }); const c = document.createElement('canvas'); c.width = v.img.width; c.height = v.img.height; const g = c.getContext('2d'); g.drawImage(v.img, 0, 0); return g.getImageData(${x}, ${y}, 1, 1).data[3]; })()`);
    const openEdit = async () => {
      await exec(`PhotoEdit.open(${IT})`);
      await waitFor(() => exec(`!!document.querySelector('.modal.edit-photo')`), 3000);
      await wait(200);
    };
    const done = async () => {
      await exec(`document.querySelector('.edit-photo [data-pe="done"]').click()`);
      await waitFor(() => exec(`!document.querySelector('.modal.edit-photo')`), 5000);
      await wait(300);
    };
    // A click on the preview at a point of the photo (photo pixels, as it shows in the frame).
    const clickPhoto = (x, y, type = 'pointerdown', extra = '') => exec(`(() => {
      const it = ${IT}; const cv = document.querySelector('.pe-canvas'); const r = cv.getBoundingClientRect();
      const pad = 20, k = (cv.width - 2 * pad) / it.w;
      const cx = pad + (it.ox + ${x} * it.s) * k, cy = pad + (it.oy + ${y} * it.s) * k;
      cv.dispatchEvent(new PointerEvent('${type}', { clientX: r.left + cx * r.width / cv.width, clientY: r.top + cy * r.height / cv.height, button: 0, pointerId: 1, bubbles: true ${extra} }));
    })()`);

    // Add Remove background: it finds the subject straight away.
    await openEdit();
    await exec(`document.querySelector('.edit-photo [data-pe="add"]').click()`);
    await wait(100);
    check('Remove background is in the effects, under Shape and blending', await exec(`!!document.querySelector('.pe-add [data-add="cutout"]') && PhotoFX.TYPES.cutout.group === 'Shape and blending'`));
    await exec(`document.querySelector('.pe-add [data-add="cutout"]').click()`);
    check('...and it starts finding the subject straight away', await waitFor(() => exec(`/Finding the subject/.test(document.querySelector('.pe-cut-status')?.textContent || '')`), 3000));
    const found = await waitFor(() => exec(`/^Done in/.test(document.querySelector('.pe-cut-status')?.textContent || '')`), 120000, 250);
    const status = await exec(`document.querySelector('.pe-cut-status').textContent`);
    check('it finds the subject', found, status);
    console.log('INFO ' + status);
    if (shots) await shot(path.join(shots, 'remove-bg-window.png'));
    await done();
    const saved = await exec(`(() => { const it = ${IT}; const e = it.effects[0]; return { type: e.type, mask: e.p.mask, asset: !!App.S.doc.assets[e.p.mask], png: PhotoEdit.view(App.S.doc, it).url.slice(0, 14) }; })()`);
    check('Done keeps the mask with the design', saved.type === 'cutout' && /^a/.test(saved.mask) && saved.asset, JSON.stringify(saved));
    check('the disc is kept and the background is removed', (await alphaAt(330, 300)) === 255 && (await alphaAt(850, 50)) === 0, JSON.stringify([await alphaAt(330, 300), await alphaAt(850, 50)]));
    check('...and the page shows it as a see-through PNG', saved.png === 'data:image/png', saved.png);

    // Touch up: the wand keeps the top-right corner's grey.
    await openEdit();
    await exec(`document.querySelector('.pe-list [data-fx]').click()`);
    await wait(100);
    await exec(`document.querySelector('[data-cut-seg="mode"] [data-v="keep"]').click()`);
    await wait(100);
    await clickPhoto(850, 50);
    await wait(200);
    // The brush removes a patch from the middle of the disc...
    await exec(`document.querySelector('[data-cut-seg="tool"] [data-v="brush"]').click()`);
    await exec(`document.querySelector('[data-cut-seg="mode"] [data-v="remove"]').click()`);
    await wait(100);
    await clickPhoto(330, 300);
    await clickPhoto(330, 300, 'pointerup');
    await wait(200);
    if (shots) await shot(path.join(shots, 'remove-bg-touchup.png'));
    // ...and one Undo puts it back.
    await exec(`document.querySelector('[data-cut="undo"]').click()`);
    await wait(200);
    // Alt does the opposite: Alt + brush in Remove mode keeps.
    await clickPhoto(60, 560, 'pointerdown', ', altKey: true');
    await clickPhoto(60, 560, 'pointerup');
    await done();
    check('the wand keeps an area of one colour', (await alphaAt(850, 50)) === 255 && (await alphaAt(600, 300)) === 255, JSON.stringify([await alphaAt(850, 50), await alphaAt(600, 300)]));
    check('undo takes back the brush stroke', (await alphaAt(330, 300)) === 255, String(await alphaAt(330, 300)));
    check('...and Alt paints the opposite', (await alphaAt(60, 560)) === 255, String(await alphaAt(60, 560)));

    // Start again keeps everything; then the brush removes the middle, for real this time.
    await openEdit();
    await exec(`document.querySelector('.pe-list [data-fx]').click()`);
    await wait(100);
    await exec(`document.querySelector('[data-cut="reset"]').click()`);
    await exec(`document.querySelector('[data-cut-seg="tool"] [data-v="brush"]').click()`);
    await exec(`document.querySelector('[data-cut-seg="mode"] [data-v="remove"]').click()`);
    await wait(100);
    await clickPhoto(330, 300);
    await clickPhoto(330, 300, 'pointerup');
    await done();
    check('Start again keeps the whole photo, and the brush removes', (await alphaAt(850, 50)) === 255 && (await alphaAt(330, 300)) === 0, JSON.stringify([await alphaAt(850, 50), await alphaAt(330, 300)]));

    // The mask turns with the photo: flipped, the hole is on the other side.
    await exec(`App.change('Flip', () => { const it = ${IT}; it.effects.unshift({ ...PhotoFX.make('flip_rotate'), p: { flipH: true, flipV: false, rotate: '0' } }); })`);
    await wait(200);
    check('the mask flips with the photo', (await alphaAt(900 - 330, 300)) === 0 && (await alphaAt(330, 300)) === 255, JSON.stringify([await alphaAt(570, 300), await alphaAt(330, 300)]));
    await exec(`App.history.doUndo()`);
    await wait(200);

    // Soften edge: a soft edge between kept and removed.
    const soft = await exec(`(() => { const it = ${IT}; const e = it.effects.find((x) => x.type === 'cutout'); App.change('Soften', () => (e.p.soften = 2)); return true; })()`);
    await wait(200);
    const a1 = await alphaAt(330, 300), edge = [];
    for (let x = 290; x <= 380; x += 6) edge.push(await alphaAt(x, 300));
    check('Soften edge softens the edge', soft && edge.some((v) => v > 10 && v < 245), JSON.stringify({ a1, edge }));

    // The drop shadow takes the cut-out's shape, in the PDF too.
    const shadow = await exec(`(() => {
      const d = App.S.doc, it = ${IT};
      const sh = { distance: 0, angle: 0, softness: 0, opacity: 100, colour: { c: 0, m: 0, y: 0, k: 100 } };
      const frame = PhotoEdit.shadowMask(it, sh, 60);
      const shape = PhotoEdit.shadowMask(it, sh, 60, PhotoEdit.shapeOf(d, it, 60 / 25.4));
      // The middle of the hole the brush made, where the cut-out has nothing (0.5 mm is the mask's margin).
      const pxmm = 60 / 25.4, X = it.ox + 330 * it.s + 0.5, Y = it.oy + 300 * it.s + 0.5;
      const at = (m) => m.grey[Math.round(Y * pxmm) * m.pw + Math.round(X * pxmm)];
      return { frame: at(frame), shape: at(shape) };
    })()`);
    check('the drop shadow takes the cut-out’s shape', shadow.frame > 200 && shadow.shape < 60, JSON.stringify(shadow));
    const pdf = await exec(`(async () => {
      const it = ${IT};
      App.change('Shadow', () => it.effects.push(PhotoFX.make('drop_shadow')));
      const b = await Pdf.build(App.S.doc, { surfaces: [{ kind: 'page', idx: 0 }], bleed: true, cropMarks: true, pdfx: true, maxPpi: 450, targetPpi: 300, title: 'cut' });
      return { head: String.fromCharCode(...b.subarray(0, 5)), smask: new TextDecoder('latin1').decode(b).split('/SMask').length - 1 };
    })()`);
    check('the PDF builds, with the photo see-through', pdf.head === '%PDF-' && pdf.smask >= 2, JSON.stringify(pdf));
    if (shots) {
      await exec(`App.render()`);
      await wait(600);
      await shot(path.join(shots, 'remove-bg-page.png'));
    }

    // Saving keeps the mask; copying effects leaves the cut-out behind.
    const kept = await exec(`(() => { const d = JSON.parse(JSON.stringify(App.S.doc)); Model.pruneAssets(d); const e = ${IT}.effects.find((x) => x.type === 'cutout'); return !!d.assets[e.p.mask]; })()`);
    check('saving keeps the mask', kept);
    const copied = await exec(`(() => { PhotoEdit.copyEffects(${IT}); return true; })()`);
    await exec(`(async () => {
      const d = App.S.doc; const c = document.createElement('canvas'); c.width = 200; c.height = 200; c.getContext('2d').fillRect(0, 0, 200, 200);
      const bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      const id = await Assets.add(d, { name: 'b.png', mime: 'image/png', bytes });
      let it; App.change('Add', () => { it = Model.newItem('image', 14, 120, 60, 60, d); it.asset = id; Render.fitImage(it, d.assets[id], 'fill'); d.pages[0].items.push(it); });
      window.__other = it.id;
      await PhotoEdit.pasteEffects([it]);
    })()`);
    await wait(300);
    const other = await exec(`Model.findItem(App.S.doc, window.__other).item.effects.map((e) => e.type)`);
    check('copying effects leaves the removed background behind', copied && !other.includes('cutout') && other.includes('drop_shadow'), JSON.stringify(other));
    await exec('App.S.dirty = false');
  };
}
