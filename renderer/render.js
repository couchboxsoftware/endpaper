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
  async function ensureDoc(doc) {
    await Promise.all(Object.keys(doc.assets).map((id) => load(doc, id)));
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
  return { load, get, ensureDoc, add };
})();

const Render = (() => {
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
    for (const { it } of itemsOf(doc, surface)) if (!it.hidden) drawItem(ctx, doc, it, scale, pc);
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

  return { fitImage, ppi, itemsOf, ctxFor, draw, drawItem, thumb };
})();
