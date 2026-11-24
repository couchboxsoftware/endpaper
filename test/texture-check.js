// The Texture photo effect: drawn textures that tile seamlessly, your own textures in a library
// (tagged Tiles or Doesn't tile), a copy kept in each design that uses one, the settings in Edit
// photo, copy and paste into another design, Check and the PDF.
// Run: node test/texture-check.js
const path = require('path');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const run = await H.launch(__filename, { userData: H.tempUserData('texture'), env: { ENDPAPER_TEST_SHOTS: process.env.ENDPAPER_TEST_SHOTS || null } });
    H.finish('texture-check', [run]);
  })();
} else {
  module.exports = async ({ exec, shot }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    await appReady();
    const key = (k, mods = {}) => exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, altKey: ${!!mods.alt}, bubbles: true, cancelable: true }))`);
    const shots = process.env.ENDPAPER_TEST_SHOTS;

    // A design with a plain mid-grey photo, so a texture shows clearly.
    const PHOTO = `(async (d) => {
      const c = document.createElement('canvas'); c.width = 900; c.height = 600; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 900, 0); gr.addColorStop(0, '#3b6ea5'); gr.addColorStop(1, '#e0b07a'); g.fillStyle = gr; g.fillRect(0, 0, 900, 600);
      const bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      const id = await Assets.add(d, { name: 'photo.png', mime: 'image/png', bytes });
      let it; App.change('Add photo', () => { it = Model.newItem('image', 14, 20, 120, 80, d); it.asset = id; Render.fitImage(it, d.assets[id], 'fill'); d.pages[0].items.push(it); });
      return it.id;
    })`;
    await exec(`(async () => {
      await App.newDocument({ name: 'Textures', w: 148, h: 210, pages: 1, kind: 'print', bleed: 3 });
      window.__id = await ${PHOTO}(App.S.doc);
      App.select([window.__id]);
    })()`);
    await wait(300);
    const IT = `Model.findItem(App.S.doc, window.__id).item`;

    // Drawn textures: eleven, and every one repeats without a join.
    const gen = await exec(`(() => {
      const ids = TextureGen.PRESETS.map((p) => p.id);
      const seamless = ids.filter((id) => TextureGen.seamless(TextureGen.make(id, { size: 256, seed: 3 })));
      // A picture that obviously doesn't repeat: dark on the left, light on the right.
      const c = document.createElement('canvas'); c.width = 200; c.height = 200; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 200, 0); gr.addColorStop(0, '#111'); gr.addColorStop(1, '#eee'); g.fillStyle = gr; g.fillRect(0, 0, 200, 200);
      const t0 = performance.now(); TextureGen.make('watercolour', { size: 1024, seed: 9 }); const ms = Math.round(performance.now() - t0);
      return { n: ids.length, names: TextureGen.PRESETS.map((p) => p.name).join(', '), seamless: seamless.length, notSeamless: TextureGen.seamless(c), ms };
    })()`);
    check('there are eleven drawn textures', gen.n === 11, gen.names);
    check('every drawn texture repeats seamlessly', gen.seamless === 11, JSON.stringify(gen));
    check('a picture that is light on one side and dark on the other does not', gen.notSeamless === false);
    check('a print-size drawn texture is quick to make', gen.ms < 3000, gen.ms + ' ms');

    // The effect changes the photo, and its size changes the pattern.
    const fx = await exec(`(() => {
      const it = ${IT};
      const px = () => { const v = PhotoEdit.view(App.S.doc, it); const c = document.createElement('canvas'); c.width = v.img.width || v.img.naturalWidth; c.height = v.img.height || v.img.naturalHeight; c.getContext('2d').drawImage(v.img, 0, 0); return [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data]; };
      const plain = px();
      const e = PhotoFX.make('texture'); it.effects = [e];
      const a = px();
      e.p.size = 80; const b = px();
      e.p.blend = 'screen'; const sc = px();
      let diffA = 0, diffB = 0, darker = 0, lighter = 0;
      for (let i = 0; i < plain.length; i += 4) { diffA += Math.abs(a[i] - plain[i]); diffB += Math.abs(a[i] - b[i]); darker += plain[i] - a[i]; lighter += sc[i] - plain[i]; }
      it.effects = [];
      return { diffA, diffB, darker, lighter, name: PhotoFX.TYPES.texture.name, group: PhotoFX.TYPES.texture.group };
    })()`);
    check('Texture is an effect in Detail and look', fx.name === 'Texture' && fx.group === 'Detail and look');
    check('a texture changes the photo', fx.diffA > 1000, JSON.stringify(fx));
    check('...Multiply darkens it and Screen lightens it', fx.darker > 0 && fx.lighter > 0, JSON.stringify(fx));
    check('...and a different size gives a different pattern', fx.diffB > 1000, JSON.stringify(fx));

    // Your own textures: one that repeats and one that doesn't, added to the library.
    const own = await exec(`(async () => {
      const blobOf = (c) => new Promise((r) => c.toBlob(r, 'image/png')).then((b) => b.arrayBuffer()).then((x) => new Uint8Array(x));
      const tile = TextureGen.make('linen', { size: 300, seed: 5 });
      const g = document.createElement('canvas'); g.width = 300; g.height = 200; const x = g.getContext('2d');
      const gr = x.createLinearGradient(0, 0, 300, 0); gr.addColorStop(0, '#222'); gr.addColorStop(1, '#ddd'); x.fillStyle = gr; x.fillRect(0, 0, 300, 200);
      const added = await Textures.addFiles([{ name: 'my-linen.png', mime: 'image/png', bytes: await blobOf(tile) }, { name: 'light-leak.png', mime: 'image/png', bytes: await blobOf(g) }]);
      const lib = await ep.textures.list();
      window.__tile = added[0].id; window.__one = added[1].id;
      return { added: added.map((a) => [a.name, a.tiles]), lib: lib.length };
    })()`);
    check('your own textures are added to the library', own.lib === 2, JSON.stringify(own));
    check('...the one that repeats is tagged Tiles', own.added[0][0] === 'my-linen' && own.added[0][1] === true, JSON.stringify(own));
    check("...the one that doesn't is tagged Doesn't tile", own.added[1][1] === false, JSON.stringify(own));

    // Edit photo: add a Texture, pick from the grid.
    await key('E', { ctrl: true, shift: true });
    await waitFor(() => exec(`!!document.querySelector('.modal.edit-photo')`), 3000);
    await exec(`document.querySelector('.edit-photo [data-pe="add"]').click()`);
    await wait(80);
    await exec(`document.querySelector('.pe-add [data-add="texture"]').click()`);
    check('the texture grid shows', await waitFor(() => exec(`document.querySelectorAll('.pe-texture .tx-sw').length === 13`), 3000), await exec(`document.querySelectorAll('.pe-texture .tx-sw').length`));
    const tags = await exec(`[...document.querySelectorAll('.pe-texture .tx-sw')].map((s) => s.querySelector('.tx-name').textContent + '=' + s.querySelector('.tx-tag').textContent)`);
    check('each swatch has its tag', tags.filter((t) => /=Tiles$/.test(t)).length === 12 && tags.some((t) => t === "light-leak=Doesn't tile"), tags.join(' | '));
    check('Canvas is chosen to start with', /Canvas/.test(await exec(`document.querySelector('.pe-texture .tx-sw.on .tx-name').textContent`)));
    await exec(`document.querySelector('.pe-texture [data-tx="preset:crumpled"]').click()`);
    await wait(200);
    const pick = await exec(`(() => { const r = document.querySelector('.pe-row.on .pe-name').textContent; const k = [...document.querySelectorAll('.pe-settings [data-k]')].map((x) => x.dataset.k); return { r, k }; })()`);
    check('picking a texture names it in the list', pick.r === 'Texture · Crumpled paper', pick.r);
    check('Tile shows Size and Mirror tiles, not Zoom', pick.k.includes('size') && pick.k.includes('mirror') && !pick.k.includes('zoom'), pick.k.join(','));
    check('...and a drawn texture has Shuffle', await exec(`!!document.querySelector('.pe-settings [data-shuffle]')`));
    const setSel = (k, v) => exec(`(() => { const s = document.querySelector('.pe-settings [data-k="${k}"]'); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await setSel('layout', 'stretch');
    await wait(100);
    let ks = await exec(`[...document.querySelectorAll('.pe-settings [data-k]')].map((x) => x.dataset.k)`);
    check('Stretch swaps Size for Zoom', ks.includes('zoom') && !ks.includes('size') && !ks.includes('mirror'), ks.join(','));
    await setSel('colour', 'tint');
    await wait(100);
    check('Tint shows a colour to tint with', await exec(`!!document.querySelector('.pe-settings [data-colour="tint"]')`));
    await setSel('layout', 'tile');
    await wait(100);
    const seed0 = await exec(`document.querySelector('.pe-settings [data-shuffle]') && 1`);
    await exec(`document.querySelector('.pe-settings [data-shuffle]').click()`);
    await wait(100);
    if (shots) await shot(path.join(shots, 'texture-window.png'));
    // Your own one that doesn't tile: chosen, it's mirrored and Shuffle goes.
    await exec(`document.querySelector('.pe-texture [data-tx="own:' + window.__one + '"]').click()`);
    await wait(300);
    const mir = await exec(`(() => { const m = document.querySelector('.pe-settings [data-k="mirror"]'); return { mirror: m && m.checked, shuffle: !!document.querySelector('.pe-settings [data-shuffle]'), name: document.querySelector('.pe-row.on .pe-name').textContent }; })()`);
    check("a texture that doesn't tile is mirrored", mir.mirror === true, JSON.stringify(mir));
    check('...your own textures have no Shuffle', mir.shuffle === false && seed0 === 1, JSON.stringify(mir));
    check('...and it shows by its name', mir.name === 'Texture · light-leak', mir.name);
    check('the design keeps its own copy of the texture', await exec(`!!App.S.doc.textures[window.__one] && App.S.doc.textures[window.__one].tiles === false`));
    await exec(`document.querySelector('.edit-photo [data-pe="done"]').click()`);
    await wait(300);
    check('Done saves the texture effect', await exec(`${IT}.effects.length === 1 && ${IT}.effects[0].p.tex.id === window.__one && ${IT}.effects[0].p.mirror === true`));
    check('Properties lists it by name', /Texture · light-leak/.test(await exec(`document.querySelector('.pe-quick').textContent`)));

    // The library: rename and change the tag; removing it leaves designs alone.
    const lib = await exec(`(async () => {
      await Textures.rename(App.S.doc, window.__one, 'Light leak');
      await Textures.setTiles(App.S.doc, window.__one, true);
      const l = (await ep.textures.list()).find((t) => t.id === window.__one);
      await Textures.remove(window.__tile);
      const after = await ep.textures.list();
      return { name: l.name, tiles: l.tiles, docName: App.S.doc.textures[window.__one].name, left: after.length };
    })()`);
    check('renaming and retagging change the library and the design', lib.name === 'Light leak' && lib.tiles === true && lib.docName === 'Light leak', JSON.stringify(lib));
    check('removing from the library leaves the others', lib.left === 1, JSON.stringify(lib));

    // Saved files keep only textures that are used.
    const pruned = await exec(`(() => {
      const d = JSON.parse(JSON.stringify(App.S.doc));
      d.textures.unused = { name: 'x', mime: 'image/png', data: '', w: 1, h: 1, tiles: true };
      Model.pruneAssets(d);
      return Object.keys(d.textures);
    })()`);
    check('saving keeps used textures and drops unused ones', pruned.length === 1 && pruned[0] === (await exec('window.__one')), JSON.stringify(pruned));

    // Check: a small texture stretched big prints soft.
    const warn = await exec(`(() => {
      App.change('Stretch', () => { const e = ${IT}.effects[0]; e.p.layout = 'stretch'; e.p.zoom = 300; });
      return Preflight.run(App.S.doc).filter((x) => /texture/.test(x.text || x.msg || x.message || '')).map((x) => x.text || x.msg || x.message);
    })()`);
    check('Check warns when your own texture will print soft', warn.length === 1 && /Light leak/.test(warn[0]), JSON.stringify(warn));

    // The PDF builds with the texture.
    const pdf = await exec(`(async () => {
      const b = await Pdf.build(App.S.doc, { surfaces: [{ kind: 'page', idx: 0 }], bleed: true, cropMarks: true, pdfx: true, maxPpi: 450, targetPpi: 300, title: 'tx' });
      return { len: b.length, head: String.fromCharCode(...b.subarray(0, 5)) };
    })()`);
    check('the PDF builds', pdf.head === '%PDF-' && pdf.len > 1000, JSON.stringify(pdf));

    // Copy the effects, paste into a new design: the texture comes too.
    await exec(`App.select([window.__id])`);
    await key('c', { ctrl: true, alt: true });
    await wait(100);
    const moved = await exec(`(async () => {
      App.S.dirty = false;
      await App.newDocument({ name: 'Other', w: 148, h: 210, pages: 1, kind: 'print', bleed: 3 });
      const id = await ${PHOTO}(App.S.doc);
      App.select([id]);
      await PhotoEdit.pasteEffects([Model.findItem(App.S.doc, id).item]);
      await new Promise((r) => setTimeout(r, 300));
      const it = Model.findItem(App.S.doc, id).item;
      const v = PhotoEdit.view(App.S.doc, it);
      return { has: !!App.S.doc.textures[window.__one], effect: it.effects[0] && it.effects[0].p.tex.id === window.__one, drawn: !!v };
    })()`);
    check('pasting effects into another design brings the texture with it', moved.has && moved.effect && moved.drawn, JSON.stringify(moved));
    if (shots) {
      await wait(400);
      await shot(path.join(shots, 'texture-page.png'));
    }
    await exec('App.S.dirty = false');
  };
}
