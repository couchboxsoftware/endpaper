/* Textures for the Texture photo effect, the Endpaper side.

   - Drawn textures come from renderer/texturegen.js and need nothing saved: a Texture effect just
     says { kind: 'preset', id }.
   - Your own textures ({ kind: 'own', id }) live in a library on this computer (userData/textures,
     see main.js), and a design keeps its own copy of each one it uses in doc.textures, so it
     opens anywhere, like photos.
   - Every texture is tagged Tiles or Doesn't tile. Drawn ones always tile; your own are checked
     when you add them (TextureGen.seamless), and you can change the tag by right-clicking.

   Also here: the texture picker shown in the Texture effect's settings (Edit photo). */
const Textures = (() => {
  const loaded = new Map(); // own texture id -> { img, w, h } ready to draw
  const pending = new Map();
  const thumbs = new Map(); // 'preset:id' or 'own:id' -> data URL for swatches
  let library = null; // [{ id, name, mime, w, h, tiles }]

  /* ---------- pictures ---------- */
  async function decode(bytes, mime) {
    return createImageBitmap(new Blob([bytes], { type: mime || 'image/png' }));
  }
  // Gets a design's copy of a texture ready to draw.
  function load(doc, id) {
    if (loaded.has(id)) return Promise.resolve(loaded.get(id));
    if (pending.has(id)) return pending.get(id);
    const t = doc && doc.textures && doc.textures[id];
    if (!t) return Promise.resolve(null);
    const p = decode(base64ToBytes(t.data), t.mime)
      .then((img) => {
        const v = { img, w: img.width, h: img.height };
        loaded.set(id, v);
        return v;
      })
      .catch(() => null)
      .finally(() => pending.delete(id));
    pending.set(id, p);
    return p;
  }
  const ensureDoc = (doc) => Promise.all(Object.keys((doc && doc.textures) || {}).map((id) => load(doc, id)));

  // What PhotoFX.render calls for a texture: { img, tiles }, or null while it's still loading
  // (onMissing is told, and onLoaded runs once it's ready).
  function resolver(doc, { onMissing, onLoaded } = {}) {
    return (ref, px, seed) => {
      if (!ref) return null;
      if (ref.kind === 'preset') {
        const N = Math.min(2048, Math.max(64, Math.pow(2, Math.ceil(Math.log2(Math.max(1, px))))));
        const img = TextureGen.make(ref.id, { size: N, seed: seed || 1 });
        return img ? { img, tiles: true } : null;
      }
      const t = doc && doc.textures && doc.textures[ref.id];
      const v = loaded.get(ref.id);
      if (v) return { img: v.img, tiles: t ? t.tiles : true };
      if (t) {
        if (onMissing) onMissing();
        load(doc, ref.id).then(() => (onLoaded ? onLoaded() : App.render()));
      }
      return null;
    };
  }

  /* ---------- the library on this computer ---------- */
  async function list() {
    if (!library) library = (await ep.textures.list()) || [];
    return library;
  }
  // files: [{ name, mime, bytes }]. Checks each one and adds it to the library.
  async function addFiles(files) {
    await list();
    const added = [];
    for (const f of files || []) {
      let img;
      try {
        img = await decode(f.bytes, f.mime);
      } catch {
        toast(`${f.name} couldn't be opened as a picture.`, { kind: 'error' });
        continue;
      }
      const id = uid('t');
      const entry = await ep.textures.add({ id, name: f.name.replace(/\.[a-z0-9]+$/i, ''), mime: f.mime, bytes: f.bytes, w: img.width, h: img.height, tiles: TextureGen.seamless(img) });
      if (!entry) continue;
      library.push(entry);
      loaded.set(entry.id, { img, w: img.width, h: img.height });
      added.push(entry);
    }
    return added;
  }
  async function pickAndAdd() {
    const files = await ep.image.pick(true);
    return addFiles(files);
  }
  // Puts a copy of a library texture into the design, so it travels with it.
  async function useIn(doc, id) {
    doc.textures = doc.textures || {};
    if (!doc.textures[id]) {
      const t = (await list()).find((x) => x.id === id);
      const bytes = t && (await ep.textures.read(id));
      if (!bytes) return false;
      doc.textures[id] = { name: t.name, mime: t.mime, data: bytesToBase64(new Uint8Array(bytes)), w: t.w, h: t.h, tiles: t.tiles };
    }
    await load(doc, id);
    return true;
  }
  async function rename(doc, id, name) {
    const t = await ep.textures.update(id, { name });
    if (t) Object.assign(library.find((x) => x.id === id) || {}, t);
    if (doc && doc.textures && doc.textures[id]) doc.textures[id].name = name;
  }
  async function setTiles(doc, id, tiles) {
    const t = await ep.textures.update(id, { tiles });
    if (t) Object.assign(library.find((x) => x.id === id) || {}, t);
    if (doc && doc.textures && doc.textures[id]) doc.textures[id].tiles = tiles;
  }
  async function remove(id) {
    await ep.textures.remove(id);
    library = (library || []).filter((x) => x.id !== id);
  }

  /* ---------- names, tags and swatches ---------- */
  // Every texture you can pick: drawn ones, your library, and any this design brought with it.
  async function choices(doc) {
    const lib = await list();
    const own = lib.map((t) => ({ kind: 'own', id: t.id, name: t.name, tiles: t.tiles, inLibrary: true }));
    for (const [id, t] of Object.entries((doc && doc.textures) || {})) if (!lib.some((x) => x.id === id)) own.push({ kind: 'own', id, name: t.name, tiles: t.tiles, inLibrary: false });
    return [...TextureGen.PRESETS.map((p) => ({ kind: 'preset', id: p.id, name: p.name, tiles: true, mm: p.mm })), ...own];
  }
  function info(doc, ref) {
    if (!ref) return null;
    if (ref.kind === 'preset') {
      const p = TextureGen.get(ref.id);
      return p && { name: p.name, tiles: true };
    }
    const t = (doc && doc.textures && doc.textures[ref.id]) || (library || []).find((x) => x.id === ref.id);
    return t ? { name: t.name, tiles: !!t.tiles, w: t.w, h: t.h } : { name: 'Missing texture', tiles: true };
  }
  const nameOf = (doc, ref) => (info(doc, ref) || {}).name || 'Texture';
  async function thumbFor(c) {
    const key = `${c.kind}:${c.id}`;
    if (thumbs.has(key)) return thumbs.get(key);
    let src = c.kind === 'preset' ? TextureGen.make(c.id, { size: 96, seed: 1 }) : loaded.get(c.id)?.img;
    if (!src && c.kind === 'own') {
      const bytes = c.inLibrary ? await ep.textures.read(c.id) : null;
      if (bytes) src = await decode(new Uint8Array(bytes), (library || []).find((x) => x.id === c.id)?.mime).catch(() => null);
    }
    if (!src) return '';
    const cv = document.createElement('canvas');
    cv.width = cv.height = 96;
    const g = cv.getContext('2d');
    const w = src.width, h = src.height, s = Math.max(96 / w, 96 / h);
    g.drawImage(src, (96 - w * s) / 2, (96 - h * s) / 2, w * s, h * s);
    const url = cv.toDataURL('image/png');
    thumbs.set(key, url);
    return url;
  }
  const tagHtml = (tiles) => `<em class="tx-tag ${tiles ? 'tiles' : 'one'}" title="${tiles ? 'Repeats seamlessly, so it can tile with no joins' : "Doesn't repeat seamlessly. Tiling it mirrors the tiles to hide the joins"}">${tiles ? 'Tiles' : "Doesn't tile"}</em>`;

  /* ---------- the picker (in the Texture effect's settings) ---------- */
  // box: where to put it. onPick(ref, choice) when a texture is chosen.
  async function picker(box, doc, current, onPick) {
    const all = await choices(doc);
    const same = (c) => current && c.kind === current.kind && c.id === current.id;
    box.innerHTML = `<div class="tx-grid">${all
      .map((c) => `<button class="tx-sw${same(c) ? ' on' : ''}" data-tx="${c.kind}:${esc(c.id)}" title="${esc(c.name)}${c.kind === 'own' ? ' (right-click for more)' : ''}"><span class="tx-img"></span>${tagHtml(c.tiles)}<span class="tx-name">${esc(c.name)}</span></button>`)
      .join('')}</div>
      <div class="tx-actions"><button class="btn btn-sm" data-tx-add>+ Add your own…</button>${all.some((c) => c.kind === 'own') ? '<span class="hint">Right-click your own to rename or change its tag.</span>' : ''}</div>`;
    const find = (key) => all.find((c) => `${c.kind}:${c.id}` === key);
    // Swatch pictures fill in as they're ready.
    for (const el of box.querySelectorAll('[data-tx]'))
      thumbFor(find(el.dataset.tx)).then((url) => url && (el.querySelector('.tx-img').style.backgroundImage = `url(${url})`));
    box.onclick = async (e) => {
      if (e.target.closest('[data-tx-add]')) {
        const added = await pickAndAdd();
        if (!added.length) return;
        await useIn(doc, added[0].id);
        const c = { kind: 'own', id: added[0].id, name: added[0].name, tiles: added[0].tiles };
        onPick({ kind: 'own', id: c.id }, c);
        if (added.length > 1) toast(`Added ${added.length} textures to your library.`);
        return;
      }
      const sw = e.target.closest('[data-tx]');
      if (!sw) return;
      const c = find(sw.dataset.tx);
      if (c.kind === 'own' && !(await useIn(doc, c.id))) return toast("That texture couldn't be found.", { kind: 'error' });
      onPick({ kind: c.kind, id: c.id }, c);
    };
    box.oncontextmenu = (e) => {
      const sw = e.target.closest('[data-tx]');
      const c = sw && find(sw.dataset.tx);
      if (!c || c.kind !== 'own') return;
      e.preventDefault();
      const redo = () => picker(box, doc, current, onPick);
      contextMenu(e.clientX, e.clientY, [
        { label: 'Rename…', disabled: !c.inLibrary, run: () => prompt('Texture name', c.name).then((v) => v && v.trim() && rename(doc, c.id, v.trim()).then(redo)) },
        { label: `${c.tiles ? '✓ ' : ''}Tiles`, disabled: !c.inLibrary, run: () => setTiles(doc, c.id, true).then(redo) },
        { label: `${c.tiles ? '' : '✓ '}Doesn't tile`, disabled: !c.inLibrary, run: () => setTiles(doc, c.id, false).then(redo) },
        '-',
        { label: 'Remove from your library', disabled: !c.inLibrary, run: () => remove(c.id).then(redo) },
      ]);
    };
  }

  /* ---------- Check ---------- */
  // How sharp a frame's own texture will print, in ppi (drawn ones are always sharp), or null.
  function ppi(doc, it, e) {
    const t = e.p && e.p.tex;
    if (!t || t.kind !== 'own') return null;
    const i = info(doc, t);
    if (!i || !i.w) return null;
    if (e.p.layout === 'stretch') {
      const a = doc.assets[it.asset];
      const d = a && PhotoFX.outSize(a.w, a.h, it.effects);
      if (!d) return null;
      const s = Math.max((d.w * it.s) / i.w, (d.h * it.s) / i.h) * ((e.p.zoom || 100) / 100); // mm per texture pixel
      return 25.4 / s;
    }
    return (i.w * 25.4) / (e.p.size || 25);
  }

  return { load, ensureDoc, resolver, list, addFiles, pickAndAdd, useIn, rename, setTiles, remove, choices, info, nameOf, picker, tagHtml, ppi };
})();
