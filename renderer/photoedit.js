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
      const img = PhotoFX.render(a.img, it.effects, { scale: s, pxPerMm: it.s ? 1 / it.s : 12, color: colourOf(doc), seed: seedOf(it) });
      const d = dims(it, a);
      v = { img, w: d.w, h: d.h, get url() { return this._url || (this._url = img.toDataURL('image/jpeg', 0.92)); } };
      cache.set(key, v);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    } else {
      cache.delete(key);
      cache.set(key, v); // most recently used last
    }
    return v;
  }
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
    // Drop shadow: the frame's shape, moved and softened, under the photo.
    if (fx.shadow) {
      const sh = fx.shadow, ang = (sh.angle * Math.PI) / 180;
      const rgb = Color.rgb(Model.resolveColor(doc, sh.colour) || { c: 0, m: 0, y: 0, k: 100 });
      ctx.save();
      const far = (W + H) * 4; // draw the box far away, so only its shadow lands here
      ctx.shadowColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${sh.opacity / 100})`;
      ctx.shadowBlur = sh.softness * k;
      ctx.shadowOffsetX = Math.cos(ang) * sh.distance * k + far;
      ctx.shadowOffsetY = Math.sin(ang) * sh.distance * k;
      ctx.fillStyle = '#000';
      ctx.fillRect(-far, 0, W, H);
      ctx.restore();
    }
    // The photo, cropped by the frame, faded at the edges if asked, on a canvas of its own.
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(W));
    c.height = Math.max(1, Math.ceil(H));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(v.img, it.ox * k, it.oy * k, v.w * it.s * k, v.h * it.s * k);
    if (fx.fade) fadeEdges(g, c.width, c.height, fx.fade.width * k);
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
  // The soft shape of a drop shadow, as a greyscale mask, and where it goes (mm, frame space).
  function shadowMask(it, sh, ppi = 150) {
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
    g.fillStyle = '#fff';
    g.fillRect(pad * pxmm, pad * pxmm, it.w * pxmm, it.h * pxmm);
    const d = g.getImageData(0, 0, pw, ph).data;
    const grey = new Uint8Array(pw * ph);
    for (let i = 0; i < grey.length; i++) grey[i] = d[i * 4];
    return { grey, pw, ph, x: Math.cos(ang) * sh.distance - pad, y: Math.sin(ang) * sh.distance - pad, w: wmm, h: hmm };
  }

  /* ---------- the Edit photo window ---------- */
  // A frame can have one of each of these (the frame effects, and flip and rotate).
  const ONCE = new Set(['flip_rotate', 'fade_edges', 'blend_mode', 'drop_shadow']);
  const canEdit = (it) => !!it && it.type === 'image' && !!it.asset && !!Assets.get(it.asset);

  function open(it) {
    const doc = App.S.doc;
    if (!canEdit(it)) return;
    if (Text.active) Text.finish();
    const a = Assets.get(it.asset);
    let work = JSON.parse(JSON.stringify(it.effects || [])); // the effects being edited
    let selId = work.length ? work[work.length - 1].id : null;
    let before = false;

    // A smaller copy of the photo, so the preview keeps up with the sliders.
    const PREV = 1000;
    const ps = Math.min(1, PREV / Math.max(a.w, a.h));
    const src = document.createElement('canvas');
    src.width = Math.round(a.w * ps);
    src.height = Math.round(a.h * ps);
    src.getContext('2d').drawImage(a.img, 0, 0, src.width, src.height);
    const color = colourOf(doc);
    const seed = seedOf(it);
    const pxPerMm = (it.s ? 1 / it.s : 12) * ps; // preview pixels per mm on the page

    const m = openModal({
      title: `Edit photo · ${doc.assets[it.asset]?.name || 'Photo'}`,
      wide: true,
      cls: 'edit-photo',
      body: `<div class="pe">
        <div class="pe-left">
          <div class="pe-stage"><canvas class="pe-canvas"></canvas></div>
          <div class="pe-under"><button class="btn btn-sm" data-pe="before" title="Hold to see the photo without its effects">Before / After</button><span class="muted pe-note">Hold to compare with the photo as it was.</span></div>
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
    let lastKey = '', lastImg = null, raf = 0;
    function draft() {
      const d = { ...it, effects: before ? [] : work };
      // A turn of 90° changes the photo's shape: refit it in the frame, as Done will.
      const dmOld = dims(it, a), dmNew = dims(d, a);
      if (dmOld.w !== dmNew.w || dmOld.h !== dmNew.h) Render.fitImage(d, a, it.fit === 'fit' ? 'fit' : 'fill');
      return d;
    }
    function paint() {
      raf = 0;
      const d = draft();
      const stage = q('.pe-stage');
      const SW = stage.clientWidth - 40, SH = stage.clientHeight - 40;
      const k = Math.min(SW / it.w, SH / it.h);
      const pad = 20;
      cv.width = Math.round(it.w * k + 2 * pad);
      cv.height = Math.round(it.h * k + 2 * pad);
      const g = cv.getContext('2d');
      g.fillStyle = '#fff'; // the page under the photo, so blend modes and shadows show as printed
      g.fillRect(0, 0, cv.width, cv.height);
      const key = JSON.stringify(PhotoFX.active(d.effects).filter((e) => !PhotoFX.TYPES[e.type].frame));
      if (key !== lastKey) {
        lastImg = PhotoFX.render(src, d.effects, { scale: 1, pxPerMm, color, seed });
        lastKey = key;
      }
      const dm = dims(d, a);
      g.save();
      g.translate(pad, pad);
      drawFrame(g, doc, d, k, { img: lastImg, w: dm.w, h: dm.h });
      g.restore();
    }
    const repaint = () => raf || (raf = requestAnimationFrame(paint));

    /* ----- the list of effects ----- */
    const T = PhotoFX.TYPES;
    function renderList() {
      const rows = [...work].reverse(); // top of the list is applied last
      q('.pe-list').innerHTML = rows.length
        ? rows.map((e) => `<div class="pe-row${e.id === selId ? ' on' : ''}${e.on ? '' : ' off'}" data-fx="${e.id}" draggable="true">
            <button class="pe-eye" data-pe="eye" title="${e.on ? 'Hide this effect' : 'Show this effect'}">${e.on ? '◉' : '◌'}</button>
            <span class="pe-name">${esc(T[e.type].name)}</span>
            <button class="pe-x" data-pe="remove" title="Remove this effect">✕</button><span class="pe-grip" title="Drag to reorder">≡</span></div>`).join('')
        : '<p class="hint">No effects yet. Use + Add to put one on.</p>';
      renderSettings();
    }
    function renderSettings() {
      const e = work.find((x) => x.id === selId);
      const box = q('.pe-settings');
      if (!e) return (box.innerHTML = '');
      const t = T[e.type];
      const fields = t.params.map((p) => control(e, p)).join('');
      const strength = t.frame || t.geometric ? '' : control(e, { k: '__strength', label: 'Strength', type: 'range', min: 0, max: 100, step: 1, unit: '%' });
      box.innerHTML = `<div class="pe-set-head"><h5>${esc(t.name)}</h5><button class="btn btn-sm btn-ghost" data-pe="reset" title="Put this effect's settings back to how they started">Reset</button></div>
        ${t.histogram && e.type !== 'curves' ? '<canvas class="pe-hist" width="256" height="70"></canvas>' : ''}
        ${fields}${strength}
        ${t.geometric ? '<p class="hint">Flip and rotate always happens first, before the other effects.</p>' : ''}
        ${t.frame ? '<p class="hint">Works on the frame on the page, so it shows on what\'s behind the photo too.</p>' : ''}`;
      if (t.histogram || e.type === 'curves') drawHistogram(e);
      const curve = box.querySelector('.pe-curve');
      if (curve) bindCurve(curve, e);
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
      if (p.type === 'curve') return `<div class="pe-curve-box"><canvas class="pe-curve" width="256" height="256" data-k="${p.k}"></canvas><p class="hint">Drag the points. Click the line to add a point; drag a point off the box to remove it.</p></div>`;
      return '';
    }
    const fmt = (v, p) => `${Number(Number(v).toFixed(p.step && p.step < 1 ? 2 : 0))}${p.unit || ''}`;
    // The photo's tones just before this effect, behind Levels and Curves.
    function drawHistogram(e) {
      const c = q('.pe-hist') || q('.pe-curve');
      if (!c) return;
      const upTo = work.slice(0, work.indexOf(e));
      const img = PhotoFX.render(src, upTo, { scale: Math.min(1, 300 / Math.max(src.width, src.height)), pxPerMm, color, seed });
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
          return renderSettings(), repaint();
        }
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
      copyEffects(work);
      toast(`Copied ${countText(work.length)}.`);
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

    function finish() {
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
    const effects = Array.isArray(src) ? src : src && src.effects;
    if (!effects || !effects.length) return App.status('This photo has no effects to copy yet.');
    const doc = App.S.doc;
    const colours = {};
    for (const e of effects)
      colourParams(e, (k) => {
        const v = e.p[k];
        if (v && v.sw) colours[v.sw] = Model.resolveColor(doc, v);
      });
    clip = { effects: JSON.parse(JSON.stringify(effects)), colours };
    App.status(`Copied ${countText(effects.length)}. Select photos and choose Paste effects (Ctrl+Alt+V).`);
    App.render();
  }
  // Fresh copies of the copied effects, using colours this design has.
  function fromClip(doc) {
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
    return `<div class="pe-quick">${list.length ? list.map((e) => `<div class="pe-qrow${e.on ? '' : ' off'}"><button class="pe-eye" data-fx-toggle="${e.id}" title="${e.on ? 'Hide' : 'Show'} ${esc(PhotoFX.TYPES[e.type]?.name || '')}">${e.on ? '◉' : '◌'}</button><span>${esc(PhotoFX.TYPES[e.type]?.name || e.type)}</span></div>`).join('') : '<p class="hint">No effects yet.</p>'}</div>
      <div class="btn-row pe-btns"><button class="btn btn-sm" data-act="edit-photo" title="Edit photo (Ctrl+Shift+E)">Edit photo…</button>${copyBtn(it)}${pasteBtn(1)}</div>`;
  }

  return {
    view, dims, drawFrame, frameCss, PDF_BLEND, fadeCropped, shadowMask, fadeEdges, colourOf, seedOf,
    open, canEdit, toggle, propsHtml, multiHtml, copyEffects, pasteEffects, hasClip, hasEffects, photosIn,
  };
})();
