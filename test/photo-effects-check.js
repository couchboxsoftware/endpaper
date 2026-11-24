// Photo effects: a photo frame keeps a list of effects (light, colour, detail, shape and
// blending). They show on the page and in the PDF; Edit photo (Ctrl+Shift+E) adds, reorders and
// changes them; Properties turns them on and off; a master's effects carry into a page's copy.
// Run: node test/photo-effects-check.js
const path = require('path');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const run = await H.launch(__filename, { userData: H.tempUserData('photofx'), env: { ENDPAPER_TEST_SHOTS: process.env.ENDPAPER_TEST_SHOTS || null } });
    H.finish('photo-effects-check', [run]);
  })();
} else {
  module.exports = async ({ exec, shot }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    await appReady();
    const key = (k, mods = {}) => exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, bubbles: true, cancelable: true }))`);
    const shots = process.env.ENDPAPER_TEST_SHOTS;

    // A design with two pages and a test photo: red on the left half, blue on the right.
    await exec(`(async () => {
      await App.newDocument({ name: 'FX', w: 148, h: 210, pages: 2, kind: 'print', bleed: 3 });
      const d = App.S.doc;
      const c = document.createElement('canvas'); c.width = 800; c.height = 600; const g = c.getContext('2d');
      g.fillStyle = '#d02020'; g.fillRect(0, 0, 400, 600); g.fillStyle = '#2040d0'; g.fillRect(400, 0, 400, 600);
      const bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      window.__aid = await Assets.add(d, { name: 'test.png', mime: 'image/png', bytes });
      App.change('Add photo', () => {
        const it = Model.newItem('image', 20, 20, 100, 75, d); it.asset = window.__aid; Render.fitImage(it, d.assets[window.__aid], 'fill');
        d.pages[0].items.push(it); window.__id = it.id;
      });
      App.select([window.__id]);
    })()`);
    await wait(400);
    const IT = `Model.findItem(App.S.doc, window.__id).item`;
    const sample = (x, y) => exec(`(() => { const v = PhotoEdit.view(App.S.doc, ${IT}); let cv = v.img; if (!cv.getContext) { cv = document.createElement('canvas'); cv.width = v.img.naturalWidth; cv.height = v.img.naturalHeight; cv.getContext('2d').drawImage(v.img, 0, 0); } return [...cv.getContext('2d').getImageData(Math.round(cv.width * ${x}), Math.round(cv.height * ${y}), 1, 1).data].slice(0, 3); })()`);

    // Properties: an Effects section with nothing in it yet, and Edit photo….
    check('Properties has an Edit photo… button', await exec(`!!document.querySelector('[data-act="edit-photo"]')`));
    check('...and says there are no effects yet', /No effects yet/.test(await exec(`document.querySelector('.pe-quick').textContent`)));
    check('Object, Edit photo… is in the menu', await exec(`document.getElementById('menubar').textContent.includes('Object')`));

    // Ctrl+Shift+E opens the window.
    await key('E', { ctrl: true, shift: true });
    check('Ctrl+Shift+E opens Edit photo', await waitFor(() => exec(`!!document.querySelector('.modal.edit-photo')`), 3000));
    check('...titled with the photo name', /Edit photo · test\.png/.test(await exec(`document.querySelector('.modal.edit-photo h2').textContent`)));
    const add = async (type) => {
      await exec(`document.querySelector('.edit-photo [data-pe="add"]').click()`);
      await wait(80);
      await exec(`document.querySelector('.pe-add [data-add="${type}"]').click()`);
      await wait(120);
    };
    await add('black_white');
    await add('invert');
    let rows = await exec(`[...document.querySelectorAll('.pe-row .pe-name')].map((x) => x.textContent)`);
    check('added effects are listed, the last added on top', rows.join(',') === 'Invert,Black and white', rows.join(','));
    check('the newest effect is selected, with a strength slider', await exec(`document.querySelector('.pe-settings h5').textContent === 'Invert' && !!document.querySelector('.pe-settings [data-k="__strength"]')`));
    check('the add list groups the effects', (await exec(`(() => { document.querySelector('.edit-photo [data-pe="add"]').click(); const n = document.querySelectorAll('.pe-add h6').length; document.querySelector('.pe-add').remove(); return n; })()`)) === 4);
    check('the preview draws', await exec(`document.querySelector('.pe-canvas').width > 100`));

    // Drag Black and white above Invert.
    await exec(`(() => {
      const rows = document.querySelectorAll('.pe-row');
      const dt = new DataTransfer();
      rows[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const r = rows[0].getBoundingClientRect();
      rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }));
    })()`);
    await wait(100);
    rows = await exec(`[...document.querySelectorAll('.pe-row .pe-name')].map((x) => x.textContent)`);
    check('dragging reorders the list', rows.join(',') === 'Black and white,Invert', rows.join(','));
    if (shots) await shot(path.join(shots, 'photo-edit-window.png'));

    // Done saves them to the frame, as one step to undo.
    await exec(`document.querySelector('.edit-photo [data-pe="done"]').click()`);
    await wait(200);
    check('Done closes the window', await exec(`!document.querySelector('.modal.edit-photo')`));
    const types = await exec(`${IT}.effects.map((e) => e.type).join(',')`);
    check('the frame keeps the effects in order', types === 'invert,black_white', types);
    const px = await sample(0.12, 0.5);
    check('the page shows them: red, inverted, then grey', Math.abs(px[0] - px[1]) < 6 && Math.abs(px[1] - px[2]) < 6 && px[0] > 120, px.join(','));
    check('Properties lists them', (await exec(`document.querySelectorAll('.pe-qrow').length`)) === 2);
    await key('z', { ctrl: true });
    await wait(150);
    check('Undo takes them off again', (await exec(`(${IT}.effects || []).length`)) === 0);
    await key('z', { ctrl: true, shift: true });
    await wait(150);
    check('Redo puts them back', (await exec(`(${IT}.effects || []).length`)) === 2);

    // Properties' eye turns one off without the window.
    await exec(`App.select([window.__id])`);
    await wait(150);
    await exec(`document.querySelector('.pe-quick [data-fx-toggle]').click()`);
    await wait(150);
    check('the eye in Properties hides an effect', (await exec(`${IT}.effects.filter((e) => !e.on).length`)) === 1);
    const px2 = await sample(0.12, 0.5);
    check('...and the page changes: red, just inverted, is cyan', px2[2] > px2[0] + 40, px2.join(','));

    // Cancel throws away changes.
    await key('E', { ctrl: true, shift: true });
    await waitFor(() => exec(`!!document.querySelector('.modal.edit-photo')`), 3000);
    await add('blur');
    await exec(`document.querySelector('.edit-photo [data-pe="cancel"]').click()`);
    await wait(150);
    check('Cancel leaves the effects as they were', (await exec(`${IT}.effects.length`)) === 2);

    // A 90° turn changes the photo's shape, and it's fitted to the frame again.
    await key('E', { ctrl: true, shift: true });
    await waitFor(() => exec(`!!document.querySelector('.modal.edit-photo')`), 3000);
    await add('flip_rotate');
    await exec(`(() => { const s = document.querySelector('.pe-settings [data-k="rotate"]'); s.value = '90'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await add('flip_rotate');
    check('flip and rotate can only be added once', (await exec(`document.querySelectorAll('.pe-row').length`)) === 3);
    await exec(`document.querySelector('.edit-photo [data-pe="done"]').click()`);
    await wait(200);
    const fit = await exec(`(() => { const it = ${IT}; const dm = PhotoEdit.dims(it, App.S.doc.assets[it.asset]); return { w: dm.w, h: dm.h, covers: dm.w * it.s >= it.w - 0.01 && dm.h * it.s >= it.h - 0.01 }; })()`);
    check('the turned photo is 600 × 800 and still fills the frame', fit.w === 600 && fit.h === 800 && fit.covers, JSON.stringify(fit));

    // Masters: effects on a master box carry into a page's own copy, and stay linked until changed there.
    const m = await exec(`(() => {
      const d = App.S.doc;
      let mid;
      App.change('Master photo', () => {
        const it = Model.newItem('image', 10, 120, 60, 45, d); it.asset = window.__aid; Render.fitImage(it, d.assets[window.__aid], 'fill');
        it.effects = [PhotoFX.make('black_white')];
        d.masters[0].right.push(it); d.masters[0].left.push(JSON.parse(JSON.stringify(it))); mid = it.id;
      });
      window.__mid = mid;
      App.overrideMaster(1, mid);
      const copy = d.pages[1].items.find((x) => x.masterRef === mid);
      return { has: !!copy, types: copy && copy.effects.map((e) => e.type).join(',') };
    })()`);
    check('Ctrl+Shift+click copy of a master photo has its effects', m.has && m.types === 'black_white', JSON.stringify(m));
    const flow = await exec(`(() => {
      const d = App.S.doc;
      const mi = () => [...d.masters[0].left, ...d.masters[0].right].filter((x) => x.id === window.__mid);
      const copy = () => d.pages[1].items.find((x) => x.masterRef === window.__mid);
      App.change('Master effect', () => { for (const x of mi()) x.effects[0].strength = 50; });
      const followed = copy().effects[0].strength === 50;
      App.change('Page effect', () => copy().effects.push(PhotoFX.make('vignette')));
      App.change('Master effect again', () => { for (const x of mi()) x.effects.push(PhotoFX.make('grain')); });
      const kept = copy().effects.map((e) => e.type).join(',');
      return { followed, kept };
    })()`);
    check("the copy follows the master's effects while left alone", flow.followed, JSON.stringify(flow));
    check('once changed on the page, the copy keeps its own', flow.kept === 'black_white,vignette', JSON.stringify(flow));

    // The PDF: fade edges as a soft mask, blend mode as a PDF blend.
    const pdf = await exec(`(async () => {
      const d = App.S.doc;
      App.change('Frame effects', () => { ${IT}.effects.push(PhotoFX.make('fade_edges'), PhotoFX.make('blend_mode'), PhotoFX.make('drop_shadow')); });
      const bytes = await Pdf.build(d, { surfaces: [{ kind: 'page', idx: 0 }], bleed: true, cropMarks: true, pdfx: true, maxPpi: 450, targetPpi: 300, title: 'fx' });
      let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      return { len: bytes.length, smask: (s.match(/\\/SMask/g) || []).length, multiply: /\\/BM\\s*\\/Multiply/.test(s), head: s.slice(0, 8) };
    })()`);
    check('the PDF builds', pdf.head.startsWith('%PDF') && pdf.len > 1000, JSON.stringify(pdf));
    check('...with soft masks for the faded edges and the shadow', pdf.smask >= 2, JSON.stringify(pdf));
    check('...and the blend mode', pdf.multiply, JSON.stringify(pdf));

    // The right-click menu offers Edit photo….
    const ctx = await exec(`(() => {
      const el = document.querySelector('.item[data-id="' + window.__id + '"]');
      if (!el) return 'no item';
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
      const t = document.querySelector('.ctx') ? document.querySelector('.ctx').textContent : '';
      document.querySelector('.ctx') && document.querySelector('.ctx').remove();
      return t;
    })()`);
    check('the right-click menu has Edit photo…', /Edit photo…/.test(ctx), ctx);
    if (shots) {
      await exec(`App.select([window.__id])`);
      await wait(400);
      await shot(path.join(shots, 'photo-edit-page.png'));
    }
    await exec('App.S.dirty = false');
  };
}
