/* Photos kept in the document, and drawing a page onto a canvas (page thumbnails and PNG/JPG
   export). The editor itself draws with HTML so boxes can be dragged; both use the same layout. */
const Assets = (() => {
  const imgs = new Map(); // asset id -> { img, url, w, h }
  const pending = new Map();
  function load(doc, id) {
    if (imgs.has(id)) return Promise.resolve(imgs.get(id));
    if (pending.has(id)) return pending.get(id);
    const a = doc.assets[id];
    if (!a) return Promise.resolve(null);
    const p = (async () => {
      const blob = new Blob([base64ToBytes(a.data)], { type: a.mime });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      const v = { img, url, w: img.naturalWidth, h: img.naturalHeight };
      imgs.set(id, v);
      return v;
    })()
      .catch(() => null)
      .finally(() => pending.delete(id));
    pending.set(id, p);
    return p;
  }
  const get = (id) => imgs.get(id) || null;
  // A small copy (up to 512 px across) for thumbnails and small views, made once, so they don't
  // draw from the full-size photo every time.
  const PROXY = 512;
  function proxy(id) {
    const v = imgs.get(id);
    if (!v) return null;
    if (!v.proxy) {
      const k = Math.min(1, PROXY / Math.max(v.w, v.h));
      if (k >= 1) v.proxy = v.img;
      else {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(v.w * k));
        c.height = Math.max(1, Math.round(v.h * k));
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(v.img, 0, 0, c.width, c.height);
        v.proxy = c;
      }
    }
    return v.proxy;
  }
  async function ensureDoc(doc) {
    await Promise.all(Object.keys(doc.assets).map((id) => load(doc, id)));
    if (typeof Textures !== 'undefined') await Textures.ensureDoc(doc); // your own textures, for photo effects
  }
  // Adds a photo file to the document; the same photo twice is stored once.
  async function add(doc, { name, mime, bytes }) {
    const data = bytesToBase64(bytes);
    const existing = Object.entries(doc.assets).find(([, a]) => a.data.length === data.length && a.data === data);
    if (existing) return existing[0];
    const id = uid('a');
    doc.assets[id] = { name, mime, data };
    const v = await load(doc, id);
    if (!v) {
      delete doc.assets[id];
      throw new Error(`${name} couldn't be opened as a picture.`);
    }
    Object.assign(doc.assets[id], { w: v.w, h: v.h });
    return id;
  }
  return { load, get, proxy, ensureDoc, add };
})();

const Render = (() => {
  // A frame's edge moved over its photo (a crop): the photo stays where it is on the page.
  // o is the frame before the move; hx, hy which edges moved (-1 left/top, 1 right/bottom, 0 not).
  // The photo only grows when the frame would show a gap it didn't have before, and then from the
  // frame's fixed edge, so the rest of the crop holds. Gaps it already had (Fit in frame) stay.
  function cropTo(it, o, hx, hy, a) {
    if (!a) return;
    it.ox = o.ox + (hx === -1 ? it.w - o.w : 0);
    it.oy = o.oy + (hy === -1 ? it.h - o.h : 0);
    it.s = o.s;
    const d = PhotoEdit.dims(it, a);
    const E = 0.01;
    const pw = d.w * o.s, ph = d.h * o.s;
    const had = { l: o.ox <= E, t: o.oy <= E, r: o.ox + pw >= o.w - E, b: o.oy + ph >= o.h - E };
    const ax = hx === 1 ? 0 : hx === -1 ? it.w : it.w / 2;
    const ay = hy === 1 ? 0 : hy === -1 ? it.h : it.h / 2;
    const at = (s) => ({ ox: ax + (it.ox - ax) * s, oy: ay + (it.oy - ay) * s, pw: pw * s, ph: ph * s });
    const covered = (s) => {
      const p = at(s);
      return (!had.l || p.ox <= E) && (!had.t || p.oy <= E) && (!had.r || p.ox + p.pw >= it.w - E) && (!had.b || p.oy + p.ph >= it.h - E);
    };
    if (covered(1)) return;
    let lo = 1, hi = 2;
    while (!covered(hi) && hi < 1e4) hi *= 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (covered(mid)) hi = mid;
      else lo = mid;
    }
    const p = at(hi);
    Object.assign(it, { s: o.s * hi, ox: p.ox, oy: p.oy });
  }
  // Photo placement inside its frame: fill (cover) or fit (contain), centred.
  function fitImage(it, a, mode = 'fill') {
    if (!a) return;
    a = PhotoEdit.dims(it, a); // a turn of 90° swaps the photo's width and height
    const sx = it.w / a.w;
    const sy = it.h / a.h;
    it.s = mode === 'fit' ? Math.min(sx, sy) : Math.max(sx, sy);
    it.ox = (it.w - a.w * it.s) / 2;
    it.oy = (it.h - a.h * it.s) / 2;
    it.fit = mode;
  }
  // Effective resolution of a placed photo, in pixels per inch.
  const ppi = (it) => (it.s ? 25.4 / it.s : 0);

  function itemsOf(doc, surface) {
    const own = Model.surfaceItems(doc, surface);
    if (surface.kind === 'page') return [...Model.masterItems(doc, surface.idx).map((it) => ({ it, master: true })), ...own.map((it) => ({ it }))];
    // A cover page shows only the boxes on its part of the cover sheet.
    return own.filter((it) => Model.onSurface(doc, surface, it)).map((it) => ({ it }));
  }
  const ctxFor = (doc, surface) => (surface.kind === 'page' ? { page: Model.pageNumber(doc, surface.idx) } : { page: null });

  // Draws one surface. scale is pixels per mm; bleed=true includes the bleed area.
  function draw(ctx, doc, surface, scale, { bleed = true } = {}) {
    const sz = Model.surfaceSize(doc, surface);
    const b = bleed ? sz.bleed : 0;
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, (sz.w + 2 * b) * scale, (sz.h + 2 * b) * scale);
    ctx.translate(b * scale, b * scale);
    ctx.beginPath();
    ctx.rect(-b * scale, -b * scale, (sz.w + 2 * b) * scale, (sz.h + 2 * b) * scale);
    ctx.clip();
    ctx.translate(-Model.surfaceOrigin(doc, surface) * scale, 0);
    const pc = ctxFor(doc, surface);
    // Groups, text and shapes with effects are drawn with them (renderer/itemfx.js), once, where
    // their first box is.
    const list = itemsOf(doc, surface).map((x) => x.it);
    const fx = new Map();
    for (const e of ItemFX.entities(doc, list)) for (const it of e.items) fx.set(it.id, e);
    const done = new Set();
    for (const it of list) {
      const e = fx.get(it.id);
      if (e) {
        if (!done.has(e.key)) done.add(e.key), ItemFX.draw(ctx, doc, e, scale, pc);
      } else if (!it.hidden) drawItem(ctx, doc, it, scale, pc);
    }
    ctx.restore();
  }

  function drawItem(ctx, doc, it, k, pc) {
    ctx.save();
    ctx.globalAlpha = it.opacity ?? 1;
    ctx.translate((it.x + it.w / 2) * k, (it.y + it.h / 2) * k);
    if (it.rot) ctx.rotate((it.rot * Math.PI) / 180);
    ctx.translate((-it.w / 2) * k, (-it.h / 2) * k);
    const fill = Model.resolveColor(doc, it.fill);
    const stroke = Model.resolveColor(doc, it.stroke);
    const sw = (it.strokeW || 0) * k;
    if (it.type === 'rect' || it.type === 'ellipse') {
      ctx.beginPath();
      if (it.type === 'rect') ctx.roundRect(0, 0, it.w * k, it.h * k, Math.min(it.radius || 0, it.w / 2, it.h / 2) * k);
      else ctx.ellipse((it.w / 2) * k, (it.h / 2) * k, (it.w / 2) * k, (it.h / 2) * k, 0, 0, Math.PI * 2);
      if (fill) (ctx.fillStyle = Color.css(fill)), ctx.fill();
      if (stroke && sw) (ctx.strokeStyle = Color.css(stroke)), (ctx.lineWidth = sw), ctx.stroke();
    } else if (it.type === 'line') {
      if (stroke && sw) {
        ctx.beginPath();
        ctx.moveTo(0, (it.h / 2) * k);
        ctx.lineTo(it.w * k, (it.h / 2) * k);
        ctx.strokeStyle = Color.css(stroke);
        ctx.lineWidth = sw;
        ctx.lineCap = 'butt';
        ctx.stroke();
      }
    } else if (it.type === 'image') {
      // The photo with its effects, cropped by the frame (renderer/photoedit.js).
      PhotoEdit.drawFrame(ctx, doc, it, k);
      ctx.beginPath();
      ctx.rect(0, 0, it.w * k, it.h * k);
      if (stroke && sw) (ctx.strokeStyle = Color.css(stroke)), (ctx.lineWidth = sw), ctx.stroke();
    } else if (it.type === 'barcode') {
      Barcode.draw(ctx, doc, it, k);
    } else if (it.type === 'text') {
      const L = Layout.box(doc, it, pc);
      const st = L.style || Model.styleOf(doc, it);
      const f = L.font;
      if (f) {
        const col = Model.resolveColor(doc, st.color);
        ctx.fillStyle = Color.css(col || { c: 0, m: 0, y: 0, k: 100 });
        ctx.font = `${L.size * k}px "${f.cssName}"`;
        ctx.letterSpacing = `${((st.tracking || 0) / 1000) * L.size * k}px`;
        ctx.textBaseline = 'alphabetic';
        for (const l of L.lines) {
          if (l.justified) for (const w of l.words) ctx.fillText(w.t, w.x * k, l.y * k);
          else ctx.fillText(l.text, l.x * k, l.y * k);
        }
      }
    }
    ctx.restore();
  }

  // A thumbnail data URL for a surface, about `px` pixels wide.
  function thumb(doc, surface, px = 160) {
    const sz = Model.surfaceSize(doc, surface);
    const scale = px / sz.w;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sz.w * scale));
    c.height = Math.max(1, Math.round(sz.h * scale));
    draw(c.getContext('2d'), doc, surface, scale, { bleed: false });
    return c;
  }

  return { fitImage, cropTo, ppi, itemsOf, ctxFor, draw, drawItem, thumb };
})();
