/* Effects on groups, text boxes and shapes (a photo's own effects are in renderer/photoedit.js).

   A group's effects belong to the group (doc.groups[id].effects): its boxes are merged into one
   shape first, so a drop shadow is one shadow and an outline goes round the outside of the lot,
   ignoring where boxes overlap. A text box or shape can have effects of its own (it.effects).

   Two kinds of effect:
     - shape effects (Drop shadow, Outline, Fade edges, Blend mode, Opacity): in print, the boxes
       stay as they are (text stays text) and the effect is added round them.
     - picture effects (Black and white, Blur, Texture…): in print, the thing becomes a picture,
       at 600 ppi when it has text in it. In Endpaper it always stays editable: you see the
       effect, and while you type in its text the effects pause.

   compose() works the effects out as pictures at any resolution (the page, thumbnails, PNG and
   the PDF all use it); entities() finds what has effects on a page; the Effects list in
   Properties is here too (panelHtml, bind). */
const ItemFX = (() => {
  const TYPES = () => PhotoFX.TYPES;
  // What can go on groups, text and shapes: everything but Flip and rotate and Remove background.
  const allowed = (type) => {
    const t = PhotoFX.TYPES[type];
    return !!t && !t.geometric && !t.first;
  };
  const isPicture = (e) => {
    const t = PhotoFX.TYPES[e.type];
    return !!t && !t.frame && !t.geometric && !t.first;
  };
  const pictureEffects = (effects) => PhotoFX.active(effects).filter((e) => allowed(e.type) && isPicture(e));
  const shapeEffects = (effects) => PhotoFX.frameEffects((effects || []).filter((e) => allowed(e.type)));
  const hasAny = (effects) => PhotoFX.active(effects).some((e) => allowed(e.type));

  /* ---------- what has effects ---------- */
  // The things with effects in a list of boxes, in their order: a group with effects (its boxes
  // sit together), or a text box or shape with effects of its own. photos: also a photo with an
  // Outline (on the page the outline is drawn here; elsewhere the photo draws its own).
  function entities(doc, list, { photos = false } = {}) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const g = it.group && doc.groups && doc.groups[it.group];
      if (g && hasAny(g.effects)) {
        const items = [];
        while (i < list.length && list[i].group === it.group) items.push(list[i++]);
        i--;
        out.push({ key: 'g:' + it.group, kind: 'group', gid: it.group, items, effects: g.effects, name: g.name });
        continue;
      }
      if (it.type !== 'image' && hasAny(it.effects)) out.push({ key: 'i:' + it.id, kind: 'item', items: [it], effects: it.effects, name: Model.itemLabel(it) });
      else if (photos && it.type === 'image' && PhotoFX.frameEffects(it.effects).outline) out.push({ key: 'p:' + it.id, kind: 'photo', items: [it], effects: (it.effects || []).filter((e) => e.type === 'outline'), name: Model.itemLabel(it) });
    }
    return out;
  }
  // Does it print its text as a picture? (Picture effects on something with text in it.)
  function rastersText(ent) {
    if (ent.kind === 'photo') return false;
    const text = ent.items.some((it) => it.type === 'text' && (it.text || '').trim() !== '' || (it.type === 'text' && it.next));
    return text && pictureEffects(ent.effects).length > 0;
  }
  const hasText = (ent) => ent.items.some((it) => it.type === 'text');

  // The box (mm) round some boxes, turned ones included.
  function bounds(items) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      const a = ((it.rot || 0) * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      const hw = (it.w * c + it.h * s) / 2, hh = (it.w * s + it.h * c) / 2;
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      x0 = Math.min(x0, cx - hw);
      x1 = Math.max(x1, cx + hw);
      y0 = Math.min(y0, cy - hh);
      y1 = Math.max(y1, cy + hh);
    }
    return { x0, y0, x1, y1 };
  }
  // Room (mm) round the shape for what spills past it: shadow, outline, blur.
  function marginFor(effects, fx) {
    let m = 0.5;
    if (fx.shadow) m = Math.max(m, fx.shadow.distance + fx.shadow.softness * 1.5 + 0.5);
    if (fx.outline) m = Math.max(m, PhotoFX.outlineReach(fx.outline) + 0.5);
    for (const e of pictureEffects(effects)) if (e.type === 'blur') m = Math.max(m, (e.p.radius || 1.5) * 3 + 0.5);
    return m;
  }

  /* ---------- working the effects out ---------- */
  // Finished effect pictures, kept to about 200 MB (renderer/util.js memCache). Ones worked out at
  // print size for an export are too big to keep, so they go once the export's done.
  const cache = memCache(200e6);
  const MAX_PX = 24e6; // the biggest picture worked out at once (it gets less sharp past this)
  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    return c;
  }
  // Draws one box, with its own effects if it has them (a text box with Blur inside a group with
  // a shadow, say).
  function drawItem(ctx, doc, it, k, pc) {
    if (it.type !== 'image' && hasAny(it.effects)) {
      const r = compose(doc, { key: 'i:' + it.id, kind: 'item', items: [it], effects: it.effects }, k, pc);
      if (r) drawResult(ctx, r, k);
    } else Render.drawItem(ctx, doc, it, k, pc);
  }
  // A key for a result: what's in it (placed relative to its own box, so moving it doesn't
  // need it worked out again), its effects, the colours, and the resolution.
  function keyOf(doc, ent, ppmm, pc, b) {
    const rel = ent.items.map((it) => {
      const o = { ...it, x: it.x - b.x0, y: it.y - b.y0 };
      if (it.type === 'text') o.__lines = Layout.box(doc, it, pc).lines.map((l) => l.text + '@' + l.x + ',' + l.y);
      if (it.type === 'image') o.__ready = !!Assets.get(it.asset);
      return o;
    });
    return JSON.stringify([ent.kind, rel, ent.effects, ppmm.toFixed(4), doc.swatches]);
  }
  /* The effects worked out at ppmm pixels per mm. Returns { x, y, w, h } (mm: where the pictures
     go), s (their pixels per mm), content (the boxes with picture effects and Fade edges), under
     (the shadow), over (the outline), opacity, blend, picture (it has picture effects) and
     screen (on the page it shows as a picture rather than as its own boxes). null if nothing
     shows. A photo's result has only its outline (the photo shows itself). */
  function compose(doc, ent, ppmm, pc) {
    const items = ent.items.filter((it) => !it.hidden);
    if (!items.length) return null;
    const fx = shapeEffects(ent.effects);
    const pics = pictureEffects(ent.effects);
    const b = bounds(items);
    const m = marginFor(ent.effects, fx);
    const Wmm = b.x1 - b.x0 + 2 * m, Hmm = b.y1 - b.y0 + 2 * m;
    let s = ppmm;
    if (Wmm * Hmm * s * s > MAX_PX) s = Math.sqrt(MAX_PX / (Wmm * Hmm));
    const key = keyOf(doc, ent, s, pc, b);
    const hit = cache.get(key);
    if (hit) {
      return { ...hit, x: b.x0 - m, y: b.y0 - m };
    }
    const W = Math.ceil(Wmm * s), H = Math.ceil(Hmm * s);
    let content = canvas(W, H);
    const g = content.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    if (ent.kind === 'photo') {
      // The photo's shape as it shows (crop, cut-out, faded edges), turned with its frame.
      const it = items[0];
      const shape = PhotoEdit.shapeOf(doc, it, s);
      if (shape) {
        g.save();
        g.translate((m + it.x + it.w / 2 - b.x0) * s, (m + it.y + it.h / 2 - b.y0) * s);
        if (it.rot) g.rotate((it.rot * Math.PI) / 180);
        g.drawImage(shape, (-it.w / 2) * s, (-it.h / 2) * s, it.w * s, it.h * s);
        g.restore();
      }
    } else {
      g.save();
      g.translate((m - b.x0) * s, (m - b.y0) * s);
      for (const it of items) (ent.kind === 'group' ? drawItem : Render.drawItem)(g, doc, it, s, pc);
      g.restore();
    }
    let missing = false;
    if (pics.length && ent.kind !== 'photo') {
      const texture = Textures.resolver(doc, { onMissing: () => (missing = true) });
      const seed = [...String(ent.key)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7) || 1;
      content = PhotoFX.render(content, pics, { scale: 1, pxPerMm: s, color: PhotoEdit.colourOf(doc), seed, texture });
    }
    if (fx.fade && ent.kind !== 'photo') {
      // Fade edges: the shape's own box fades away to its edges (and nothing spills past it).
      const cg = content.getContext('2d');
      cg.save();
      cg.translate(m * s, m * s);
      PhotoEdit.fadeEdges(cg, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s, fx.fade.width * s);
      cg.restore();
      cg.save();
      cg.globalCompositeOperation = 'destination-out';
      cg.fillStyle = '#000';
      const bx = m * s, by = m * s, bw = (b.x1 - b.x0) * s, bh = (b.y1 - b.y0) * s;
      cg.fillRect(0, 0, W, by);
      cg.fillRect(0, by + bh, W, H);
      cg.fillRect(0, 0, bx, H);
      cg.fillRect(bx + bw, 0, W, H);
      cg.restore();
    }
    const rgbOf = (ref) => Color.rgb(Model.resolveColor(doc, ref) || { c: 0, m: 0, y: 0, k: 100 });
    let under = null, over = null;
    if (fx.shadow && ent.kind !== 'photo') {
      // One shadow, from the whole shape.
      const sh = fx.shadow, ang = (sh.angle * Math.PI) / 180, rgb = rgbOf(sh.colour);
      under = canvas(W, H);
      const sl = PhotoEdit.shadowLayer(content, W, H, sh.softness * s, rgb, sh.opacity / 100);
      under.getContext('2d').drawImage(sl.canvas, Math.cos(ang) * sh.distance * s - sl.pad, Math.sin(ang) * sh.distance * s - sl.pad);
    }
    if (fx.outline) {
      // The line round the outside of the whole shape (overlaps inside don't count).
      const ol = PhotoEdit.outlineLayer(content, fx.outline, s, rgbOf(fx.outline.colour));
      over = canvas(W, H);
      over.getContext('2d').drawImage(ol.canvas, -ol.pad, -ol.pad);
    }
    const res = {
      w: Wmm,
      h: Hmm,
      s,
      content: ent.kind === 'photo' ? null : content,
      under,
      over,
      opacity: fx.opacity ?? 1,
      blend: fx.blend || null,
      fade: !!fx.fade,
      picture: pics.length > 0,
      // On the page: shown as one picture when it can't be its own boxes with a layer under
      // (shadow) and over (outline).
      screen: ent.kind !== 'photo' && (pics.length > 0 || !!fx.fade || (fx.opacity ?? 1) < 1 || !!fx.blend),
    };
    if (!missing) {
      cache.set(key, res, pixelBytes(res.content, res.under, res.over));
    }
    return { ...res, x: b.x0 - m, y: b.y0 - m };
  }
  // Draws a result onto a canvas at k pixels per mm (thumbnails, PNG and JPG, Preview book).
  function drawResult(ctx, r, k) {
    const X = r.x * k, Y = r.y * k, W = r.w * k, H = r.h * k;
    ctx.save();
    ctx.globalAlpha *= r.opacity;
    if (r.under) ctx.drawImage(r.under, X, Y, W, H);
    if (r.content) {
      ctx.save();
      if (r.blend) ctx.globalCompositeOperation = PhotoEdit.BLEND[r.blend] || 'source-over';
      ctx.drawImage(r.content, X, Y, W, H);
      ctx.restore();
    }
    if (r.over) ctx.drawImage(r.over, X, Y, W, H);
    ctx.restore();
  }
  // Draws something with effects onto a canvas.
  function draw(ctx, doc, ent, k, pc) {
    const r = compose(doc, ent, k, pc);
    if (r) drawResult(ctx, r, k);
  }

  /* ---------- on the page ---------- */
  // The elements that show it on the page at zoom k (dpr: screen pixels per CSS pixel).
  // { under, over, hide }: under goes before its boxes, over after them; hide: its own boxes are
  // made invisible (they stay there to click), because the picture shows instead.
  // claim(canvas): the page drawing's way of making sure a picture isn't already placed elsewhere
  // (two identical groups would share one); it hands back a copy if it is.
  function screenEls(doc, ent, k, dpr, pc, claim = (c) => c) {
    const r = compose(doc, ent, k * dpr, pc);
    if (!r) return null;
    const place = (c0, cls) => {
      const c = claim(c0);
      c.className = 'item-fx ' + cls;
      Object.assign(c.style, { left: r.x * k + 'px', top: r.y * k + 'px', width: r.w * k + 'px', height: r.h * k + 'px', mixBlendMode: '' });
      return c;
    };
    if (r.screen) {
      // One picture: shadow, the boxes with their effects, the outline.
      if (!r.flat) {
        const c = canvas(r.content.width, r.content.height);
        const g = c.getContext('2d');
        g.globalAlpha = r.opacity;
        if (r.under) g.drawImage(r.under, 0, 0);
        g.drawImage(r.content, 0, 0);
        if (r.over) g.drawImage(r.over, 0, 0);
        r.flat = c;
        const hit = cache.values().find((v) => v.content === r.content);
        if (hit) hit.flat = c;
      }
      const el = place(r.flat, 'fx-flat');
      el.style.mixBlendMode = r.blend || '';
      return { under: null, over: el, hide: true };
    }
    return { under: r.under ? place(r.under, 'fx-under') : null, over: r.over ? place(r.over, 'fx-over') : null, hide: false };
  }

  /* ---------- the Effects list in Properties ---------- */
  // owner: 'g:<group id>' or 'i:<box id>'.
  let openId = null; // the effect whose settings are showing
  function ownerOf(doc, owner) {
    if (!owner) return null;
    if (owner.startsWith('g:')) {
      const g = doc.groups && doc.groups[owner.slice(2)];
      return g ? { get: () => g.effects || [], set: (v) => (g.effects = v), items: Model.groupMembers(Model.surfaceItems(doc, App.S.surface), owner.slice(2)) } : null;
    }
    const it = Model.findItem(doc, owner.slice(2), App.S.surface)?.item;
    return it ? { get: () => it.effects || [], set: (v) => (it.effects = v), items: [it] } : null;
  }
  const fmt = (v, p) => `${Number(Number(v).toFixed(p.step && p.step < 1 ? 2 : 0))}${p.unit || ''}`;
  function control(doc, e, p) {
    const v = p.k === '__strength' ? e.strength : e.p[p.k] ?? p.def;
    const a = `data-ifx-k="${p.k}" data-ifx-id="${e.id}"`;
    if (p.type === 'range') return `<label class="pe-field"><span>${esc(p.label)}</span><input type="range" min="${p.min}" max="${p.max}" step="${p.step || 1}" value="${v}" ${a}><output>${fmt(v, p)}</output></label>`;
    if (p.type === 'select') return `<label class="pe-field"><span>${esc(p.label)}</span><select class="input" ${a}>${p.options.map(([o, l]) => `<option value="${o}" ${String(v) === String(o) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    if (p.type === 'toggle') return `<label class="switch pe-toggle"><input type="checkbox" ${a} ${v ? 'checked' : ''}><span>${esc(p.label)}</span></label>`;
    if (p.type === 'colour') {
      const c = Model.resolveColor(doc, v);
      return `<div class="pe-field"><span>${esc(p.label)}</span><button class="btn btn-sm pe-colour" data-ifx-colour="${p.k}" data-ifx-id="${e.id}"><i style="background:${Color.css(c)}"></i>${esc(Model.colorName(doc, v))}</button></div>`;
    }
    if (p.type === 'texture') return `<div class="pe-texture" data-ifx-texture="${e.id}"></div>`;
    if (p.type === 'shuffle') return `<div class="pe-field"><span>${esc(p.label)}</span><button class="btn btn-sm" data-ifx-shuffle="${p.k}" data-ifx-id="${e.id}">Shuffle ↻</button></div>`;
    if (p.type === 'curve') return `<div class="pe-curve-box"><canvas class="ifx-curve" width="256" height="256" data-ifx-curve="${e.id}"></canvas><p class="hint">Drag the points. Click the line to add one; drag one off the box to remove it.</p></div>`;
    return '';
  }
  function panelHtml(doc, owner) {
    const o = ownerOf(doc, owner);
    if (!o) return '';
    const list = o.get();
    const text = o.items.some((it) => it.type === 'text');
    const rows = [...list].reverse().map((e) => {
      const t = PhotoFX.TYPES[e.type];
      if (!t || !allowed(e.type)) return '';
      const open = e.id === openId;
      const warn = text && isPicture(e) && e.on;
      let settings = '';
      if (open) {
        const all = { ...Object.fromEntries(t.params.map((q) => [q.k, q.def])), ...e.p };
        settings = `<div class="ifx-settings">${t.params.filter((p) => !p.when || p.when(all)).filter((p) => !(e.type === 'blur' && p.k === 'edges')).map((p) => control(doc, e, p)).join('')}${t.frame ? '' : control(doc, e, { k: '__strength', label: 'Strength', type: 'range', min: 0, max: 100, step: 1, unit: '%' })}</div>`;
      }
      return `<div class="ifx-item${open ? ' open' : ''}"><div class="pe-qrow ifx-row${e.on ? '' : ' off'}" data-ifx-row="${e.id}"><button class="pe-eye" data-ifx-eye="${e.id}" title="${e.on ? 'Hide' : 'Show'} ${esc(t.name)}">${e.on ? '◉' : '◌'}</button><span>${esc(PhotoEdit.labelOf(doc, e))}</span><button class="pe-x" data-ifx-x="${e.id}" title="Remove this effect">✕</button></div>
        ${warn ? `<p class="fx-warn">Its text will print as a picture (600 ppi) because of ${esc(t.name)}. It stays editable here.</p>` : ''}${settings}</div>`;
    });
    return `<div class="ifx" data-ifx-owner="${esc(owner)}">${rows.join('') || '<p class="hint">No effects yet.</p>'}
      <div class="btn-row"><button class="btn btn-sm" data-ifx-add title="Add an effect">+ Add effect</button></div></div>`;
  }
  // The settings that need more than HTML (texture grids, curves), after the panel is drawn.
  function mount(host) {
    const box = host.querySelector('.ifx');
    if (!box) return;
    const doc = App.S.doc;
    const o = ownerOf(doc, box.dataset.ifxOwner);
    if (!o) return;
    for (const el of box.querySelectorAll('[data-ifx-texture]')) {
      const e = o.get().find((x) => x.id === el.dataset.ifxTexture);
      if (e)
        Textures.picker(el, doc, e.p.tex, (ref, c) =>
          App.change('Effect', () => {
            e.p.tex = ref;
            if (c.kind === 'preset' && c.mm) e.p.size = c.mm;
            e.p.mirror = !c.tiles;
          })
        );
    }
    for (const c of box.querySelectorAll('[data-ifx-curve]')) {
      const e = o.get().find((x) => x.id === c.dataset.ifxCurve);
      if (e) bindCurve(c, e);
    }
  }
  // The Curves box: drag points, click the line to add one, drag one off to remove it.
  function bindCurve(c, e) {
    const draw = () => {
      const g = c.getContext('2d');
      g.clearRect(0, 0, 256, 256);
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
    const live = () => (Layout.invalidate(), Editor.render());
    c.addEventListener('pointerdown', (ev) => {
      App.history.begin();
      const [x, y] = at(ev);
      drag = e.p.points.findIndex(([px, py]) => Math.abs(px - x) < 10 && Math.abs(py - y) < 10);
      if (drag < 0) {
        e.p.points.push([x, Math.max(0, Math.min(255, y))]);
        e.p.points.sort((p1, p2) => p1[0] - p2[0]);
        drag = e.p.points.findIndex(([px]) => px === x);
      }
      c.setPointerCapture(ev.pointerId);
      draw();
      live();
    });
    c.addEventListener('pointermove', (ev) => {
      if (drag < 0) return;
      let [x, y] = at(ev);
      const pts = e.p.points, last = pts.length - 1;
      if ((y < -30 || y > 285 || x < -30 || x > 285) && drag > 0 && drag < last) return;
      if (drag === 0) x = 0;
      else if (drag === last) x = 255;
      else x = Math.max(pts[drag - 1][0] + 1, Math.min(pts[drag + 1][0] - 1, x));
      pts[drag] = [x, Math.max(0, Math.min(255, y))];
      draw();
      live();
    });
    c.addEventListener('pointerup', (ev) => {
      const [x, y] = at(ev);
      const pts = e.p.points;
      if (drag > 0 && drag < pts.length - 1 && (y < -30 || y > 285 || x < -30 || x > 285)) pts.splice(drag, 1);
      drag = -1;
      App.history.commit('Effect', { thumbs: 'all' });
    });
  }
  // The + Add menu: the effects in their groups.
  function addMenu(btn, owner) {
    const doc = App.S.doc;
    const o = ownerOf(doc, owner);
    if (!o) return;
    document.querySelectorAll('.pe-add').forEach((x) => x.remove());
    const r = btn.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'pe-add';
    const have = o.get();
    pop.innerHTML = PhotoFX.GROUPS.map((gname) => {
      const list = Object.entries(PhotoFX.TYPES).filter(([type, t]) => t.group === gname && allowed(type));
      return list.length ? `<div class="pe-add-group"><h6>${esc(gname)}</h6>${list.map(([type, t]) => `<button data-add="${type}">${esc(t.name)}${PhotoEdit.ONCE.has(type) && have.some((e) => e.type === type) ? ' <em>(on)</em>' : ''}</button>`).join('')}</div>` : '';
    }).join('');
    document.body.appendChild(pop);
    const pr = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pr.width - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - pr.height - 8)) + 'px';
    const close = () => (pop.remove(), document.removeEventListener('pointerdown', away, true));
    const away = (ev) => !pop.contains(ev.target) && close();
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
    pop.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-add]');
      if (!b) return;
      close();
      const type = b.dataset.add;
      const existing = PhotoEdit.ONCE.has(type) && have.find((e) => e.type === type);
      let made = existing;
      App.change('Add effect', () => {
        if (existing) return;
        made = PhotoFX.make(type);
        o.set([...o.get(), made]);
      }, { thumbs: 'all' });
      openId = made && made.id;
      Panels.renderRight();
      // Text that'll print as a picture: say why, the first time.
      if (isPicture({ type }) && o.items.some((it) => it.type === 'text')) Hints.show('raster-text');
    });
  }
  // Clicks, typing and sliders in the Effects list (bound once on the right-hand panel).
  function bind(host) {
    const find = (el) => {
      const box = el.closest('[data-ifx-owner]');
      if (!box) return null;
      const doc = App.S.doc;
      const o = ownerOf(doc, box.dataset.ifxOwner);
      return o ? { o, owner: box.dataset.ifxOwner, doc } : null;
    };
    host.addEventListener('click', (ev) => {
      const t = ev.target;
      const f = find(t);
      if (!f) return;
      const { o, doc } = f;
      const byId = (id) => o.get().find((e) => e.id === id);
      const add = t.closest('[data-ifx-add]');
      if (add) return addMenu(add, f.owner);
      const eye = t.closest('[data-ifx-eye]');
      if (eye) {
        const e = byId(eye.dataset.ifxEye);
        return e && App.change(e.on ? 'Hide effect' : 'Show effect', () => (e.on = !e.on), { thumbs: 'all' });
      }
      const x = t.closest('[data-ifx-x]');
      if (x) return App.change('Remove effect', () => o.set(o.get().filter((e) => e.id !== x.dataset.ifxX)), { thumbs: 'all' });
      const col = t.closest('[data-ifx-colour]');
      if (col) {
        const e = byId(col.dataset.ifxId);
        return e && ColorPicker.open(col, e.p[col.dataset.ifxColour], false, (v) => App.change('Effect colour', () => (e.p[col.dataset.ifxColour] = v), { thumbs: 'all' }));
      }
      const sh = t.closest('[data-ifx-shuffle]');
      if (sh) {
        const e = byId(sh.dataset.ifxId);
        return e && App.change('Effect', () => (e.p[sh.dataset.ifxShuffle] = 1 + Math.floor(Math.random() * 99999)), { thumbs: 'all' });
      }
      const row = t.closest('[data-ifx-row]');
      if (row) {
        openId = openId === row.dataset.ifxRow ? null : row.dataset.ifxRow;
        return Panels.renderRight();
      }
    });
    // Sliders change the page as they move, and make one step to undo when let go.
    let raf = 0;
    host.addEventListener('input', (ev) => {
      const t = ev.target;
      if (!t.dataset || !t.dataset.ifxK || t.type !== 'range') return;
      const f = find(t);
      const e = f && f.o.get().find((x) => x.id === t.dataset.ifxId);
      if (!e) return;
      App.history.begin();
      const v = Number(t.value);
      if (t.dataset.ifxK === '__strength') e.strength = v;
      else e.p[t.dataset.ifxK] = v;
      const p = PhotoFX.TYPES[e.type].params.find((q) => q.k === t.dataset.ifxK) || { unit: '%' };
      const out = t.parentElement.querySelector('output');
      if (out) out.textContent = fmt(v, p);
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), Editor.render()));
    });
    host.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!t.dataset || !t.dataset.ifxK) return;
      const f = find(t);
      const e = f && f.o.get().find((x) => x.id === t.dataset.ifxId);
      if (!e) return;
      if (t.type === 'range') return App.history.commit('Effect', { thumbs: 'all' }) || App.render();
      const v = t.type === 'checkbox' ? t.checked : t.value;
      App.change('Effect', () => (e.p[t.dataset.ifxK] = v), { thumbs: 'all' });
    });
  }

  return { entities, compose, draw, drawItem, drawResult, screenEls, rastersText, hasText, pictureEffects, hasAny, allowed, isPicture, bounds, panelHtml, mount, bind };
})();
