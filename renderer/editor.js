/* The editing canvas: the spread you're on, with bleed, trim and margin guides; boxes you can
   drag, resize and rotate (with snapping); drawing new boxes; text editing; photo cropping. */
const Editor = (() => {
  const PAD = 120; // pasteboard around the spread, in px
  let stage, board, overlay;
  let geo = []; // pages of the current spread: { surface, ox, oy, w, h, bl:{l,t,r,b} }
  const els = new Map();
  const fxHidden = new Set(); // boxes shown as a picture with their effects instead (renderer/itemfx.js)
  let guidesShown = []; // snap lines while dragging
  let drag = null;
  let spaceDown = false;

  const S = () => App.S;
  const z = () => S().zoom;

  function init() {
    stage = $('#stage');
    board = $('#board');
    overlay = $('#overlay');
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('dblclick', onDbl);
    stage.addEventListener('contextmenu', onContext);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('pointermove', onHover);
    stage.addEventListener('dragover', (e) => e.preventDefault());
    stage.addEventListener('drop', onDrop);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping()) {
        spaceDown = true;
        stage.classList.add('panning');
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        spaceDown = false;
        stage.classList.remove('panning');
      }
    });
    new ResizeObserver(() => S().doc && layoutBoard()).observe(stage);
  }
  const isTyping = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;

  /* ---------- the spread ---------- */
  function spreadSurfaces(doc, s) {
    if (s.kind === 'cover') return [{ kind: 'cover', ...(Model.isInside(s) ? { side: 'inside' } : {}), ...(s.part ? { part: s.part } : {}) }];
    if (s.kind === 'master') return doc.facing ? [{ kind: 'master', id: s.id, side: 'left' }, { kind: 'master', id: s.id, side: 'right' }] : [{ kind: 'master', id: s.id, side: 'right' }];
    const sp = Model.spreads(doc).find((x) => x.includes(s.idx)) || [s.idx];
    return sp.map((idx) => ({ kind: 'page', idx }));
  }

  function computeGeo() {
    const { doc, surface } = S();
    const list = spreadSurfaces(doc, surface);
    const k = z();
    geo = [];
    const sz0 = Model.surfaceSize(doc, list[0]);
    const b = sz0.bleed;
    let x = PAD + b * k;
    // A right-hand page on its own sits to the right of the spine, like a printed book.
    if (doc.facing && list.length === 1 && Model.surfaceSide(doc, list[0]) === 'right') x += sz0.w * k;
    for (const s of list) {
      const sz = Model.surfaceSize(doc, s);
      const sd = Model.surfaceSide(doc, s);
      const bl = { l: sz.bleed, t: sz.bleed, r: sz.bleed, b: sz.bleed };
      if (doc.facing && list.length === 2 && sd === 'left') bl.r = 0;
      if (doc.facing && list.length === 2 && sd === 'right') bl.l = 0;
      // org: where this page's 0 sits on its item list (cover pages are windows onto the sheet).
      geo.push({ surface: s, ox: x, oy: PAD + sz.bleed * k, w: sz.w, h: sz.h, bl, side: sd, org: Model.surfaceOrigin(doc, s) });
      x += sz.w * k;
    }
    const totalW = (doc.facing && list[0].kind !== 'cover' ? sz0.w * 2 : geo.reduce((a, g) => a + g.w, 0)) + 2 * b;
    const maxH = Math.max(...geo.map((g) => g.h)) + 2 * b;
    return { width: totalW * k + PAD * 2, height: maxH * k + PAD * 2 };
  }

  function layoutBoard() {
    const { width, height } = computeGeo();
    // Centre the spread when it's smaller than the window.
    const sw = stage.clientWidth, sh = stage.clientHeight;
    board.style.width = Math.max(width, sw) + 'px';
    board.style.height = Math.max(height, sh) + 'px';
    const dx = Math.max(0, (sw - width) / 2), dy = Math.max(0, (sh - height) / 2);
    for (const g of geo) (g.ox += dx), (g.oy += dy);
    return { dx, dy };
  }

  function render() {
    const { doc } = S();
    if (!doc) return;
    layoutBoard();
    const k = z();
    const keep = new Set();
    const pagesHost = $('#pages-host', board);
    pagesHost.innerHTML = '';
    fxHidden.clear();
    const fed = new Set(); // boxes that text continues into aren't empty
    for (const s of Model.allSurfaces(doc)) for (const x of Model.surfaceItems(doc, s)) if (x.next) fed.add(x.next);
    for (const g of geo) {
      const pageEl = document.createElement('div');
      pageEl.className = 'page' + (Model.sameSurface(g.surface, S().surface) ? ' current' : '');
      Object.assign(pageEl.style, { left: g.ox - g.bl.l * k + 'px', top: g.oy - g.bl.t * k + 'px', width: (g.w + g.bl.l + g.bl.r) * k + 'px', height: (g.h + g.bl.t + g.bl.b) * k + 'px' });
      const inner = document.createElement('div');
      inner.className = 'page-origin';
      inner.style.left = (g.bl.l - g.org) * k + 'px';
      inner.style.top = g.bl.t * k + 'px';
      pageEl.appendChild(inner);
      const pc = Render.ctxFor(doc, g.surface);
      const shown = Render.itemsOf(doc, g.surface);
      // Groups, text and shapes with effects (renderer/itemfx.js): a shadow under their boxes, an
      // outline over them, or (picture effects) one picture over them with the boxes made
      // invisible but still there to click. While you type in one, its effects pause.
      const typing = S().editing && S().editing.id;
      const fxAt = new Map(); // box id -> { shared: { e, els }, first, last }
      for (const e of ItemFX.entities(doc, shown.map((x) => x.it), { photos: true })) {
        if (e.items.some((x) => x.id === typing)) continue;
        const shared = { e, els: null };
        e.items.forEach((x, i) => fxAt.set(x.id, { shared, first: i === 0, last: i === e.items.length - 1 }));
      }
      for (const { it, master } of shown) {
        const fx = fxAt.get(it.id);
        if (fx && fx.first) {
          fx.shared.els = ItemFX.screenEls(doc, fx.shared.e, k, devicePixelRatio || 1, pc);
          if (fx.shared.els && fx.shared.els.under) inner.appendChild(fx.shared.els.under);
        }
        const key = (master ? 'm:' + g.surface.idx + ':' : '') + it.id;
        let el = els.get(key);
        if (!el) {
          el = document.createElement('div');
          el.dataset.id = it.id;
          els.set(key, el);
        }
        // Empty text boxes (placeholders, often on a master) get a faint outline on screen only.
        const empty = it.type === 'text' && !(it.text || '').trim() && !fed.has(it.id);
        el.className = `item item-${it.type}${master ? ' from-master' : ''}${it.locked ? ' locked' : ''}${empty ? ' is-empty' : ''}`;
        el.dataset.master = master ? '1' : '';
        paint(el, it, pc, k);
        if (S().editing && S().editing.id === it.id && !master) el.style.visibility = 'hidden';
        if (fx && fx.shared.els && fx.shared.els.hide) (el.style.opacity = '0'), fxHidden.add(el);
        inner.appendChild(el);
        keep.add(key);
        if (fx && fx.last && fx.shared.els && fx.shared.els.over) inner.appendChild(fx.shared.els.over);
      }
      pagesHost.appendChild(pageEl);
    }
    for (const key of [...els.keys()]) if (!keep.has(key)) els.delete(key);
    renderOverlay();
  }

  // Draws one box into its element. Content is only rebuilt when it changes.
  function paint(el, it, pc, k) {
    const { doc } = S();
    Object.assign(el.style, {
      left: it.x * k + 'px',
      top: it.y * k + 'px',
      width: Math.max(0.5, it.w * k) + 'px',
      height: Math.max(0.5, it.h * k) + 'px',
      transform: it.rot ? `rotate(${it.rot}deg)` : '',
      opacity: it.opacity ?? 1,
      display: it.hidden ? 'none' : '',
      visibility: '',
    });
    let sig;
    let html;
    const W = it.w * k, H = it.h * k;
    if (it.type === 'image') {
      // The photo with its effects (renderer/photoedit.js), sharp enough for this zoom.
      const a = it.asset && PhotoEdit.view(doc, it, { scale: it.s * k * (devicePixelRatio || 1) });
      const st = Model.resolveColor(doc, it.stroke);
      Object.assign(el.style, PhotoEdit.frameCss(doc, it, k));
      sig = ['i', it.asset, !!a, a && a.w, a && a.h, a && a.img && a.img.width, it.s, it.ox, it.oy, W, H, k, st && Color.css(st), it.strokeW, JSON.stringify(it.effects || [])].join('|');
      html = a
        ? `<img draggable="false" src="${a.url}" style="left:${it.ox * k}px;top:${it.oy * k}px;width:${a.w * it.s * k}px;height:${a.h * it.s * k}px">`
        : `<div class="img-empty"><span>${it.asset ? 'Loading…' : 'Double-click to add a photo'}</span></div>`;
      if (st && it.strokeW) html += `<svg class="shape" width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="${Color.css(st)}" stroke-width="${it.strokeW * k}"/></svg>`;
    } else if (it.type === 'barcode') {
      // An ISBN barcode: vector bars and OCR-B numbers on white (renderer/barcode.js).
      sig = ['b', Barcode.ready(), Barcode.isbnOf(doc, it), it.price, it.priceCode, W, H].join('|');
      html = Barcode.svg(doc, it, k);
    } else if (it.type === 'text') {
      const L = Layout.box(doc, it, pc);
      const st = L.style || Model.styleOf(doc, it);
      const f = L.font;
      const col = Color.css(Model.resolveColor(doc, st.color) || { c: 0, m: 0, y: 0, k: 100 });
      sig = ['t', f && f.cssName, L.size, col, st.tracking, W, H, k, JSON.stringify(L.lines), el.dataset.master].join('|');
      if (f) {
        const ls = ((st.tracking || 0) / 1000) * L.size * k;
        const parts = [];
        for (const l of L.lines) {
          if (l.justified) for (const w of l.words) parts.push(`<text x="${w.x * k}" y="${l.y * k}">${esc(w.t)}</text>`);
          else if (l.text) parts.push(`<text x="${l.x * k}" y="${l.y * k}">${esc(l.text)}</text>`);
        }
        html = `<svg class="txt" width="${W}" height="${H}" style="font-family:'${f.cssName}';font-size:${L.size * k}px;letter-spacing:${ls}px;fill:${col}">${parts.join('')}</svg>`;
      } else html = '';
      // An empty master box on a page is filled in with Ctrl+Shift+click, not a double-click.
      if (!it.text && !L.lines.some((l) => l.text)) html += `<div class="txt-empty">${el.dataset.master ? 'Ctrl+Shift+click to fill in' : 'Double-click to type'}</div>`;
    } else {
      const fill = Model.resolveColor(doc, it.fill);
      const stroke = Model.resolveColor(doc, it.stroke);
      const sw = (it.strokeW || 0) * k;
      const f = fill ? Color.css(fill) : 'none';
      const s = stroke && sw ? `stroke="${Color.css(stroke)}" stroke-width="${sw}"` : '';
      sig = [it.type, f, s, W, H, it.radius, k].join('|');
      let shape;
      if (it.type === 'rect') shape = `<rect x="0" y="0" width="${W}" height="${H}" rx="${Math.min((it.radius || 0) * k, W / 2, H / 2)}" fill="${f}" ${s}/>`;
      else if (it.type === 'ellipse') shape = `<ellipse cx="${W / 2}" cy="${H / 2}" rx="${W / 2}" ry="${H / 2}" fill="${f}" ${s}/>`;
      else shape = `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" ${s || 'stroke="#000" stroke-width="1"'}/>`;
      html = `<svg class="shape" width="${W}" height="${H}">${shape}</svg>`;
    }
    if (el._sig !== sig) {
      el._sig = sig;
      el.innerHTML = html;
    }
  }

  /* ---------- overlay: guides, selection, handles ---------- */
  function renderOverlay() {
    const { doc, sel, settings } = S();
    const k = z();
    overlay.innerHTML = '';
    overlay.style.width = board.style.width;
    overlay.style.height = board.style.height;
    const svgParts = [];
    for (const g of geo) {
      const x = g.ox, y = g.oy, W = g.w * k, H = g.h * k;
      if (settings.showGuides !== false) {
        // Bleed edge (not along the spine of a spread).
        const bx0 = x - g.bl.l * k, by0 = y - g.bl.t * k, bx1 = x + (g.w + g.bl.r) * k, by1 = y + (g.h + g.bl.b) * k;
        const d = [`M${bx0} ${by0}H${bx1}`, `M${bx0} ${by1}H${bx1}`];
        if (g.bl.l) d.push(`M${bx0} ${by0}V${by1}`);
        if (g.bl.r) d.push(`M${bx1} ${by0}V${by1}`);
        if (g.bl.l || g.bl.r || g.bl.t) svgParts.push(`<path class="g-bleed" d="${d.join('')}"/>`);
        // Safe area (margins).
        if (Model.isCoverPage(g.surface)) {
          // One cover page: a 6 mm safe area, and on the inside the glue strip along the spine edge.
          const safe = 6 * k;
          svgParts.push(`<rect class="g-margin" x="${x + safe}" y="${y + safe}" width="${W - 2 * safe}" height="${H - 2 * safe}"/>`);
          if (Model.isInside(g.surface)) {
            const c = Model.cover(doc);
            const a = Math.max(0, c.glue[0] - g.org), b2 = Math.min(g.w, c.glue[1] - g.org);
            if (b2 > a) {
              svgParts.push(`<rect class="g-glue" x="${x + a * k}" y="${y}" width="${(b2 - a) * k}" height="${H}"/>`);
              svgParts.push(`<text class="g-label g-glue-label" x="${x + ((a + b2) / 2) * k}" y="${y - 26}" text-anchor="${a < 1 ? 'start' : 'end'}">Glue area: keep clear</text>`);
            }
          }
        } else if (g.surface.kind === 'cover') {
          const c = Model.cover(doc);
          const safe = 6 * k;
          for (const [a, b2] of [c.back, c.front]) svgParts.push(`<rect class="g-margin" x="${x + a * k + safe}" y="${y + safe}" width="${(b2 - a) * k - 2 * safe}" height="${H - 2 * safe}"/>`);
          for (const sx of c.spineX) svgParts.push(`<line class="g-spine" x1="${x + sx * k}" y1="${y - 20}" x2="${x + sx * k}" y2="${y + H + 20}"/>`);
          svgParts.push(`<text class="g-label" x="${x + ((c.spineX[0] + c.spineX[1]) / 2) * k}" y="${y - 26}" text-anchor="middle">Spine ${c.spine.toFixed(2)} mm</text>`);
          // The inside is the sheet turned over: inside front on the left, inside back on the right.
          const inside = Model.isInside(g.surface);
          svgParts.push(`<text class="g-label" x="${x + (c.back[0] + c.back[1]) / 2 * k}" y="${y - 26}" text-anchor="middle">${inside ? 'Inside front' : 'Back'}</text>`);
          svgParts.push(`<text class="g-label" x="${x + (c.front[0] + c.front[1]) / 2 * k}" y="${y - 26}" text-anchor="middle">${inside ? 'Inside back' : 'Front'}</text>`);
          if (inside) {
            const gx = x + c.glue[0] * k, gw = (c.glue[1] - c.glue[0]) * k;
            svgParts.push(`<rect class="g-glue" x="${gx}" y="${y}" width="${gw}" height="${H}"/>`);
            svgParts.push(`<text class="g-label g-glue-label" x="${gx + gw / 2}" y="${y - 40}" text-anchor="middle">Glue area: keep clear</text>`);
          }
        } else {
          const m = Model.margins(doc, g.side);
          svgParts.push(`<rect class="g-margin" x="${x + m.left * k}" y="${y + m.top * k}" width="${W - (m.left + m.right) * k}" height="${H - (m.top + m.bottom) * k}"/>`);
        }
      }
      // Trim edge.
      svgParts.push(`<rect class="g-trim" x="${x}" y="${y}" width="${W}" height="${H}"/>`);
      // Page label under the page.
      const label = g.surface.kind === 'page' ? `${Model.pageNumber(doc, g.surface.idx)}` : g.surface.kind === 'master' ? `${Model.master(doc, g.surface.id)?.name}${doc.facing ? (g.surface.side === 'left' ? ' · left' : ' · right') : ''}` : Model.surfaceName(doc, g.surface);
      svgParts.push(`<text class="g-pagelabel" x="${x + W / 2}" y="${y + H + (g.bl.b * k) + 22}" text-anchor="middle">${esc(label)}</text>`);
    }
    for (const gl of guidesShown) {
      if (gl.x != null) svgParts.push(`<line class="g-snap" x1="${gl.x}" y1="0" x2="${gl.x}" y2="${board.clientHeight}"/>`);
      else svgParts.push(`<line class="g-snap" x1="0" y1="${gl.y}" x2="${board.clientWidth}" y2="${gl.y}"/>`);
    }
    if (drag && drag.kind === 'marquee' && drag.rect) {
      const r = drag.rect;
      svgParts.push(`<rect class="g-marquee" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`);
    }
    if (drag && drag.kind === 'create' && drag.rect) {
      const r = drag.rect;
      svgParts.push(`<rect class="g-create" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`);
    }
    overlay.insertAdjacentHTML('beforeend', `<svg class="guides" width="${board.clientWidth}" height="${board.clientHeight}">${svgParts.join('')}</svg>`);

    // Text that doesn't fit and threads.
    for (const g of geo) {
      for (const it of Model.surfaceItems(doc, g.surface)) {
        if (it.type !== 'text' || it.hidden) continue;
        const L = Layout.box(doc, it, Render.ctxFor(doc, g.surface));
        const ports = [];
        if (L.overflow) ports.push('<span class="port port-over" title="More text than fits">+</span>');
        else if (it.next) ports.push('<span class="port port-next" title="Continues in another box">→</span>');
        if (ports.length) overlay.insertAdjacentHTML('beforeend', `<div class="ports" style="${boxStyle(g, it)}">${ports.join('')}</div>`);
      }
    }

    // Selection. A group, or several things, gets one box round them all, with corner handles to
    // scale them together and one to turn them (under each one's own outline, so a double-click on
    // one still reaches it).
    const items = selectedItems();
    if (items.length > 1 && !S().crop) {
      const gg = geoFor(S().surface);
      if (gg) {
        const b = boundsOf(items);
        const locked = items.some((x) => x.locked);
        const handles = locked ? '' : ['nw', 'ne', 'se', 'sw'].map((h) => `<i class="h h-${h}" data-h="${h}"></i>`).join('') + '<i class="h h-rot" data-h="rot"></i>';
        const gid = App.selectedGroup();
        const name = gid && S().doc.groups[gid] ? `<span class="sel-group-name">${esc(S().doc.groups[gid].name)}</span>` : '';
        overlay.insertAdjacentHTML('beforeend', `<div class="sel sel-group${gid ? ' is-group' : ''}${locked ? ' sel-locked' : ''}" style="left:${gx(gg) + b.x0 * k}px;top:${gg.oy + b.y0 * k}px;width:${(b.x1 - b.x0) * k}px;height:${(b.y1 - b.y0) * k}px">${name}${handles}</div>`);
      }
    }
    for (const it of items) {
      const gg = geoFor(S().surface);
      if (!gg) continue;
      const single = items.length === 1 && !it.locked;
      const handles =
        single && !S().crop
          ? (it.type === 'line' ? ['w', 'e'] : it.type === 'barcode' ? ['nw', 'ne', 'se', 'sw'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']).map((h) => `<i class="h h-${h}" data-h="${h}"></i>`).join('') + '<i class="h h-rot" data-h="rot"></i>'
          : '';
      overlay.insertAdjacentHTML('beforeend', `<div class="sel ${it.locked ? 'sel-locked' : ''}${items.length > 1 ? ' sel-member' : ''}" data-id="${it.id}" style="${boxStyle(gg, it)}">${handles}</div>`);
    }
    if (S().crop) {
      const it = Model.findItem(doc, S().crop)?.item;
      const a = it && PhotoEdit.view(doc, it, { scale: it.s * k * (devicePixelRatio || 1) });
      const gg = geoFor(S().surface);
      if (it && a && gg) {
        overlay.insertAdjacentHTML(
          'beforeend',
          `<div class="crop-ghost" style="${boxStyle(gg, it)}"><div class="crop-img" style="left:${it.ox * k}px;top:${it.oy * k}px;width:${a.w * it.s * k}px;height:${a.h * it.s * k}px;background-image:url('${a.url}')"></div></div>`
        );
      }
    }
    if (drag && drag.info) overlay.insertAdjacentHTML('beforeend', `<div class="drag-info" style="left:${drag.info.x + 14}px;top:${drag.info.y + 14}px">${esc(drag.info.text)}</div>`);
  }
  const boxStyle = (g, it) => {
    const k = z();
    return `left:${gx(g) + it.x * k}px;top:${g.oy + it.y * k}px;width:${it.w * k}px;height:${it.h * k}px;${it.rot ? `transform:rotate(${it.rot}deg);` : ''}`;
  };
  const geoFor = (s) => geo.find((g) => Model.sameSurface(g.surface, s));

  /* ---------- groups and several things at once ---------- */
  // The box (mm) round some boxes, turned ones included.
  function boundsOf(items) {
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
  // One box scaled by s from (ax, ay), from how it was (o): its place and size, and everything
  // in it, so it looks the same only bigger or smaller: a photo's zoom and crop, line widths,
  // rounded corners, and text sizes, spacing and indents.
  function scaleItem(it, o, ax, ay, s) {
    const cx = ax + (o.x + o.w / 2 - ax) * s, cy = ay + (o.y + o.h / 2 - ay) * s;
    it.w = o.w * s;
    it.h = o.h * s;
    it.x = cx - it.w / 2;
    it.y = cy - it.h / 2;
    if (o.strokeW != null) it.strokeW = o.strokeW * s;
    if (o.radius) it.radius = o.radius * s;
    if (it.type === 'image' && o.s != null) Object.assign(it, { s: o.s * s, ox: o.ox * s, oy: o.oy * s });
    if (it.type === 'text' && o.style) {
      const r = (v) => Math.round(v * s * 100) / 100;
      it.style = { ...clone(o.style), size: r(o.style.size), leading: r(o.style.leading || o.style.size * 1.2), spaceAfter: r(o.style.spaceAfter || 0), indent: r(o.style.indent || 0) };
    }
  }

  function selectedItems() {
    const { doc, surface, sel } = S();
    if (!doc || !sel.size) return [];
    return Model.surfaceItems(doc, surface).filter((it) => sel.has(it.id));
  }

  /* ---------- pointer helpers ---------- */
  function boardPoint(e) {
    const r = board.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  // The page under a point, or the nearest one.
  function geoAt(p) {
    const k = z();
    let best = null;
    let bd = Infinity;
    for (const g of geo) {
      const x0 = g.ox - g.bl.l * k, y0 = g.oy - g.bl.t * k, x1 = g.ox + (g.w + g.bl.r) * k, y1 = g.oy + (g.h + g.bl.b) * k;
      const d = Math.max(0, x0 - p.x, p.x - x1) + Math.max(0, y0 - p.y, p.y - y1);
      if (d < bd) (bd = d), (best = g);
    }
    return best;
  }
  // Screen x of a page's item 0 (the page's left edge, less any cover-page offset).
  const gx = (g) => g.ox - (g.org || 0) * z();
  const toMm = (g, p) => ({ x: (p.x - gx(g)) / z(), y: (p.y - g.oy) / z() });

  /* ---------- snapping ---------- */
  function snapTargets(g, exclude) {
    const { doc } = S();
    // Page edges, centre and bleed, in item coordinates (cover pages are offset by org).
    const o = g.org || 0;
    const xs = [0, g.w / 2, g.w, -g.bl.l, g.w + g.bl.r].map((v) => v + o);
    const ys = [0, g.h / 2, g.h, -g.bl.t, g.h + g.bl.b];
    if (Model.isCoverPage(g.surface)) {
      xs.push(o + 6, o + g.w - 6);
      ys.push(6, g.h - 6);
    } else if (g.surface.kind === 'cover') {
      const c = Model.cover(doc);
      xs.push(...c.spineX, (c.front[0] + c.front[1]) / 2, (c.back[0] + c.back[1]) / 2, c.back[0] + 6, c.back[1] - 6, c.front[0] + 6, c.front[1] - 6);
      ys.push(6, g.h - 6);
    } else {
      const m = Model.margins(doc, g.side);
      xs.push(m.left, g.w - m.right);
      ys.push(m.top, g.h - m.bottom);
    }
    for (const it of Render.itemsOf(doc, g.surface).map((x) => x.it)) {
      if (exclude.has(it.id) || it.hidden || it.rot) continue;
      xs.push(it.x, it.x + it.w / 2, it.x + it.w);
      ys.push(it.y, it.y + it.h / 2, it.y + it.h);
    }
    return { xs, ys };
  }
  function snap1(vals, targets, tol) {
    let best = null;
    for (const v of vals) for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t };
    }
    return best;
  }

  /* ---------- pointer events ---------- */
  function onDown(e) {
    if (e.button === 1 || (e.button === 0 && spaceDown)) return startPan(e);
    if (e.button !== 0) return;
    const { doc } = S();
    if (!doc) return;
    // A click inside the text being edited just moves the cursor.
    if (e.target.closest('.inline-text')) return;
    if (S().editing) Text.finish();
    const p = boardPoint(e);
    const g = geoAt(p);
    const h = e.target.closest('.h');
    const itemEl = e.target.closest('.item');
    const selEl = e.target.closest('.sel');

    // A box from the master, on a page: locked, like InDesign. Ctrl+Shift+click gives this page
    // its own copy to change; a double-click explains that.
    if (itemEl && itemEl.dataset.master && !h && S().tool === 'select' && g && g.surface.kind === 'page') {
      if (e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        lastPress = null;
        return App.overrideMaster(g.surface.idx, itemEl.dataset.id);
      }
      const now = performance.now();
      const mid = 'm:' + itemEl.dataset.id;
      const again = lastPress && lastPress.id === mid && now - lastPress.t < DOUBLE_MS && Math.hypot(p.x - lastPress.x, p.y - lastPress.y) < 6;
      lastPress = again ? null : { id: mid, t: now, x: p.x, y: p.y };
      if (again) {
        e.preventDefault();
        return Hints.show('master-override');
      }
    }

    if (S().linkFrom) {
      const id = itemEl && !itemEl.dataset.master ? itemEl.dataset.id : null;
      Panels.finishLink(id);
      return;
    }
    if (S().crop) {
      const it = Model.findItem(doc, S().crop)?.item;
      if (it && (e.target.closest('.crop-ghost') || (itemEl && itemEl.dataset.id === it.id))) {
        App.history.begin();
        drag = { kind: 'pan-img', it, start: p, ox: it.ox, oy: it.oy };
        e.preventDefault();
        return;
      }
      App.endCrop();
    }

    // Creating a new box.
    if (S().tool !== 'select' && g) {
      if (!Model.sameSurface(g.surface, S().surface)) App.goTo(g.surface, { keepSel: false });
      const m = toMm(g, p);
      drag = { kind: 'create', g, start: p, m0: m, rect: null };
      e.preventDefault();
      return;
    }

    // The handles of a group (or several things): scale them all from the opposite corner, or turn
    // them all round their middle.
    if (h && h.closest('.sel-group')) {
      const items = selectedItems();
      if (!items.length || items.some((x) => x.locked)) return;
      App.history.begin();
      const box = boundsOf(items);
      const orig = items.map((it) => ({ it, o: { ...clone(it), style: it.type === 'text' ? clone(Model.styleOf(doc, it)) : undefined } }));
      if (h.dataset.h === 'rot') drag = { kind: 'grotate', g: geoFor(S().surface), start: p, box, orig };
      else drag = { kind: 'gscale', g: geoFor(S().surface), start: p, box, orig, h: h.dataset.h };
      e.preventDefault();
      return;
    }
    if (h) {
      const it = selectedItems()[0];
      if (!it) return;
      App.history.begin();
      const gg = geoFor(S().surface);
      if (h.dataset.h === 'rot') drag = { kind: 'rotate', it, g: gg, start: p, rot0: it.rot || 0 };
      else drag = { kind: 'resize', it, g: gg, start: p, h: h.dataset.h, o: { ...it }, aspect: it.w / it.h };
      e.preventDefault();
      return;
    }

    let id = null;
    if (itemEl && !itemEl.dataset.master && !itemEl.classList.contains('locked')) id = itemEl.dataset.id;
    else if (selEl && !selEl.classList.contains('sel-locked')) id = selEl.dataset.id;
    // The box round a group or several things: drag anywhere in it to move them all.
    if (!id && selEl && selEl.classList.contains('sel-group')) {
      App.history.begin();
      const items = selectedItems().filter((x) => !x.locked);
      drag = { kind: 'move', g: geoFor(S().surface), start: p, items: items.map((it) => ({ it, x: it.x, y: it.y })), moved: false, alt: e.altKey };
      e.preventDefault();
      return;
    }
    if (id) {
      // Two presses on the same box in quick succession open it (type into text, crop a photo).
      // Counted here because the browser's own dblclick never arrives: the press is
      // preventDefault()ed so boxes can be dragged, which also stops the browser counting clicks.
      const now = performance.now();
      const again = lastPress && lastPress.id === id && now - lastPress.t < DOUBLE_MS && Math.hypot(p.x - lastPress.x, p.y - lastPress.y) < 6;
      lastPress = again ? null : { id, t: now, x: p.x, y: p.y };
      if (again && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        return openItem(id);
      }
      const found = Model.findItem(doc, id, S().surface);
      if (found && !Model.sameSurface(found.surface, S().surface)) App.goTo(found.surface, { keepSel: false });
      const sel = S().sel;
      // A box in a group picks up its whole group (unless you've gone into the group).
      const ids = App.withGroups([id]);
      if (e.shiftKey || e.ctrlKey) {
        const on = !sel.has(id);
        for (const x of ids) on ? sel.add(x) : sel.delete(x);
        App.selectionChanged();
        if (!sel.has(id)) return;
      } else if (!sel.has(id)) App.select(ids);
      App.history.begin();
      const items = selectedItems().filter((x) => !x.locked);
      drag = { kind: 'move', g: geoFor(S().surface), start: p, items: items.map((it) => ({ it, x: it.x, y: it.y })), moved: false, alt: e.altKey };
      e.preventDefault();
      return;
    }

    // Empty space: change page, start a marquee.
    if (g && !Model.sameSurface(g.surface, S().surface)) App.goTo(g.surface, { keepSel: false });
    if (!e.shiftKey) App.select([]);
    drag = { kind: 'marquee', g: geoFor(S().surface), start: p, rect: null, base: new Set(S().sel) };
  }

  function startPan(e) {
    e.preventDefault();
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
  }

  function onMove(e) {
    if (!drag) return;
    const { doc } = S();
    const k = z();
    if (drag.kind === 'pan') {
      stage.scrollLeft = drag.l - (e.clientX - drag.sx);
      stage.scrollTop = drag.t - (e.clientY - drag.sy);
      return;
    }
    const p = boardPoint(e);
    const dx = (p.x - drag.start.x) / k;
    const dy = (p.y - drag.start.y) / k;
    const tol = 6 / k;
    const snapOn = S().settings.snap !== false && !e.ctrlKey;
    guidesShown = [];

    if (drag.kind === 'move') {
      if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 3) return;
      if (!drag.moved && drag.alt) {
        // Alt-drag leaves a copy behind.
        const list = Model.surfaceItems(doc, S().surface);
        const copies = App.copiesOf(drag.items.map((d) => d.it), list);
        drag.items.forEach((d, i) => list.splice(list.indexOf(d.it), 0, copies[i]));
        Model.tidyGroups(list);
      }
      drag.moved = true;
      let mx = dx, my = dy;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (my = 0) : (mx = 0);
      const x0 = Math.min(...drag.items.map((d) => d.x)), y0 = Math.min(...drag.items.map((d) => d.y));
      const x1 = Math.max(...drag.items.map((d) => d.x + d.it.w)), y1 = Math.max(...drag.items.map((d) => d.y + d.it.h));
      if (snapOn && drag.g) {
        const t = snapTargets(drag.g, S().sel);
        const sx = snap1([x0 + mx, (x0 + x1) / 2 + mx, x1 + mx], t.xs, tol);
        const sy = snap1([y0 + my, (y0 + y1) / 2 + my, y1 + my], t.ys, tol);
        if (sx && !(e.shiftKey && mx === 0)) (mx += sx.d), guidesShown.push({ x: gx(drag.g) + sx.t * k });
        if (sy && !(e.shiftKey && my === 0)) (my += sy.d), guidesShown.push({ y: drag.g.oy + sy.t * k });
      }
      for (const d of drag.items) (d.it.x = d.x + mx), (d.it.y = d.y + my);
      drag.info = { x: p.x, y: p.y, text: `${Units.label(x0 + mx, App.unit(), doc.dpi)}, ${Units.label(y0 + my, App.unit(), doc.dpi)}` };
      paintSelected();
    } else if (drag.kind === 'resize') {
      const { it, o, h } = drag;
      const a = ((o.rot || 0) * Math.PI) / 180;
      const lx = dx * Math.cos(a) + dy * Math.sin(a);
      const ly = -dx * Math.sin(a) + dy * Math.cos(a);
      const hx = h.includes('e') ? 1 : h.includes('w') ? -1 : 0;
      const hy = h.includes('s') ? 1 : h.includes('n') ? -1 : 0;
      let nw = Math.max(1, o.w + hx * lx);
      let nh = it.type === 'line' ? o.h : Math.max(1, o.h + hy * ly);
      // A photo's corner scales the whole picture, frame and photo together, from the opposite
      // corner (Shift: change the frame's shape instead, which crops like a side).
      // A barcode's corners always scale it (it only has corners).
      const photoScale = (it.type === 'image' && hx && hy && !e.shiftKey) || (it.type === 'barcode' && hx && hy);
      if (photoScale) {
        // How far along the diagonal the pointer has gone.
        const s = Math.max(1 / Math.max(o.w, o.h), (hx * lx * o.w + hy * ly * o.h) / (o.w * o.w + o.h * o.h) + 1);
        nw = o.w * s;
        nh = o.h * s;
      }
      // Edge snapping (boxes that aren't rotated).
      if (snapOn && !o.rot && drag.g && photoScale) {
        // Scaling a photo: snap whichever moving edge comes close, keeping the shape.
        const t = snapTargets(drag.g, new Set([it.id]));
        const sx = snap1([hx === 1 ? o.x + nw : o.x + o.w - nw], t.xs, tol);
        const sy = snap1([hy === 1 ? o.y + nh : o.y + o.h - nh], t.ys, tol);
        const pick = sx && (!sy || Math.abs(sx.d) <= Math.abs(sy.d)) ? 'x' : sy ? 'y' : null;
        if (pick === 'x') {
          const w2 = nw + hx * sx.d;
          nh *= w2 / nw;
          nw = w2;
          guidesShown.push({ x: gx(drag.g) + sx.t * k });
        } else if (pick === 'y') {
          const h2 = nh + hy * sy.d;
          nw *= h2 / nh;
          nh = h2;
          guidesShown.push({ y: drag.g.oy + sy.t * k });
        }
      } else if (snapOn && !o.rot && drag.g) {
        const t = snapTargets(drag.g, new Set([it.id]));
        if (hx === 1) { const s = snap1([o.x + nw], t.xs, tol); if (s) (nw += s.d), guidesShown.push({ x: gx(drag.g) + s.t * k }); }
        if (hx === -1) { const s = snap1([o.x + o.w - nw], t.xs, tol); if (s) (nw -= s.d), guidesShown.push({ x: gx(drag.g) + s.t * k }); }
        if (hy === 1 && it.type !== 'line') { const s = snap1([o.y + nh], t.ys, tol); if (s) (nh += s.d), guidesShown.push({ y: drag.g.oy + s.t * k }); }
        if (hy === -1 && it.type !== 'line') { const s = snap1([o.y + o.h - nh], t.ys, tol); if (s) (nh -= s.d), guidesShown.push({ y: drag.g.oy + s.t * k }); }
      }
      // Shift on a corner keeps the shape (photos keep it anyway, unless Shift is held).
      // A barcode stays between 80% and 200% of the standard size, its shape exact.
      if (it.type === 'barcode') {
        const bb = Barcode.base(it);
        nw = Math.max(bb.w * Barcode.MIN, Math.min(bb.w * Barcode.MAX, nw));
        nh = (nw * bb.h) / bb.w;
      }
      if (e.shiftKey && hx && hy && it.type !== 'image' && it.type !== 'barcode') {
        if (nw / nh > drag.aspect) nh = nw / drag.aspect;
        else nw = nh * drag.aspect;
      }
      const dcl = { x: (hx * (nw - o.w)) / 2, y: (hy * (nh - o.h)) / 2 };
      const cx = o.x + o.w / 2 + dcl.x * Math.cos(a) - dcl.y * Math.sin(a);
      const cy = o.y + o.h / 2 + dcl.x * Math.sin(a) + dcl.y * Math.cos(a);
      Object.assign(it, { w: nw, h: nh, x: cx - nw / 2, y: cy - nh / 2 });
      if (it.type === 'image') {
        if (photoScale) {
          // Scaled: the photo grows or shrinks with its frame, so the same part stays in view.
          const s = nw / o.w;
          Object.assign(it, { s: o.s * s, ox: o.ox * s, oy: o.oy * s });
        } else Render.cropTo(it, o, hx, hy, Assets.get(it.asset) || doc.assets[it.asset]);
      }
      if (it.type === 'text') Layout.invalidate();
      drag.info = { x: p.x, y: p.y, text: `${Units.fmt(nw, App.unit(), doc.dpi)} × ${Units.label(nh, App.unit(), doc.dpi)}` };
      paintSelected();
    } else if (drag.kind === 'gscale') {
      // Scale the lot from the opposite corner, keeping its shape.
      const { box, h } = drag;
      const hx = h.includes('e') ? 1 : -1, hy = h.includes('s') ? 1 : -1;
      const W = box.x1 - box.x0, H = box.y1 - box.y0;
      const ax = hx === 1 ? box.x0 : box.x1, ay = hy === 1 ? box.y0 : box.y1;
      const s = Math.max(0.02, 1 + (hx * dx * W + hy * dy * H) / (W * W + H * H));
      for (const { it, o } of drag.orig) scaleItem(it, o, ax, ay, s);
      Layout.invalidate();
      drag.info = { x: p.x, y: p.y, text: `${Units.fmt(W * s, App.unit(), doc.dpi)} × ${Units.label(H * s, App.unit(), doc.dpi)}` };
      paintSelected();
    } else if (drag.kind === 'grotate') {
      // Turn the lot round its middle.
      const { box, g } = drag;
      const cxm = (box.x0 + box.x1) / 2, cym = (box.y0 + box.y1) / 2;
      const c = { x: gx(g) + cxm * k, y: g.oy + cym * k };
      const a0 = Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
      let d = ((Math.atan2(p.y - c.y, p.x - c.x) - a0) * 180) / Math.PI;
      if (e.shiftKey) d = Math.round(d / 15) * 15;
      const r = (d * Math.PI) / 180;
      for (const { it, o } of drag.orig) {
        const ox = o.x + o.w / 2 - cxm, oy = o.y + o.h / 2 - cym;
        it.x = cxm + ox * Math.cos(r) - oy * Math.sin(r) - o.w / 2;
        it.y = cym + ox * Math.sin(r) + oy * Math.cos(r) - o.h / 2;
        let rot = (o.rot || 0) + d;
        rot = ((rot % 360) + 360) % 360;
        it.rot = Math.round((rot > 180 ? rot - 360 : rot) * 10) / 10;
      }
      drag.info = { x: p.x, y: p.y, text: `${Math.round(d)}°` };
      paintSelected();
    } else if (drag.kind === 'rotate') {
      const { it, g } = drag;
      const c = { x: gx(g) + (it.x + it.w / 2) * k, y: g.oy + (it.y + it.h / 2) * k };
      let ang = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      else if (snapOn) for (const s of [0, 90, 180, 270, 360, -90]) if (Math.abs(ang - s) < 2) ang = s;
      ang = ((ang % 360) + 360) % 360;
      if (ang > 180) ang -= 360;
      it.rot = Math.round(ang * 10) / 10;
      drag.info = { x: p.x, y: p.y, text: `${it.rot}°` };
      paintSelected();
    } else if (drag.kind === 'marquee' || drag.kind === 'create') {
      const r = { x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) };
      drag.rect = r;
      if (drag.kind === 'marquee' && drag.g) {
        const g = drag.g;
        const hit = Render.itemsOf(doc, g.surface).filter((x) => !x.master).map((x) => x.it).filter((it) => {
          if (it.locked || it.hidden) return false;
          const ix = gx(g) + it.x * k, iy = g.oy + it.y * k;
          return ix < r.x + r.w && ix + it.w * k > r.x && iy < r.y + r.h && iy + it.h * k > r.y;
        });
        S().sel = new Set(App.withGroups([...drag.base, ...hit.map((x) => x.id)]));
      }
      if (drag.kind === 'create') {
        const g = drag.g;
        const m0 = drag.m0, m1 = toMm(g, p);
        drag.info = { x: p.x, y: p.y, text: `${Units.fmt(Math.abs(m1.x - m0.x), App.unit(), doc.dpi)} × ${Units.label(Math.abs(m1.y - m0.y), App.unit(), doc.dpi)}` };
      }
      renderOverlay();
    } else if (drag.kind === 'pan-img') {
      drag.it.ox = drag.ox + dx;
      drag.it.oy = drag.oy + dy;
      drag.it.fit = 'custom';
      paintSelected();
    }
  }

  function onUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    guidesShown = [];
    const { doc } = S();
    if (d.kind === 'pan') return;
    if (d.kind === 'create') {
      const g = d.g;
      const p = boardPoint(e);
      const m1 = toMm(g, p);
      let x = Math.min(d.m0.x, m1.x), y = Math.min(d.m0.y, m1.y), w = Math.abs(m1.x - d.m0.x), h = Math.abs(m1.y - d.m0.y);
      const tool = S().tool;
      const defaults = { text: [80, 20], rect: [50, 35], ellipse: [40, 40], line: [60, 2], image: [80, 60] };
      if (w < 2 && h < 2) [w, h] = defaults[tool] || [50, 35];
      if (tool === 'line') h = 2;
      App.addItem(tool, x, y, w, h);
      return;
    }
    if (d.kind === 'marquee') {
      App.selectionChanged();
      renderOverlay();
      return;
    }
    if (d.kind === 'move') {
      if (!d.moved) {
        renderOverlay();
        return;
      }
      moveAcrossPages(d.items.map((x) => x.it));
    }
    if (['move', 'resize', 'rotate', 'pan-img', 'gscale', 'grotate'].includes(d.kind)) App.history.commit({ move: 'Move', resize: 'Resize', rotate: 'Rotate', 'pan-img': 'Move photo', gscale: 'Resize', grotate: 'Rotate' }[d.kind]);
    if (d.kind === 'gscale') render(); // text in the group reflows
  }

  // A box dragged onto the other page of a spread moves to that page.
  function moveAcrossPages(items) {
    const { doc, surface } = S();
    const from = geoFor(surface);
    if (!from || geo.length < 2) return;
    const k = z();
    const it0 = items[0];
    const cx = gx(from) + (it0.x + it0.w / 2) * k;
    const cy = from.oy + (it0.y + it0.h / 2) * k;
    const to = geo.find((g) => g !== from && cx >= g.ox && cx <= g.ox + g.w * k && cy >= g.oy - 50 && cy <= g.oy + g.h * k + 50);
    if (!to) return;
    const src = Model.surfaceItems(doc, surface);
    const dst = Model.surfaceItems(doc, to.surface);
    const dxmm = (gx(from) - gx(to)) / k;
    for (const it of items) {
      src.splice(src.indexOf(it), 1);
      it.x += dxmm;
      dst.push(it);
    }
    App.goTo(to.surface, { keepSel: true });
  }

  function paintSelected() {
    const { doc, surface } = S();
    const g = geoFor(surface);
    if (!g) return;
    // Moving or resizing something with effects: they're worked out again, so draw it all.
    const withFx = (it) => (it.type !== 'image' && ItemFX.hasAny(it.effects)) || (it.group && doc.groups[it.group] && ItemFX.hasAny(doc.groups[it.group].effects)) || (it.type === 'image' && PhotoFX.frameEffects(it.effects).outline);
    if (selectedItems().some(withFx)) {
      render();
      return Panels.refreshGeometry();
    }
    const pc = Render.ctxFor(doc, surface);
    for (const it of Model.surfaceItems(doc, surface)) {
      const el = els.get(it.id);
      if (el) paint(el, it, pc, z());
      if (el && fxHidden.has(el)) el.style.opacity = '0'; // shown as a picture with its effects
    }
    // Text in other boxes of a thread can move when a box is resized.
    if (drag && drag.kind === 'resize' && drag.it.type === 'text') render();
    else renderOverlay();
    Panels.refreshGeometry();
  }

  // A real dblclick event, if one ever arrives (onDown counts the clicks itself).
  function onDbl(e) {
    const el = e.target.closest('.item, .sel') || document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.matches('.sel[data-id], .item[data-id]'));
    if (!el || el.dataset.master) return;
    openItem(el.dataset.id);
  }
  let lastPress = null;
  const DOUBLE_MS = 500; // Windows' standard double-click time
  function openItem(id) {
    const found = id && Model.findItem(S().doc, id, S().surface);
    if (!found || found.item.locked) return;
    if (S().editing && S().editing.id === id) return; // already typing in it
    // A box in a group: the first double-click goes into the group, with just this box picked.
    if (found.item.group && S().inGroup !== found.item.group) {
      S().inGroup = found.item.group;
      App.select([id]);
      return App.status('In the group: click its boxes one at a time. Esc or click outside to come out.');
    }
    if (found.item.type === 'text') Text.edit(found.item);
    else if (found.item.type === 'image') {
      if (!found.item.asset) App.pickPhotoFor(found.item);
      else App.startCrop(found.item);
    }
  }

  function onContext(e) {
    e.preventDefault();
    const el = e.target.closest('.item, .sel');
    // Right-click on a master box on a page: offer to edit it on this page only.
    if (el && el.dataset.master) {
      const g = geoAt(boardPoint(e));
      if (g && g.surface.kind === 'page')
        return contextMenu(e.clientX, e.clientY, [{ label: 'Edit on this page only', key: 'Ctrl+Shift+click', run: () => App.overrideMaster(g.surface.idx, el.dataset.id) }]);
    }
    const id = el && !el.dataset.master ? el.dataset.id : null;
    if (id && !S().sel.has(id)) App.select(App.withGroups([id]));
    const has = S().sel.size > 0;
    const grouped = selectedItems().some((x) => x.group);
    const one = selectedItems()[0];
    const fromMaster = selectedItems().filter((x) => x.masterRef);
    const photos = PhotoEdit.photosIn(selectedItems());
    contextMenu(e.clientX, e.clientY, [
      ...(fromMaster.length ? [{ label: 'Reset to master', run: () => App.resetToMaster(fromMaster) }, '-'] : []),
      { label: 'Cut', key: 'Ctrl+X', disabled: !has, run: () => App.cmd('cut') },
      { label: 'Copy', key: 'Ctrl+C', disabled: !has, run: () => App.cmd('copy') },
      { label: 'Paste', key: 'Ctrl+V', run: () => App.cmd('paste') },
      { label: 'Duplicate', key: 'Ctrl+D', disabled: !has, run: () => App.cmd('duplicate') },
      '-',
      { label: 'Bring to front', key: 'Ctrl+Shift+]', disabled: !has, run: () => App.cmd('front') },
      { label: 'Bring forward', key: 'Ctrl+]', disabled: !has, run: () => App.cmd('forward') },
      { label: 'Send backward', key: 'Ctrl+[', disabled: !has, run: () => App.cmd('backward') },
      { label: 'Send to back', key: 'Ctrl+Shift+[', disabled: !has, run: () => App.cmd('back') },
      '-',
      ...(one && one.type === 'image' ? [{ label: 'Replace photo…', run: () => App.pickPhotoFor(one) }, { label: 'Adjust photo', run: () => App.startCrop(one) }, { label: 'Edit photo…', key: 'Ctrl+Shift+E', disabled: !PhotoEdit.canEdit(one), run: () => PhotoEdit.open(one) }] : []),
      ...(photos.length ? [
        ...(photos.length === 1 && selectedItems().length === 1 ? [{ label: 'Copy effects', key: 'Ctrl+Alt+C', disabled: !PhotoEdit.hasEffects(photos[0]), run: () => PhotoEdit.copyEffects(photos[0]) }] : []),
        { label: photos.length > 1 ? `Paste effects onto ${photos.length} photos` : 'Paste effects', key: 'Ctrl+Alt+V', disabled: !PhotoEdit.hasClip(), run: () => PhotoEdit.pasteEffects(photos) },
      ] : []),
      ...((one && one.type === 'image') || photos.length ? ['-'] : []),
      ...(one && one.type === 'text' ? [{ label: 'Edit text', run: () => Text.edit(one) }, ...(PlaceText.canFormat(one) ? [{ label: 'Format story…', run: () => PlaceText.format(one) }] : []), { label: 'Continue in another box', run: () => Panels.startLink(one) }, '-'] : []),
      { label: 'Group', key: 'Ctrl+G', disabled: S().sel.size < 2, run: () => App.cmd('group') },
      ...(grouped ? [{ label: 'Ungroup', key: 'Ctrl+Shift+G', run: () => App.cmd('ungroup') }] : []),
      '-',
      { label: one && one.locked ? 'Unlock' : 'Lock', disabled: !has, run: () => App.cmd('lock') },
      { label: 'Delete', key: 'Del', disabled: !has, run: () => App.cmd('delete') },
    ]);
  }

  function onWheel(e) {
    if (S().crop && !e.ctrlKey) {
      const it = Model.findItem(S().doc, S().crop)?.item;
      const a = it && Assets.get(it.asset);
      if (it && a) {
        e.preventDefault();
        App.history.begin();
        const f = Math.exp(-e.deltaY * 0.0015);
        const p = boardPoint(e);
        const g = geoFor(S().surface);
        // Zoom the photo around the pointer.
        const m = toMm(g, p);
        const lx = m.x - it.x, ly = m.y - it.y;
        const d = PhotoEdit.dims(it, a);
        const ns = Math.max(it.s * f, Math.max(it.w / d.w, it.h / d.h) * 0.2);
        const r = ns / it.s;
        it.ox = lx - (lx - it.ox) * r;
        it.oy = ly - (ly - it.oy) * r;
        it.s = ns;
        it.fit = 'custom';
        App.history.commitSoon('Zoom photo');
        paintSelected();
        return;
      }
    }
    if (!e.ctrlKey) return;
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.002);
    zoomAt(z() * f, e.clientX, e.clientY);
  }

  function zoomAt(newZ, cx, cy) {
    newZ = clamp(newZ, 0.05, 40);
    const r = stage.getBoundingClientRect();
    if (cx == null) (cx = r.left + r.width / 2), (cy = r.top + r.height / 2);
    // Keep the point under the pointer still.
    const before = geoAt({ x: cx - board.getBoundingClientRect().left, y: cy - board.getBoundingClientRect().top });
    const bp = { x: cx - board.getBoundingClientRect().left, y: cy - board.getBoundingClientRect().top };
    const m = before ? toMm(before, bp) : null;
    S().zoom = newZ;
    render();
    if (before && m) {
      const g = geo.find((x) => Model.sameSurface(x.surface, before.surface));
      if (g) {
        stage.scrollLeft += gx(g) + m.x * newZ - (cx - board.getBoundingClientRect().left);
        stage.scrollTop += g.oy + m.y * newZ - (cy - board.getBoundingClientRect().top);
      }
    }
    App.zoomChanged();
  }

  function fit() {
    const { doc, surface } = S();
    if (!doc) return;
    const list = spreadSurfaces(doc, surface);
    const sz = Model.surfaceSize(doc, list[0]);
    const w = (doc.facing && surface.kind !== 'cover' ? sz.w * 2 : list.reduce((a, s) => a + Model.surfaceSize(doc, s).w, 0)) + sz.bleed * 2;
    const h = sz.h + sz.bleed * 2;
    S().zoom = Math.min((stage.clientWidth - 2 * PAD + 120) / w, (stage.clientHeight - 2 * PAD + 120) / h);
    render();
    stage.scrollLeft = (board.clientWidth - stage.clientWidth) / 2;
    stage.scrollTop = (board.clientHeight - stage.clientHeight) / 2;
    App.zoomChanged();
  }

  function onHover(e) {
    const { doc } = S();
    if (!doc) return;
    const p = boardPoint(e);
    const g = geoAt(p);
    if (!g) return;
    const m = toMm(g, p);
    App.status(`${Units.fmt(m.x, App.unit(), doc.dpi)}, ${Units.fmt(m.y, App.unit(), doc.dpi)} ${App.unit()}`);
  }

  async function onDrop(e) {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    const p = boardPoint(e);
    const g = geoAt(p);
    if (!g) return;
    if (!Model.sameSurface(g.surface, S().surface)) App.goTo(g.surface, {});
    const m = toMm(g, p);
    const target = e.target.closest('.item-image');
    const list = await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })));
    if (target && !target.dataset.master && list.length === 1) {
      const it = Model.findItem(S().doc, target.dataset.id)?.item;
      if (it) return App.setPhoto(it, list[0]);
    }
    App.placePhotos(list, m);
  }

  return { init, render, renderOverlay, fit, zoomAt, spreadSurfaces, paintSelected, selectedItems, get geo() { return geo; }, geoFor, gx, get stage() { return stage; }, get board() { return board; } };
})();

/* Typing into a text box: a text area laid over the box, in the box's own font. Text that
   continues across boxes opens in the Story window instead, so you see all of it. */
const Text = (() => {
  let ta = null;
  let cur = null;
  function edit(it) {
    const { doc } = App.S;
    if (it.next || Model.chainOf(doc, it.id).length > 1) return Story.open(it);
    finish();
    const g = Editor.geoFor(App.S.surface);
    if (!g) return;
    cur = it;
    App.S.editing = it;
    App.history.begin();
    const k = App.S.zoom;
    const st = Model.styleOf(doc, it);
    const f = Fonts.get(st.font);
    const L = Layout.box(doc, it, Render.ctxFor(doc, App.S.surface));
    ta = document.createElement('textarea');
    ta.className = 'inline-text';
    ta.spellcheck = true;
    ta.value = it.text || '';
    const size = st.size * MM_PER_PT * k;
    const lead = (st.leading || st.size * 1.2) * MM_PER_PT * k;
    // Start the first line where the layout puts it.
    const firstTop = L.lines[0] ? L.lines[0].y * k - (L.asc * k) - (lead - size) / 2 : 0;
    Object.assign(ta.style, {
      left: Editor.gx(g) + it.x * k + 'px',
      top: g.oy + it.y * k + 'px',
      width: Math.max(40, it.w * k) + 'px',
      height: Math.max(lead * 1.5, it.h * k) + 'px',
      transform: it.rot ? `rotate(${it.rot}deg)` : '',
      fontFamily: f ? `'${f.cssName}'` : 'sans-serif',
      fontSize: size + 'px',
      lineHeight: lead + 'px',
      letterSpacing: ((st.tracking || 0) / 1000) * size + 'px',
      textAlign: st.align === 'justify' ? 'justify' : st.align,
      color: Color.css(Model.resolveColor(doc, st.color) || { c: 0, m: 0, y: 0, k: 100 }),
      paddingTop: Math.max(0, firstTop) + 'px',
      textIndent: '0',
    });
    Editor.board.appendChild(ta);
    Editor.render();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('input', () => {
      it.text = ta.value;
      Layout.invalidate();
      App.markDirty();
      Panels.refreshLayers();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
        e.preventDefault();
        finish();
      }
    });
    ta.addEventListener('blur', () => setTimeout(() => ta && document.activeElement !== ta && finish(), 0));
  }
  function finish() {
    if (!ta) return;
    const t = ta;
    ta = null;
    t.remove();
    App.S.editing = null;
    cur = null;
    Layout.invalidate();
    App.history.commit('Type');
    App.render();
  }
  return { edit, finish, get active() { return !!ta; } };
})();

/* The Story window: the whole text of a box and everything it continues into. */
const Story = (() => {
  let m = null;
  function open(it) {
    const { doc } = App.S;
    const head = Model.chainOf(doc, it.id)[0].it;
    if (m) m.close();
    App.history.begin();
    m = openModal({
      title: 'Story',
      cls: 'story',
      body: `<p class="muted">All the text in this box and the boxes it continues into. Type here and the pages update as you go. A line with just --- moves the rest on to the next box${head.emptyLines === 'break' ? ', and so does an empty line' : ''}.</p>
        <textarea class="story-text" spellcheck="true"></textarea>
        <div class="modal-actions"><span class="muted story-info"></span><button class="btn btn-accent" data-a="done">Done</button></div>`,
      onClose: () => {
        m = null;
        App.history.commit('Type');
        App.render();
      },
    });
    const ta = $('.story-text', m.el);
    ta.value = head.text || '';
    const info = () => {
      const chain = Model.chainOf(doc, head.id);
      const last = chain[chain.length - 1].it;
      const L = Layout.box(doc, last, null);
      const words = (head.text || '').split(/\r?\n/).filter((l) => !Layout.isBreak(l)).join(' ').trim().split(/\s+/).filter(Boolean).length;
      $('.story-info', m.el).textContent = `${chain.length} box${chain.length === 1 ? '' : 'es'} · ${words} words${L.overflow ? ' · more text than fits' : ''}`;
    };
    info();
    const upd = debounce(() => {
      head.text = ta.value;
      Layout.invalidate();
      App.markDirty();
      Editor.render();
      // Redraw the thumbnails the text shows on: every page it runs through (every cover page,
      // if it's on the cover).
      for (const { s } of Model.chainOf(doc, head.id)) {
        if (s.kind === 'cover') Model.coverSurfaces(doc).forEach((c) => Panels.invalidateThumbs(c));
        else for (const x of Editor.spreadSurfaces(doc, s)) Panels.invalidateThumbs(x);
      }
      Panels.refreshThumbsSoon();
      info();
    }, 150);
    ta.addEventListener('input', upd);
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    $('[data-a="done"]', m.el).onclick = () => (upd.flush(), m.close());
    setTimeout(() => ta.focus(), 0);
  }
  return { open };
})();
