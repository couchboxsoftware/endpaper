/* Photo effects in Endpaper: Edit photo (Object, Edit photo, Ctrl+Shift+E), and everything that
   shows a frame's photo with its effects: the page, thumbnails, PNG/JPG and the print PDF.
   The effects themselves are in renderer/photofx.js, which knows nothing about Endpaper.

   A frame's effects are it.effects (a list, see photofx.js). They belong to the frame, so the same
   photo can look different in two frames; on a master they carry into page copies like anything
   else. The photo file itself is never changed. */
const PhotoEdit = (() => {
  /* ---------- the photo with its effects ---------- */
  const cache = new Map(); // key -> { img (canvas), w, h, url }
  const CACHE_MAX = 40;
  const colourOf = (doc) => (ref) => Color.rgb(Model.resolveColor(doc, ref) || ref || { c: 0, m: 0, y: 0, k: 100 });
  // The size of the photo after any turn, at its own resolution (for fitting it in its frame).
  function dims(it, a) {
    if (!a) return null;
    return PhotoFX.outSize(a.w, a.h, it.effects);
  }
  // scale: output pixels per photo pixel. Rounded up to a power of two, so zooming the page
  // doesn't redo the work at every step.
  function view(doc, it, { scale } = {}) {
    const a = it.asset && Assets.get(it.asset);
    if (!a) return null;
    if (!PhotoFX.hasPixelWork(it.effects)) return a;
    let s = scale == null ? Math.min(1, 1600 / Math.max(a.w, a.h)) : Math.min(1, scale);
    if (scale != null && s < 1) s = Math.min(1, Math.pow(2, Math.ceil(Math.log2(Math.max(s, 1 / 64)))));
    const fx = PhotoFX.active(it.effects).filter((e) => !PhotoFX.TYPES[e.type].frame);
    const key = [it.asset, s.toFixed(5), (it.s || 0).toFixed(6), JSON.stringify(fx), JSON.stringify(fx.filter((e) => /duotone|colour_overlay/.test(e.type)).map((e) => Object.values(e.p).filter((v) => v && v.sw).map((v) => Model.resolveColor(doc, v))))].join('|');
    let v = cache.get(key);
    if (!v) {
      // A texture or mask still loading: draw without it for now, and don't keep the result.
      let missing = false;
      const texture = Textures.resolver(doc, { onMissing: () => (missing = true) });
      const mask = maskResolver(doc, () => (missing = true));
      const img = PhotoFX.render(a.img, it.effects, { scale: s, pxPerMm: it.s ? 1 / it.s : 12, color: colourOf(doc), seed: seedOf(it), texture, mask });
      const d = dims(it, a);
      // A removed background has to stay see-through on the page, so that one is a PNG.
      const png = PhotoFX.hasAlpha(it.effects);
      v = { img, w: d.w, h: d.h, get url() { return this._url || (this._url = png ? img.toDataURL('image/png') : img.toDataURL('image/jpeg', 0.92)); } };
      if (missing) return v;
      cache.set(key, v);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    } else {
      cache.delete(key);
      cache.set(key, v); // most recently used last
    }
    return v;
  }
  // Remove background's masks are kept like photos (doc.assets: a greyscale PNG, white kept), so
  // saving, undo and tidying up unused ones work the same. LIVE is the mask being edited in the
  // Edit photo window, before Done saves it.
  const LIVE = '__live';
  let liveMask = null;
  function maskResolver(doc, onMissing) {
    return (id) => {
      if (id === LIVE) return liveMask;
      const m = Assets.get(id);
      if (m) return m.img;
      if (doc.assets[id]) {
        onMissing && onMissing();
        Assets.load(doc, id).then((x) => x && App.render());
      }
      return null;
    };
  }
  // An effect's name in lists: Texture shows which texture.
  const labelOf = (doc, e) => (e.type === 'texture' ? `Texture · ${Textures.nameOf(doc, e.p && e.p.tex)}` : PhotoFX.TYPES[e.type]?.name || e.type);
  // Grain is the same every time for a frame, but differs between frames.
  const seedOf = (it) => [...String(it.id || 'x')].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7) || 1;

  /* ---------- drawing a photo frame onto a canvas (thumbnails, PNG/JPG, Preview book) ---------- */
  const BLEND = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', 'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity' };
  // ctx is already moved to the frame's top-left; k is pixels per mm.
  // override: { img, w, h } to draw instead of working the effects out (the Edit photo preview).
  function drawFrame(ctx, doc, it, k, override) {
    const a = it.asset && Assets.get(it.asset);
    const W = it.w * k, H = it.h * k;
    if (!a) {
      ctx.fillStyle = '#e8e6ef';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const v = override || view(doc, it, { scale: it.s * k * 1.25 });
    const fx = PhotoFX.frameEffects(it.effects);
    // The photo, cropped by the frame, faded at the edges if asked, on a canvas of its own.
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(W));
    c.height = Math.max(1, Math.ceil(H));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(v.img, it.ox * k, it.oy * k, v.w * it.s * k, v.h * it.s * k);
    if (fx.fade) fadeEdges(g, c.width, c.height, fx.fade.width * k);
    // Drop shadow, under the photo: the frame's shape, or the cut-out's when the background is
    // removed, moved and softened.
    if (fx.shadow) {
      const sh = fx.shadow, ang = (sh.angle * Math.PI) / 180;
      const rgb = Color.rgb(Model.resolveColor(doc, sh.colour) || { c: 0, m: 0, y: 0, k: 100 });
      ctx.save();
      const far = (W + H) * 4; // draw the shape far away, so only its shadow lands here
      ctx.shadowColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${sh.opacity / 100})`;
      ctx.shadowBlur = sh.softness * k;
      ctx.shadowOffsetX = Math.cos(ang) * sh.distance * k + far;
      ctx.shadowOffsetY = Math.sin(ang) * sh.distance * k;
      if (PhotoFX.hasAlpha(it.effects)) ctx.drawImage(c, -far, 0, W, H);
      else {
        ctx.fillStyle = '#000';
        ctx.fillRect(-far, 0, W, H);
      }
      ctx.restore();
    }
    ctx.save();
    if (fx.blend) ctx.globalCompositeOperation = BLEND[fx.blend] || 'source-over';
    ctx.drawImage(c, 0, 0, W, H);
    ctx.restore();
  }
  // Softens the canvas's edges to transparent over `f` pixels.
  function fadeEdges(g, w, h, f) {
    if (f <= 0) return;
    g.save();
    g.globalCompositeOperation = 'destination-out';
    const edge = (x0, y0, x1, y1, rx, ry, rw, rh) => {
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, 'rgba(0,0,0,1)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(rx, ry, rw, rh);
    };
    const F = Math.min(f, w / 2, h / 2);
    edge(0, 0, F, 0, 0, 0, F, h);
    edge(w, 0, w - F, 0, w - F, 0, F, h);
    edge(0, 0, 0, F, 0, 0, w, F);
    edge(0, h, 0, h - F, 0, h - F, w, F);
    g.restore();
  }

  /* ---------- the page in the editor (HTML) ---------- */
  // Styles for a photo frame's box on the page: blend mode, drop shadow and faded edges.
  function frameCss(doc, it, k) {
    const fx = PhotoFX.frameEffects(it.effects);
    const out = { mixBlendMode: '', filter: '', maskImage: '', webkitMaskImage: '', maskComposite: '', webkitMaskComposite: '' };
    if (fx.blend) out.mixBlendMode = fx.blend;
    if (fx.shadow) {
      const sh = fx.shadow, ang = (sh.angle * Math.PI) / 180;
      const rgb = Color.rgb(Model.resolveColor(doc, sh.colour) || { c: 0, m: 0, y: 0, k: 100 });
      out.filter = `drop-shadow(${(Math.cos(ang) * sh.distance * k).toFixed(1)}px ${(Math.sin(ang) * sh.distance * k).toFixed(1)}px ${((sh.softness * k) / 2).toFixed(1)}px rgba(${rgb[0]},${rgb[1]},${rgb[2]},${sh.opacity / 100}))`;
    }
    if (fx.fade) {
      const f = Math.min(fx.fade.width, it.w / 2, it.h / 2) * k;
      const m = `linear-gradient(to right, transparent, #000 ${f}px, #000 calc(100% - ${f}px), transparent), linear-gradient(to bottom, transparent, #000 ${f}px, #000 calc(100% - ${f}px), transparent)`;
      out.maskImage = out.webkitMaskImage = m;
      out.maskComposite = 'intersect';
      out.webkitMaskComposite = 'source-in';
    }
    return out;
  }

  /* ---------- the print PDF ---------- */
  // The PDF name for a blend mode (PDF/X-4 allows them).
  const PDF_BLEND = { multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten', 'color-dodge': 'ColorDodge', 'color-burn': 'ColorBurn', 'hard-light': 'HardLight', 'soft-light': 'SoftLight', difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity' };
  // Fades the edges of the part of a frame that's drawn into a canvas: [x0, y0] to [x1, y1] in mm
  // inside a frame w × h mm, at pw × ph pixels.
  function fadeCropped(g, pw, ph, it, x0, y0, x1, y1, fadeMm) {
    const img = g.getImageData(0, 0, pw, ph);
    const d = img.data;
    const f = Math.min(fadeMm, it.w / 2, it.h / 2);
    const sx = (x1 - x0) / pw, sy = (y1 - y0) / ph;
    const ramp = (dist) => (dist >= f ? 1 : Math.max(0, dist / f));
    for (let y = 0; y < ph; y++) {
      const my = y0 + (y + 0.5) * sy;
      const ay = ramp(Math.min(my, it.h - my));
      for (let x = 0; x < pw; x++) {
        const mx = x0 + (x + 0.5) * sx;
        const a = ramp(Math.min(mx, it.w - mx)) * ay;
        if (a < 1) d[(y * pw + x) * 4 + 3] *= a;
      }
    }
    g.putImageData(img, 0, 0);
  }
  // The photo as it shows in its frame (cropped, with its effects and faded edges), w × h mm at
  // pxPerMm: the shape a drop shadow takes when the background is removed.
  function shapeOf(doc, it, pxPerMm) {
    const a = it.asset && Assets.get(it.asset);
    if (!a) return null;
    const v = view(doc, it, { scale: it.s * pxPerMm });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(it.w * pxPerMm));
    c.height = Math.max(1, Math.round(it.h * pxPerMm));
    const g = c.getContext('2d');
    g.drawImage(v.img, it.ox * pxPerMm, it.oy * pxPerMm, v.w * it.s * pxPerMm, v.h * it.s * pxPerMm);
    const fx = PhotoFX.frameEffects(it.effects);
    if (fx.fade) fadeEdges(g, c.width, c.height, fx.fade.width * pxPerMm);
    return c;
  }
  // The soft shape of a drop shadow, as a greyscale mask, and where it goes (mm, frame space).
  // shape: the cut-out's picture (shapeOf) when the background is removed; the frame otherwise.
  function shadowMask(it, sh, ppi = 150, shape = null) {
    const pxmm = ppi / 25.4;
    const soft = sh.softness, ang = (sh.angle * Math.PI) / 180;
    const pad = soft * 1.5 + 0.5;
    const wmm = it.w + 2 * pad, hmm = it.h + 2 * pad;
    const pw = Math.max(2, Math.round(wmm * pxmm)), ph = Math.max(2, Math.round(hmm * pxmm));
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000';
    g.fillRect(0, 0, pw, ph);
    g.filter = soft > 0 ? `blur(${((soft * pxmm) / 2).toFixed(2)}px)` : 'none';
    if (shape) {
      // The cut-out's see-through-ness, in white, softened.
      const s = document.createElement('canvas');
      s.width = Math.max(1, Math.round(it.w * pxmm));
      s.height = Math.max(1, Math.round(it.h * pxmm));
      const sg = s.getContext('2d');
      sg.drawImage(shape, 0, 0, s.width, s.height);
      sg.globalCompositeOperation = 'source-in';
      sg.fillStyle = '#fff';
      sg.fillRect(0, 0, s.width, s.height);
      g.drawImage(s, pad * pxmm, pad * pxmm, it.w * pxmm, it.h * pxmm);
    } else {
      g.fillStyle = '#fff';
      g.fillRect(pad * pxmm, pad * pxmm, it.w * pxmm, it.h * pxmm);
    }
    const d = g.getImageData(0, 0, pw, ph).data;
    const grey = new Uint8Array(pw * ph);
    for (let i = 0; i < grey.length; i++) grey[i] = d[i * 4];
    return { grey, pw, ph, x: Math.cos(ang) * sh.distance - pad, y: Math.sin(ang) * sh.distance - pad, w: wmm, h: hmm };
  }

  /* ---------- the Edit photo window ---------- */
  // A frame can have one of each of these (the frame effects, and flip and rotate).
  const ONCE = new Set(['flip_rotate', 'fade_edges', 'blend_mode', 'drop_shadow', 'cutout']);
  const canEdit = (it) => !!it && it.type === 'image' && !!it.asset && !!Assets.get(it.asset);

  function open(it) {
    const doc = App.S.doc;
    if (!canEdit(it)) return;
    if (Text.active) Text.finish();
    const a = Assets.get(it.asset);
    let work = JSON.parse(JSON.stringify(it.effects || [])); // the effects being edited
    let selId = work.length ? work[work.length - 1].id : null;
    let before = false;

    // A smaller copy of the photo, so the preview keeps up with the sliders. Zoomed in, a sharper
    // copy takes its place (in steps, up to 3072 px across), so small details stay crisp.
    const PREV = 1000, SHARPEST = 3072;
    let ps = 0, src = null, pxPerMm = 0;
    function useCopy(scale) {
      const s = Math.min(1, scale, SHARPEST / Math.max(a.w, a.h));
      if (src && Math.abs(s - ps) < 1e-6) return false;
      ps = s;
      src = document.createElement('canvas');
      src.width = Math.max(1, Math.round(a.w * ps));
      src.height = Math.max(1, Math.round(a.h * ps));
      const sg = src.getContext('2d');
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(a.img, 0, 0, src.width, src.height);
      pxPerMm = (it.s ? 1 / it.s : 12) * ps; // preview pixels per mm on the page
      lastKey = '';
      return true;
    }
    const baseScale = Math.min(1, PREV / Math.max(a.w, a.h));
    let lastKey = '';
    useCopy(baseScale);
    const color = colourOf(doc);
    const seed = seedOf(it);
    const texture = Textures.resolver(doc, { onLoaded: () => ((lastKey = ''), repaint()) });
    const mask = maskResolver(doc);

    /* Remove background: the mask being edited (white keeps, black removes), at up to 2048 px,
       with its own undo steps. It's LIVE while the window is open; Done saves it as a picture. */
    const MK = Math.min(1, 2048 / Math.max(a.w, a.h));
    let mk = null; // canvas
    let mkRev = 0;
    const mkUndo = [];
    const cut = { tool: 'wand', mode: 'remove', tol: 25, size: 40, checks: true, busy: false, hover: null };
    function maskCanvas(e) {
      if (mk) return mk;
      mk = document.createElement('canvas');
      mk.width = Math.max(1, Math.round(a.w * MK));
      mk.height = Math.max(1, Math.round(a.h * MK));
      const g = mk.getContext('2d', { willReadFrequently: true });
      const saved = e && e.p.mask && e.p.mask !== LIVE && Assets.get(e.p.mask);
      if (saved) g.drawImage(saved.img, 0, 0, mk.width, mk.height);
      else (g.fillStyle = '#fff'), g.fillRect(0, 0, mk.width, mk.height);
      return mk;
    }
    // Before a change to the mask: keep a step to go back to, and use the live mask from now on.
    function maskStep(e) {
      const c = maskCanvas(e);
      mkUndo.push(c.getContext('2d').getImageData(0, 0, c.width, c.height));
      if (mkUndo.length > 12) mkUndo.shift();
      liveMask = c;
      e.p.mask = LIVE;
    }
    const maskChanged = () => (mkRev++, repaint(), syncCut());
    // The photo at the mask's size, for the wand to compare colours.
    let mkPx = null;
    function maskPixels() {
      if (mkPx) return mkPx;
      const c = document.createElement('canvas');
      c.width = mk.width;
      c.height = mk.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(a.img, 0, 0, c.width, c.height);
      return (mkPx = g.getImageData(0, 0, c.width, c.height).data);
    }

    const m = openModal({
      onClose: () => (liveMask = null),
      title: `Edit photo · ${doc.assets[it.asset]?.name || 'Photo'}`,
      wide: true,
      cls: 'edit-photo',
      body: `<div class="pe">
        <div class="pe-left">
          <div class="pe-stage"><canvas class="pe-canvas"></canvas></div>
          <div class="pe-under"><button class="btn btn-sm" data-pe="before" title="Hold to see the photo without its effects">Before / After</button>
            <div class="seg pe-zoom"><button data-zoom="out" title="Zoom out (Ctrl+−)">−</button><button data-zoom="fit" class="pe-zoom-pct" title="Fit the photo in view (Ctrl+0)">Fit</button><button data-zoom="in" title="Zoom in (Ctrl+=)">+</button></div>
            <span class="muted pe-note">Scroll to zoom. Hold Space and drag (or drag with the middle button) to move around.</span></div>
        </div>
        <div class="pe-right">
          <div class="pe-head"><h5>Effects</h5><div class="pe-head-btns"><button class="btn btn-sm btn-ghost" data-pe="copy" title="Copy these effects, to paste onto another photo (Ctrl+Alt+C)">Copy</button><button class="btn btn-sm btn-ghost" data-pe="paste" title="Paste effects you copied (Ctrl+Alt+V)">Paste</button><button class="btn btn-sm" data-pe="add">+ Add</button></div></div>
          <div class="pe-list"></div>
          <p class="hint pe-order">Top is applied last, like layers. Drag to reorder.</p>
          <div class="pe-settings"></div>
        </div>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" data-pe="cancel">Cancel</button><button class="btn btn-accent" data-pe="done">Done</button></div>`,
    });
    const el = m.el;
    const q = (s) => el.querySelector(s);
    const cv = q('.pe-canvas');

    /* ----- the preview ----- */
    let lastImg = null, raf = 0;
    function draft() {
      const d = { ...it, effects: before ? [] : work };
      // A turn of 90° changes the photo's shape: refit it in the frame, as Done will.
      const dmOld = dims(it, a), dmNew = dims(d, a);
      if (dmOld.w !== dmNew.w || dmOld.h !== dmNew.h) Render.fitImage(d, a, it.fit === 'fit' ? 'fit' : 'fill');
      return d;
    }
    /* Zoom: 1 is Fit; zv.x, zv.y are where the frame's top-left sits on the preview when zoomed
       (null: centred). Scroll to zoom where the pointer is; Space-drag or middle-drag to move. */
    const ZMAX = 16;
    const zv = { z: 1, x: null, y: null };
    function paint() {
      raf = 0;
      const d = draft();
      const stage = q('.pe-stage');
      const SW = Math.max(50, stage.clientWidth), SH = Math.max(50, stage.clientHeight);
      if (cv.width !== SW || cv.height !== SH) (cv.width = SW), (cv.height = SH);
      const pad = 20;
      const kFit = Math.min((SW - 2 * pad) / it.w, (SH - 2 * pad) / it.h);
      const k = kFit * zv.z;
      const W = it.w * k, H = it.h * k;
      if (zv.x == null || zv.z <= 1) (zv.x = (SW - W) / 2), (zv.y = (SH - H) / 2);
      // Never let the photo slide right out of view.
      zv.x = Math.min(SW - 40, Math.max(40 - W, zv.x));
      zv.y = Math.min(SH - 40, Math.max(40 - H, zv.y));
      const x0 = zv.x, y0 = zv.y;
      // Sharp enough for this zoom: one copy pixel to a screen pixel, in steps.
      const want = Math.max(baseScale, Math.pow(2, Math.ceil(Math.log2(Math.max(1e-6, k * (it.s || 1 / 12))))));
      useCopy(zv.z <= 1 ? baseScale : want);
      const g = cv.getContext('2d');
      g.fillStyle = '#101013';
      g.fillRect(0, 0, SW, SH);
      // The page under the photo (and a little round it), so blend modes and shadows show as printed.
      const pm = pad * zv.z;
      g.fillStyle = '#fff';
      g.fillRect(x0 - pm, y0 - pm, W + 2 * pm, H + 2 * pm);
      // Working on Remove background: show what's removed as checks, if asked.
      const cutting = cutSel();
      if (cutting && cut.checks && !before) {
        g.fillStyle = checks(g);
        g.fillRect(x0, y0, W, H);
      }
      const key = JSON.stringify(PhotoFX.active(d.effects).filter((e) => !PhotoFX.TYPES[e.type].frame)) + '|' + mkRev + '|' + ps;
      if (key !== lastKey) {
        lastImg = PhotoFX.render(src, d.effects, { scale: 1, pxPerMm, color, seed, texture, mask });
        lastKey = key;
      }
      const dm = dims(d, a);
      g.save();
      g.translate(x0, y0);
      if (zv.z <= 1.5) drawFrame(g, doc, d, k, { img: lastImg, w: dm.w, h: dm.h });
      else {
        // Zoomed in: just the photo in its frame, drawn straight (the frame's shadow, fade and
        // blend show again at Fit), so it stays quick however close you are.
        g.beginPath();
        g.rect(0, 0, W, H);
        g.clip();
        g.imageSmoothingQuality = zv.z > 6 ? 'low' : 'high';
        g.drawImage(lastImg, d.ox * k, d.oy * k, dm.w * d.s * k, dm.h * d.s * k);
      }
      g.restore();
      view_ = { k, x0, y0, d, dm };
      cv._view = view_; // for the checks in test/
      syncZoom();
      // The brush's size, where the pointer is.
      if (cutting && cut.tool === 'brush' && cut.hover) {
        const r = (cut.size / 2) * (cv.width / cv.getBoundingClientRect().width);
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(cut.hover[0], cut.hover[1], r, 0, Math.PI * 2);
        g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = 1;
        g.stroke();
      }
    }
    let view_ = null; // where the photo was last drawn on the preview
    let checkPat = null;
    function checks(g) {
      if (checkPat) return checkPat;
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const cg = c.getContext('2d');
      cg.fillStyle = '#fff';
      cg.fillRect(0, 0, 16, 16);
      cg.fillStyle = '#d9d6e0';
      cg.fillRect(0, 0, 8, 8);
      cg.fillRect(8, 8, 8, 8);
      return (checkPat = g.createPattern(c, 'repeat'));
    }
    const repaint = () => raf || (raf = requestAnimationFrame(paint));

    // Zooming: the wheel (where the pointer is), the zoom bar and Ctrl+= / Ctrl+− / Ctrl+0.
    function zoomTo(z, at) {
      const nz = Math.min(ZMAX, Math.max(1, z));
      if (!view_ || nz === zv.z) return;
      const r = cv.getBoundingClientRect();
      const px = at ? ((at.clientX - r.left) * cv.width) / r.width : cv.width / 2;
      const py = at ? ((at.clientY - r.top) * cv.height) / r.height : cv.height / 2;
      // The spot under the pointer stays under it.
      const mx = (px - view_.x0) / view_.k, my = (py - view_.y0) / view_.k;
      const k2 = (view_.k / zv.z) * nz;
      zv.z = nz;
      zv.x = px - mx * k2;
      zv.y = py - my * k2;
      repaint();
    }
    function syncZoom() {
      const p = q('.pe-zoom-pct');
      if (p) p.textContent = zv.z <= 1 ? 'Fit' : Math.round(zv.z * 100) + '%';
      const n = q('.pe-note');
      if (n) n.textContent = zv.z > 1.5 ? "Zoomed in: the frame's shadow, fade and blend show again at Fit." : 'Scroll to zoom. Hold Space and drag (or drag with the middle button) to move around.';
      const st = q('.pe-stage');
      if (st) st.classList.toggle('pe-panning', !!panning || spaceHeld);
    }
    q('.pe-stage').addEventListener('wheel', (ev) => {
      ev.preventDefault();
      zoomTo(zv.z * Math.pow(1.0015, -ev.deltaY), ev);
    }, { passive: false });
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-zoom]');
      if (!b) return;
      if (b.dataset.zoom === 'in') zoomTo(zv.z * 1.5);
      else if (b.dataset.zoom === 'out') zoomTo(zv.z / 1.5);
      else zoomTo(1);
    });
    // Moving around: Space held (or the middle button) and drag.
    let spaceHeld = false, panning = null;
    const typingIn = (t) => t && t.matches && t.matches('input[type="text"], input[type="number"], textarea, select');
    el.addEventListener('keydown', (ev) => {
      if (ev.code === 'Space' && !typingIn(ev.target)) {
        ev.preventDefault(); // not a click on whichever button has focus
        if (!spaceHeld) (spaceHeld = true), syncZoom();
      }
      if (ev.ctrlKey && !ev.altKey && !typingIn(ev.target)) {
        if (ev.key === '=' || ev.key === '+') ev.preventDefault(), zoomTo(zv.z * 1.5);
        if (ev.key === '-') ev.preventDefault(), zoomTo(zv.z / 1.5);
        if (ev.key === '0') ev.preventDefault(), zoomTo(1);
      }
    });
    el.addEventListener('keyup', (ev) => ev.code === 'Space' && ((spaceHeld = false), syncZoom()));
    cv.addEventListener('pointerdown', (ev) => {
      if (!(ev.button === 1 || (ev.button === 0 && spaceHeld)) || zv.z <= 1) return;
      ev.preventDefault();
      ev.stopImmediatePropagation(); // not a brush stroke or wand click
      panning = { x: ev.clientX, y: ev.clientY, zx: zv.x, zy: zv.y };
      cv.setPointerCapture(ev.pointerId);
      syncZoom();
    });
    cv.addEventListener('pointermove', (ev) => {
      if (!panning) return;
      const r = cv.getBoundingClientRect();
      zv.x = panning.zx + ((ev.clientX - panning.x) * cv.width) / r.width;
      zv.y = panning.zy + ((ev.clientY - panning.y) * cv.height) / r.height;
      repaint();
    });
    const endPan = () => panning && ((panning = null), syncZoom());
    cv.addEventListener('pointerup', endPan);
    cv.addEventListener('pointercancel', endPan);
    new ResizeObserver(() => repaint()).observe(q('.pe-stage'));

    /* ----- the list of effects ----- */
    const T = PhotoFX.TYPES;
    function renderList() {
      const rows = [...work].reverse(); // top of the list is applied last
      q('.pe-list').innerHTML = rows.length
        ? rows.map((e) => `<div class="pe-row${e.id === selId ? ' on' : ''}${e.on ? '' : ' off'}" data-fx="${e.id}" draggable="true">
            <button class="pe-eye" data-pe="eye" title="${e.on ? 'Hide this effect' : 'Show this effect'}">${e.on ? '◉' : '◌'}</button>
            <span class="pe-name">${esc(labelOf(doc, e))}</span>
            <button class="pe-x" data-pe="remove" title="Remove this effect">✕</button><span class="pe-grip" title="Drag to reorder">≡</span></div>`).join('')
        : '<p class="hint">No effects yet. Use + Add to put one on.</p>';
      renderSettings();
    }
    function renderSettings() {
      const e = work.find((x) => x.id === selId);
      const box = q('.pe-settings');
      if (!e) return (box.innerHTML = '');
      const t = T[e.type];
      const all = { ...Object.fromEntries(t.params.map((q) => [q.k, q.def])), ...e.p };
      const fields = t.params.filter((p) => !p.when || p.when(all)).map((p) => control(e, p)).join('');
      const strength = t.frame || t.geometric ? '' : control(e, { k: '__strength', label: 'Strength', type: 'range', min: 0, max: 100, step: 1, unit: '%' });
      box.innerHTML = `<div class="pe-set-head"><h5>${esc(t.name)}</h5><button class="btn btn-sm btn-ghost" data-pe="reset" title="Put this effect's settings back to how they started">Reset</button></div>
        ${t.histogram && e.type !== 'curves' ? '<canvas class="pe-hist" width="256" height="70"></canvas>' : ''}
        ${fields}${strength}
        ${t.geometric ? '<p class="hint">Flip and rotate always happens first, before the other effects.</p>' : ''}
        ${t.frame ? '<p class="hint">Works on the frame on the page, so it shows on what\'s behind the photo too.</p>' : ''}`;
      if (t.histogram || e.type === 'curves') drawHistogram(e);
      const curve = box.querySelector('.pe-curve');
      if (curve) bindCurve(curve, e);
      syncCut();
      const tx = box.querySelector('.pe-texture');
      if (tx)
        Textures.picker(tx, doc, e.p.tex, (ref, c) => {
          e.p.tex = ref;
          // Drawn textures come with a size that suits them; one that doesn't tile gets mirrored.
          if (c.kind === 'preset' && c.mm) e.p.size = c.mm;
          e.p.mirror = !c.tiles;
          renderList();
          repaint();
        });
    }
    const valOf = (e, k) => (k === '__strength' ? e.strength : e.p[k]);
    function control(e, p) {
      const v = valOf(e, p.k);
      if (p.type === 'range')
        return `<label class="pe-field"><span>${esc(p.label)}</span><input type="range" min="${p.min}" max="${p.max}" step="${p.step || 1}" value="${v}" data-k="${p.k}"><output>${fmt(v, p)}</output></label>`;
      if (p.type === 'select')
        return `<label class="pe-field"><span>${esc(p.label)}</span><select class="input" data-k="${p.k}">${p.options.map(([o, l]) => `<option value="${o}" ${String(v) === String(o) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
      if (p.type === 'toggle') return `<label class="switch pe-toggle"><input type="checkbox" data-k="${p.k}" ${v ? 'checked' : ''}><span>${esc(p.label)}</span></label>`;
      if (p.type === 'colour') {
        const c = Model.resolveColor(doc, v);
        return `<div class="pe-field"><span>${esc(p.label)}</span><button class="btn btn-sm pe-colour" data-colour="${p.k}"><i style="background:${Color.css(c)}"></i>${esc(Model.colorName ? Model.colorName(doc, v) : '')}</button></div>`;
      }
      if (p.type === 'texture') return '<div class="pe-texture"></div>';
      if (p.type === 'shuffle') return `<div class="pe-field"><span>${esc(p.label)}</span><button class="btn btn-sm pe-shuffle" data-shuffle="${p.k}" title="A fresh variation of this texture">Shuffle ↻</button></div>`;
      if (p.type === 'curve') return `<div class="pe-curve-box"><canvas class="pe-curve" width="256" height="256" data-k="${p.k}"></canvas><p class="hint">Drag the points. Click the line to add a point; drag a point off the box to remove it.</p></div>`;
      if (p.type === 'mask') return cutHtml();
      return '';
    }

    /* ----- Remove background: find the subject, then touch up with the wand and brush ----- */
    const cutSel = () => {
      const e = work.find((x) => x.id === selId);
      return e && e.type === 'cutout' && e.on ? e : null;
    };
    function cutHtml() {
      const seg = (name, opts, cur) => `<div class="seg" data-cut-seg="${name}">${opts.map(([v, l, t]) => `<button data-v="${v}" title="${esc(t || l)}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
      return `<div class="pe-cut">
        <div class="pe-cut-auto"><button class="btn btn-sm btn-accent" data-cut="auto" title="Finds the subject (people, pets, products) and removes the rest">Find the subject</button><span class="muted pe-cut-status"></span></div>
        <div class="pe-field"><span>Touch up</span>${seg('tool', [['wand', '✦ Wand', 'Click an area to remove or keep it, with the colours next to it that look alike'], ['brush', '● Brush', 'Paint over parts to remove or keep them'], ['look', 'Look', 'Just look: clicking does nothing']], cut.tool)}</div>
        <div class="pe-field"><span>Click to</span>${seg('mode', [['remove', 'Remove'], ['keep', 'Keep']], cut.mode)}</div>
        ${cut.tool === 'wand' ? `<label class="pe-field"><span>Tolerance</span><input type="range" min="1" max="100" step="1" value="${cut.tol}" data-cut-range="tol"><output>${cut.tol}</output></label>` : ''}
        ${cut.tool === 'brush' ? `<label class="pe-field"><span>Brush size</span><input type="range" min="4" max="200" step="1" value="${cut.size}" data-cut-range="size"><output>${cut.size} px</output></label>` : ''}
        <label class="switch pe-toggle"><input type="checkbox" data-cut-checks ${cut.checks ? 'checked' : ''}><span>Show removed parts as checks</span></label>
        <div class="btn-row"><button class="btn btn-sm" data-cut="undo" title="Undo the last change to the mask (Ctrl+Z)">Undo</button><button class="btn btn-sm btn-ghost" data-cut="reset" title="Keep the whole photo again">Start again</button></div>
        <p class="hint">Hold Alt while you click or paint to do the opposite (Keep instead of Remove).</p>
      </div>`;
    }
    function syncCut() {
      const st = q('.pe-cut-status');
      const b = q('[data-cut="auto"]');
      if (b) b.disabled = cut.busy;
      const u = q('[data-cut="undo"]');
      if (u) u.disabled = !mkUndo.length;
      if (st && !cut.busy && !st.dataset.keep) st.textContent = '';
      cv.style.cursor = cutSel() && !before ? (cut.tool === 'wand' ? 'crosshair' : cut.tool === 'brush' ? 'none' : '') : '';
    }
    // Find the subject: the model runs in a helper process (main.js, src/bgworker.js).
    let firstAuto = true;
    async function autoCut(e) {
      if (cut.busy) return;
      cut.busy = true;
      const st = q('.pe-cut-status');
      const say = (s, keep) => {
        const x = q('.pe-cut-status');
        if (x) (x.textContent = s), keep ? (x.dataset.keep = '1') : delete x.dataset.keep;
      };
      say(firstAuto ? 'Finding the subject… the first one takes a little longer.' : 'Finding the subject…', true);
      syncCut();
      try {
        const N = 1024;
        const c = document.createElement('canvas');
        c.width = c.height = N;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.drawImage(a.img, 0, 0, N, N);
        const rgba = g.getImageData(0, 0, N, N).data;
        const t0 = performance.now();
        const r = await ep.bg.remove(new Uint8Array(rgba.buffer));
        if (!work.includes(e)) return; // the effect went while it worked
        // The answer, 1024 × 1024, stretched back to the photo's shape.
        const mc = document.createElement('canvas');
        mc.width = mc.height = N;
        const mg = mc.getContext('2d');
        const img = mg.createImageData(N, N);
        for (let i = 0, j = 0; i < r.mask.length; i++, j += 4) img.data[j] = img.data[j + 1] = img.data[j + 2] = r.mask[i], (img.data[j + 3] = 255);
        mg.putImageData(img, 0, 0);
        maskStep(e);
        const kg = mk.getContext('2d');
        kg.imageSmoothingQuality = 'high';
        kg.drawImage(mc, 0, 0, mk.width, mk.height);
        firstAuto = false;
        cut.busy = false;
        say(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s. Touch up any edges with the wand or brush.`, true);
        maskChanged();
      } catch (err) {
        cut.busy = false;
        say(`Couldn't find the subject: ${String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, true);
        syncCut();
      }
    }
    // Where a point on the preview is on the mask (or null, outside the photo).
    function toMask(ev) {
      if (!view_ || !mk) return null;
      const r = cv.getBoundingClientRect();
      const cx = ((ev.clientX - r.left) * cv.width) / r.width, cy = ((ev.clientY - r.top) * cv.height) / r.height;
      const { k, x0, y0, d, dm } = view_;
      // Preview → frame (mm) → the photo as turned (its own pixels) → the photo as it came.
      const X = ((cx - x0) / k - d.ox) / d.s, Y = ((cy - y0) / k - d.oy) / d.s;
      const geo = PhotoFX.geometry(d.effects);
      const th = (-geo.rotate * Math.PI) / 180;
      let u = X - dm.w / 2, v = Y - dm.h / 2;
      [u, v] = [u * Math.cos(th) - v * Math.sin(th), u * Math.sin(th) + v * Math.cos(th)];
      if (geo.flipH) u = -u;
      if (geo.flipV) v = -v;
      const sx = (u + a.w / 2) * MK, sy = (v + a.h / 2) * MK;
      return { x: sx, y: sy, inside: sx >= 0 && sy >= 0 && sx < mk.width && sy < mk.height, perPx: ((r.width / cv.width) * k * d.s) / MK };
    }
    // The wand: the area of similar colour around a point, made removed or kept.
    function wand(e, pt, keep) {
      const W = mk.width, H = mk.height;
      const x0 = Math.floor(pt.x), y0 = Math.floor(pt.y);
      if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return;
      maskStep(e);
      const px = maskPixels();
      const g = mk.getContext('2d', { willReadFrequently: true });
      const md = g.getImageData(0, 0, W, H);
      const i0 = (y0 * W + x0) * 4;
      const r0 = px[i0], g0 = px[i0 + 1], b0 = px[i0 + 2];
      const lim = cut.tol * 2.2;
      const seen = new Uint8Array(W * H);
      const stack = [y0 * W + x0];
      seen[stack[0]] = 1;
      const v = keep ? 255 : 0;
      while (stack.length) {
        const p = stack.pop();
        const i = p * 4;
        md.data[i] = md.data[i + 1] = md.data[i + 2] = v;
        const x = p % W, y = (p - x) / W;
        const look = (q2) => {
          if (seen[q2]) return;
          seen[q2] = 1;
          const j = q2 * 4;
          if (Math.max(Math.abs(px[j] - r0), Math.abs(px[j + 1] - g0), Math.abs(px[j + 2] - b0)) <= lim) stack.push(q2);
        };
        if (x > 0) look(p - 1);
        if (x < W - 1) look(p + 1);
        if (y > 0) look(p - W);
        if (y < H - 1) look(p + W);
      }
      g.putImageData(md, 0, 0);
      maskChanged();
    }
    // The brush: paints removed or kept along the pointer's path.
    let stroke = null;
    function paintTo(pt, keep) {
      const g = mk.getContext('2d');
      const rad = Math.max(0.5, cut.size / 2 / pt.perPx);
      g.fillStyle = g.strokeStyle = keep ? '#fff' : '#000';
      g.lineCap = g.lineJoin = 'round';
      g.lineWidth = rad * 2;
      g.beginPath();
      if (stroke && stroke.last) {
        g.moveTo(stroke.last.x, stroke.last.y);
        g.lineTo(pt.x, pt.y);
        g.stroke();
      } else {
        g.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
        g.fill();
      }
      if (stroke) stroke.last = pt;
      maskChanged();
    }
    cv.addEventListener('pointerdown', (ev) => {
      const e = cutSel();
      if (!e || before || cut.tool === 'look' || ev.button !== 0 || spaceHeld) return;
      maskCanvas(e);
      const pt = toMask(ev);
      if (!pt || !pt.inside) return;
      const keep = (cut.mode === 'keep') !== ev.altKey;
      if (cut.tool === 'wand') return wand(e, pt, keep);
      maskStep(e);
      stroke = { keep, last: null };
      cv.setPointerCapture(ev.pointerId);
      paintTo(pt, keep);
    });
    cv.addEventListener('pointermove', (ev) => {
      if (cutSel() && cut.tool === 'brush') {
        const r = cv.getBoundingClientRect();
        cut.hover = [((ev.clientX - r.left) * cv.width) / r.width, ((ev.clientY - r.top) * cv.height) / r.height];
        if (!stroke) repaint();
      }
      if (!stroke) return;
      const pt = toMask(ev);
      if (pt) paintTo(pt, stroke.keep);
    });
    const endStroke = () => (stroke = null);
    cv.addEventListener('pointerup', endStroke);
    cv.addEventListener('pointercancel', endStroke);
    cv.addEventListener('pointerleave', () => cut.hover && ((cut.hover = null), repaint()));
    function cutUndo(e) {
      if (!mkUndo.length) return;
      const g = maskCanvas(e).getContext('2d');
      g.putImageData(mkUndo.pop(), 0, 0);
      liveMask = mk;
      e.p.mask = LIVE;
      maskChanged();
    }
    function cutReset(e) {
      maskStep(e);
      const g = mk.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, mk.width, mk.height);
      maskChanged();
    }
    el.addEventListener('click', (ev) => {
      const e = cutSel();
      if (!e) return;
      const sb = ev.target.closest('[data-cut-seg] [data-v]');
      if (sb) {
        cut[sb.closest('[data-cut-seg]').dataset.cutSeg] = sb.dataset.v;
        renderSettings();
        syncCut();
        return repaint();
      }
      const b = ev.target.closest('[data-cut]');
      if (!b) return;
      if (b.dataset.cut === 'auto') autoCut(e);
      if (b.dataset.cut === 'undo') cutUndo(e);
      if (b.dataset.cut === 'reset') cutReset(e);
    });
    el.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t.dataset.cutRange) {
        cut[t.dataset.cutRange] = Number(t.value);
        const out = t.parentElement.querySelector('output');
        if (out) out.textContent = t.dataset.cutRange === 'size' ? `${t.value} px` : t.value;
      }
      if (t.matches('[data-cut-checks]')) (cut.checks = t.checked), repaint();
    });
    el.addEventListener('keydown', (ev) => {
      const e = cutSel();
      if (e && ev.ctrlKey && !ev.altKey && ev.key.toLowerCase() === 'z' && !ev.target.matches('input[type="text"], textarea')) {
        ev.preventDefault();
        ev.stopPropagation();
        cutUndo(e);
      }
    });
    const fmt = (v, p) => `${Number(Number(v).toFixed(p.step && p.step < 1 ? 2 : 0))}${p.unit || ''}`;
    // The photo's tones just before this effect, behind Levels and Curves.
    function drawHistogram(e) {
      const c = q('.pe-hist') || q('.pe-curve');
      if (!c) return;
      const upTo = work.slice(0, work.indexOf(e));
      const img = PhotoFX.render(src, upTo, { scale: Math.min(1, 300 / Math.max(src.width, src.height)), pxPerMm, color, seed, texture, mask });
      const bins = PhotoFX.histogram(img);
      const max = Math.max(...bins.slice(2, 254)) || 1;
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = 'rgba(160,156,175,0.35)';
      for (let x = 0; x < 256; x++) {
        const hh = Math.min(1, bins[x] / max) * c.height;
        g.fillRect(x * (c.width / 256), c.height - hh, c.width / 256 + 0.5, hh);
      }
      if (c.classList.contains('pe-curve')) c._hist = g.getImageData(0, 0, c.width, c.height);
    }
    // The Curves box: points you drag, add and remove.
    function bindCurve(c, e) {
      const draw = () => {
        const g = c.getContext('2d');
        if (c._hist) g.putImageData(c._hist, 0, 0);
        else g.clearRect(0, 0, 256, 256);
        g.strokeStyle = 'rgba(255,255,255,0.08)';
        for (let i = 1; i < 4; i++) (g.beginPath(), g.moveTo(i * 64, 0), g.lineTo(i * 64, 256), g.moveTo(0, i * 64), g.lineTo(256, i * 64), g.stroke());
        const lut = PhotoFX.curveLut(e.p.points);
        g.strokeStyle = '#e4007c';
        g.lineWidth = 2;
        g.beginPath();
        for (let x = 0; x < 256; x++) g.lineTo(x, 255 - lut[x]);
        g.stroke();
        g.fillStyle = '#fff';
        for (const [x, y] of e.p.points) g.fillRect(x - 4, 255 - y - 4, 8, 8);
      };
      draw();
      let drag = -1;
      const at = (ev) => {
        const r = c.getBoundingClientRect();
        return [Math.round(((ev.clientX - r.left) / r.width) * 255), Math.round((1 - (ev.clientY - r.top) / r.height) * 255)];
      };
      c.addEventListener('pointerdown', (ev) => {
        const [x, y] = at(ev);
        drag = e.p.points.findIndex(([px, py]) => Math.abs(px - x) < 10 && Math.abs(py - y) < 10);
        if (drag < 0) {
          e.p.points.push([x, Math.max(0, Math.min(255, y))]);
          e.p.points.sort((p1, p2) => p1[0] - p2[0]);
          drag = e.p.points.findIndex(([px]) => px === x);
        }
        c.setPointerCapture(ev.pointerId);
        draw();
        repaint();
      });
      c.addEventListener('pointermove', (ev) => {
        if (drag < 0) return;
        let [x, y] = at(ev);
        const pts = e.p.points, last = pts.length - 1;
        const outside = y < -30 || y > 285 || x < -30 || x > 285;
        if (outside && drag > 0 && drag < last) return; // shown as removed on release
        // The end points stay at the edges; others stay between their neighbours.
        if (drag === 0) x = 0;
        else if (drag === last) x = 255;
        else x = Math.max(pts[drag - 1][0] + 1, Math.min(pts[drag + 1][0] - 1, x));
        pts[drag] = [x, Math.max(0, Math.min(255, y))];
        draw();
        repaint();
      });
      c.addEventListener('pointerup', (ev) => {
        const [x, y] = at(ev);
        const pts = e.p.points;
        if (drag > 0 && drag < pts.length - 1 && (y < -30 || y > 285 || x < -30 || x > 285)) pts.splice(drag, 1);
        drag = -1;
        draw();
        repaint();
      });
    }

    /* ----- adding, choosing, changing, reordering ----- */
    function addMenu(btn) {
      const r = btn.getBoundingClientRect();
      const pop = document.createElement('div');
      pop.className = 'pe-add';
      pop.innerHTML = PhotoFX.GROUPS.map((gname) => `<div class="pe-add-group"><h6>${esc(gname)}</h6>${Object.entries(T)
        .filter(([, t]) => t.group === gname)
        .map(([type, t]) => `<button data-add="${type}">${esc(t.name)}${ONCE.has(type) && work.some((e) => e.type === type) ? ' <em>(on)</em>' : ''}</button>`)
        .join('')}</div>`).join('');
      document.body.appendChild(pop);
      const pr = pop.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.right - pr.width, innerWidth - pr.width - 8)) + 'px';
      pop.style.top = Math.min(r.bottom + 4, innerHeight - pr.height - 8) + 'px';
      const close = () => (pop.remove(), document.removeEventListener('pointerdown', away, true));
      const away = (ev) => !pop.contains(ev.target) && close();
      setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
      pop.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-add]');
        if (!b) return;
        const type = b.dataset.add;
        const existing = ONCE.has(type) && work.find((e) => e.type === type);
        if (existing) selId = existing.id;
        else {
          const e = PhotoFX.make(type);
          work.push(e);
          selId = e.id;
          // Remove background gets straight on with finding the subject.
          if (type === 'cutout') setTimeout(() => autoCut(e), 0);
        }
        close();
        renderList();
        repaint();
      });
    }
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-pe]');
      const row = ev.target.closest('[data-fx]');
      const e = row && work.find((x) => x.id === row.dataset.fx);
      if (b) {
        const a2 = b.dataset.pe;
        if (a2 === 'add') return addMenu(b);
        if (a2 === 'copy') return copyWork();
        if (a2 === 'paste') return pasteWork();
        if (a2 === 'cancel') return m.close();
        if (a2 === 'done') return finish();
        if (a2 === 'eye' && e) return (e.on = !e.on), renderList(), repaint();
        if (a2 === 'remove' && e) {
          work = work.filter((x) => x !== e);
          if (selId === e.id) selId = work.length ? work[work.length - 1].id : null;
          return renderList(), repaint();
        }
        if (a2 === 'reset') {
          const cur = work.find((x) => x.id === selId);
          if (cur) Object.assign(cur, { ...PhotoFX.make(cur.type), id: cur.id, on: cur.on });
          // Remove background starts again with nothing removed.
          if (cur && cur.type === 'cutout') (mk = null), (mkUndo.length = 0), mkRev++;
          return renderSettings(), repaint();
        }
      }
      const shuf = ev.target.closest('[data-shuffle]');
      if (shuf) {
        const cur = work.find((x) => x.id === selId);
        if (cur) cur.p[shuf.dataset.shuffle] = 1 + Math.floor(Math.random() * 99999);
        return repaint();
      }
      const cb = ev.target.closest('[data-colour]');
      if (cb) {
        const cur = work.find((x) => x.id === selId);
        return ColorPicker.open(cb, cur.p[cb.dataset.colour], false, (val) => {
          cur.p[cb.dataset.colour] = val;
          renderSettings();
          repaint();
        });
      }
      if (row && e && selId !== e.id) (selId = e.id), renderList();
    });
    const onField = (ev) => {
      const t = ev.target;
      const k = t.dataset.k;
      const e = work.find((x) => x.id === selId);
      if (!k || !e || t.classList.contains('pe-curve')) return;
      const p = T[e.type].params.find((x) => x.k === k);
      const v = t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value;
      if (k === '__strength') e.strength = v;
      else e.p[k] = v;
      const out = t.parentElement.querySelector('output');
      if (out) out.textContent = fmt(v, p || { unit: '%' });
      // Some settings show or hide others (Tile shows Size, Stretch shows Zoom, Tint shows its colour).
      if (ev.type === 'change' && t.type !== 'range' && T[e.type].params.some((x) => x.when)) renderSettings();
      repaint();
    };
    el.addEventListener('input', onField);
    el.addEventListener('change', onField);
    // Before / After: hold to see the photo as it was.
    const beforeBtn = q('[data-pe="before"]');
    beforeBtn.addEventListener('pointerdown', () => ((before = true), repaint()));
    for (const t of ['pointerup', 'pointerleave', 'pointercancel']) beforeBtn.addEventListener(t, () => before && ((before = false), repaint()));
    // Drag a row to reorder.
    let dragId = null;
    el.addEventListener('dragstart', (ev) => {
      const row = ev.target.closest('[data-fx]');
      if (row) (dragId = row.dataset.fx), ev.dataTransfer.setData('text/plain', dragId);
    });
    el.addEventListener('dragover', (ev) => ev.target.closest('[data-fx]') && ev.preventDefault());
    el.addEventListener('drop', (ev) => {
      const row = ev.target.closest('[data-fx]');
      if (!row || !dragId || row.dataset.fx === dragId) return;
      ev.preventDefault();
      // The list shows the last-applied effect at the top, so dropping on a row puts it just above.
      const moving = work.find((x) => x.id === dragId);
      work = work.filter((x) => x !== moving);
      const at = work.findIndex((x) => x.id === row.dataset.fx);
      const r = row.getBoundingClientRect();
      const above = ev.clientY < r.top + r.height / 2;
      work.splice(above ? at + 1 : at, 0, moving);
      dragId = null;
      renderList();
      repaint();
    });

    // Copy and paste inside the window work on the effects being edited; Done still saves them.
    function copyWork() {
      if (!work.length) return toast('Add an effect first, then copy.');
      if (!copyEffects(work)) return toast("A removed background can't be copied: each photo needs its own.");
      toast(`Copied ${countText(clip.effects.length)}${work.some((e) => e.type === 'cutout') ? ' (not the removed background: each photo needs its own)' : ''}.`);
      syncPaste();
    }
    async function pasteWork() {
      if (!clip) return toast('Copy effects from a photo first.');
      const mode = work.length ? await chooseMode(false) : 'replace';
      if (!mode) return;
      work = merged(work, fromClip(doc), mode);
      selId = work.length ? work[work.length - 1].id : null;
      renderList();
      repaint();
    }
    const syncPaste = () => (q('[data-pe="paste"]').disabled = !clip);
    // Ctrl+Alt+C and Ctrl+Alt+V while the window is open.
    el.addEventListener('keydown', (ev) => {
      if (!(ev.ctrlKey && ev.altKey) || ev.target.matches('input[type="number"], input[type="text"]')) return;
      const k = ev.key.toLowerCase();
      if (k === 'c') ev.preventDefault(), copyWork();
      if (k === 'v') ev.preventDefault(), pasteWork();
    });

    let finishing = false;
    async function finish() {
      if (finishing) return;
      finishing = true;
      // A mask changed here is saved as a picture of its own (kept with the design, like photos).
      for (const e of work) {
        if (e.type !== 'cutout' || e.p.mask !== LIVE || !mk) continue;
        const blob = await new Promise((r) => mk.toBlob(r, 'image/png'));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        e.p.mask = await Assets.add(doc, { name: `Mask · ${doc.assets[it.asset]?.name || 'photo'}`, mime: 'image/png', bytes });
      }
      const effects = JSON.parse(JSON.stringify(work));
      App.change('Edit photo', () => {
        const turnedBefore = dims(it, a);
        it.effects = effects;
        const turnedAfter = dims(it, a);
        // A turn of 90° changes the photo's shape, so fit it in its frame again.
        if (turnedBefore.w !== turnedAfter.w || turnedBefore.h !== turnedAfter.h) Render.fitImage(it, a, it.fit === 'fit' ? 'fit' : 'fill');
      }, { thumbs: 'all' });
      m.close();
    }

    renderList();
    syncPaste();
    requestAnimationFrame(paint);
  }

  /* ---------- copy and paste effects ---------- */
  // Kept for this session, so effects can go from one photo to the next, even in another design.
  let clip = null; // { effects, colours: swatch id -> its CMYK when copied }
  const photosIn = (items) => (items || []).filter(canEdit);
  const hasEffects = (it) => !!it && (it.effects || []).length > 0;
  const hasClip = () => !!clip;
  const countText = (n) => `${n} effect${n === 1 ? '' : 's'}`;
  function colourParams(e, fn) {
    for (const p of PhotoFX.TYPES[e.type]?.params || []) if (p.type === 'colour') fn(p.k);
  }
  // Copies a photo's effects (or a list of them, from the Edit photo window).
  function copyEffects(src) {
    const all = Array.isArray(src) ? src : src && src.effects;
    // A removed background belongs to its own photo (each needs its own cut-out), so it stays.
    const effects = (all || []).filter((e) => e.type !== 'cutout');
    if (!effects.length) return App.status(all && all.length ? "A removed background can't be copied: each photo needs its own." : 'This photo has no effects to copy yet.');
    const doc = App.S.doc;
    const colours = {};
    for (const e of effects)
      colourParams(e, (k) => {
        const v = e.p[k];
        if (v && v.sw) colours[v.sw] = Model.resolveColor(doc, v);
      });
    // Your own textures go too, so they can be pasted into another design.
    const textures = {};
    for (const id of Model.usedTextures(doc, [{ effects }])) if (doc.textures && doc.textures[id]) textures[id] = doc.textures[id];
    clip = { effects: JSON.parse(JSON.stringify(effects)), colours, textures };
    App.status(`Copied ${countText(effects.length)}. Select photos and choose Paste effects (Ctrl+Alt+V).`);
    App.render();
    return true;
  }
  // Fresh copies of the copied effects, using colours this design has.
  function fromClip(doc) {
    doc.textures = doc.textures || {};
    for (const [id, t] of Object.entries(clip.textures || {})) if (!doc.textures[id]) (doc.textures[id] = t), Textures.load(doc, id);
    return clip.effects.map((e) => {
      const c = JSON.parse(JSON.stringify(e));
      c.id = PhotoFX.make(e.type).id;
      colourParams(c, (k) => {
        const v = c.p[k];
        if (v && v.sw && !doc.swatches.some((s) => s.id === v.sw)) c.p[k] = JSON.parse(JSON.stringify(clip.colours[v.sw] || { c: 0, m: 0, y: 0, k: 100 }));
      });
      return c;
    });
  }
  // Replace, or add on top. A photo has one of each frame effect, so a pasted one takes its place.
  function merged(existing, pasted, mode) {
    if (mode === 'replace') return pasted;
    const once = new Set(pasted.filter((e) => ONCE.has(e.type)).map((e) => e.type));
    return [...(existing || []).filter((e) => !once.has(e.type)), ...pasted];
  }
  // Asks whether to replace a photo's own effects or add the copied ones on top.
  function chooseMode(several) {
    return new Promise((resolve) => {
      const n = clip.effects.length;
      const m = openModal({
        title: 'Paste effects',
        cls: 'pe-paste',
        body: `<p class="muted">${several ? 'Some of these photos already have effects.' : 'This photo already has effects.'} Replace them with the ${countText(n)} you copied, or add ${n === 1 ? 'it' : 'them'} on top?</p>
          <p class="hint">Ctrl+Z puts things back either way.</p>
          <div class="modal-actions"><button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn" data-a="add">Add on top</button><button class="btn btn-accent" data-a="replace" autofocus>Replace</button></div>`,
        onClose: (v) => resolve(v || null),
      });
      m.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (b) m.close(b.dataset.a === 'cancel' ? null : b.dataset.a);
      });
    });
  }
  // Pastes onto every selected photo; other selected things are left alone.
  async function pasteEffects(items) {
    const targets = photosIn(items);
    if (!clip) return App.status('Copy effects from a photo first (Ctrl+Alt+C).');
    if (!targets.length) return App.status('Select a photo to paste effects onto.');
    let mode = 'replace';
    if (targets.some(hasEffects)) mode = await chooseMode(targets.length > 1);
    if (!mode) return;
    const doc = App.S.doc;
    App.change('Paste effects', () => {
      for (const it of targets) {
        const a = Assets.get(it.asset);
        const was = dims(it, a);
        it.effects = merged(it.effects, fromClip(doc), mode);
        const now = dims(it, a);
        // A turn of 90° changes the photo's shape, so fit it in its frame again.
        if (was.w !== now.w || was.h !== now.h) Render.fitImage(it, a, it.fit === 'fit' ? 'fit' : 'fill');
      }
    }, { thumbs: 'all' });
    App.status(`Pasted ${countText(clip.effects.length)} onto ${targets.length === 1 ? 'the photo' : targets.length + ' photos'}.`);
  }
  // The buttons in Properties.
  const copyBtn = (it) =>
    `<button class="btn btn-sm" data-act="copy-effects" ${hasEffects(it) ? '' : 'disabled'} title="${hasEffects(it) ? "Copy this photo's effects (Ctrl+Alt+C)" : 'No effects to copy yet'}">Copy effects</button>`;
  const pasteBtn = (n) =>
    `<button class="btn btn-sm" data-act="paste-effects" ${clip ? '' : 'disabled'} title="${clip ? `Paste the ${countText(clip.effects.length)} you copied (Ctrl+Alt+V)` : 'Copy effects from a photo first (Ctrl+Alt+C)'}">Paste effects${n > 1 ? ` onto ${n}` : ''}</button>`;
  // Several things selected: paste onto all the photos among them.
  function multiHtml(items) {
    const n = photosIn(items).length;
    return n ? `<section><h5>Photos <span class="muted">· ${n}</span></h5><div class="btn-row">${pasteBtn(n)}</div></section>` : '';
  }

  // Shows or hides one effect from the photo's Properties.
  function toggle(it, id) {
    const e = (it.effects || []).find((x) => x.id === id);
    if (!e) return;
    App.change(e.on ? 'Hide effect' : 'Show effect', () => (e.on = !e.on), { thumbs: 'all' });
  }
  // The Effects list in a photo's Properties.
  function propsHtml(it) {
    const list = [...(it.effects || [])].reverse();
    return `<div class="pe-quick">${list.length ? list.map((e) => `<div class="pe-qrow${e.on ? '' : ' off'}"><button class="pe-eye" data-fx-toggle="${e.id}" title="${e.on ? 'Hide' : 'Show'} ${esc(PhotoFX.TYPES[e.type]?.name || '')}">${e.on ? '◉' : '◌'}</button><span>${esc(labelOf(App.S.doc, e))}</span></div>`).join('') : '<p class="hint">No effects yet.</p>'}</div>
      <div class="btn-row pe-btns"><button class="btn btn-sm" data-act="edit-photo" title="Edit photo (Ctrl+Shift+E)">Edit photo…</button>${copyBtn(it)}${pasteBtn(1)}</div>`;
  }

  return {
    view, dims, drawFrame, frameCss, PDF_BLEND, fadeCropped, shadowMask, shapeOf, fadeEdges, colourOf, seedOf, maskResolver,
    open, canEdit, toggle, propsHtml, multiHtml, copyEffects, pasteEffects, hasClip, hasEffects, photosIn,
  };
})();
