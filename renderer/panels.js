/* The side panels. Left: Pages (with masters and the cover) and Layers. Right: Properties,
   Colours & styles, Brand kit and Check (preflight). */
const Panels = (() => {
  const S = () => App.S;
  const thumbs = new Map(); // surface key -> canvas
  const dirtyThumbs = new Set();
  let allThumbsDirty = true;
  const skey = (s) => (s.kind === 'page' ? 'p' + S().doc.pages[s.idx]?.id : s.kind === 'master' ? `m${s.id}${s.side}` : `cover${Model.isInside(s) ? '-inside' : ''}${s.part ? '-' + s.part : ''}`);

  function init() {
    $('#left-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      S().leftTab = b.dataset.tab;
      renderLeft();
    });
    $('#right-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      S().rightTab = b.dataset.tab;
      renderRight();
    });
    $('#left-body').addEventListener('click', onLeftClick);
    $('#left-body').addEventListener('contextmenu', onLeftContext);
    $('#left-body').addEventListener('dblclick', onLeftDbl);
    const rb = $('#right-body');
    rb.addEventListener('click', onLayerClick);
    rb.addEventListener('contextmenu', onLayerContext);
    rb.addEventListener('dblclick', onLayerDbl);
    layersDnD();
    rb.addEventListener('change', onFieldChange);
    rb.addEventListener('keydown', onFieldKey);
    rb.addEventListener('click', onRightClick);
    rb.addEventListener('contextmenu', onRightContext);
    ItemFX.bind(rb); // the Effects list of groups, text and shapes
    rightResize();
  }

  /* ---------- the right-hand panel's width ----------
     Drag its left edge to make it wider or narrower (double-click the edge to go back). Its
     contents stretch to fit, and the pages get the rest. The width is remembered. */
  const RIGHT_W = 320;
  const rightLimits = () => [300, Math.max(300, Math.min(720, Math.round(innerWidth * 0.5)))];
  function setRightWidth(w) {
    const [lo, hi] = rightLimits();
    const v = Math.round(clamp(w, lo, hi));
    $('#work').style.setProperty('--right-w', v + 'px');
    return v;
  }
  function rightResize() {
    const right = $('#right');
    const h = document.createElement('div');
    h.className = 'right-resize';
    h.title = 'Drag to make this panel wider or narrower. Double-click to put it back.';
    right.appendChild(h);
    setRightWidth(App.S.settings.rightWidth || RIGHT_W);
    const save = (w) => ep.settings.set({ rightWidth: w }).then((s) => (App.S.settings = s));
    let drag = null;
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, w: right.getBoundingClientRect().width };
      document.body.classList.add('resizing-panel');
    });
    h.addEventListener('pointermove', (e) => {
      if (drag) drag.now = setRightWidth(drag.w + (drag.x - e.clientX));
    });
    const end = () => {
      if (!drag) return;
      document.body.classList.remove('resizing-panel');
      if (drag.now) save(drag.now);
      drag = null;
      // The pages get the space that's left: fit them to it.
      if (S().doc) requestAnimationFrame(() => Editor.fit());
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', () => {
      save(setRightWidth(RIGHT_W));
      if (S().doc) requestAnimationFrame(() => Editor.fit());
    });
    // A smaller window can't keep a panel wider than half of it.
    window.addEventListener('resize', () => setRightWidth(App.S.settings.rightWidth || RIGHT_W));
  }

  function render() {
    renderLeft();
    renderRight();
  }

  /* ================= LEFT ================= */
  function renderLeft() {
    $$('#left-tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'pages'));
    renderPages();
  }

  // 'inside' / 'outside' (or nothing), and optionally 'front' / 'back' for single cover pages.
  const coverFromKey = (a, b) => ({ kind: 'cover', ...(a === 'inside' ? { side: 'inside' } : {}), ...(b ? { part: b } : {}) });
  /* Thumbnails are redrawn quietly: a change marks them out of date, and they're drawn again
     one at a time while the app is idle, the ones you can see first. Until then each keeps its
     old picture (a new page starts blank). So a change never waits for every thumbnail. */
  const thumbWidth = (s) => (Model.isCoverPage(s) ? 96 : s.kind === 'cover' ? 200 : 76);
  const queue = new Map(); // key -> surface, waiting to be drawn
  const holders = new Map(); // key -> the element on screen that shows it
  function thumbFor(s) {
    const key = skey(s);
    if (allThumbsDirty || dirtyThumbs.has(key) || !thumbs.has(key)) {
      queue.set(key, s);
      dirtyThumbs.delete(key);
      if (!thumbs.has(key)) {
        // Blank, the page's shape, until it's drawn.
        const sz = Model.surfaceSize(S().doc, s);
        const c = document.createElement('canvas');
        c.width = thumbWidth(s);
        c.height = Math.max(1, Math.round((c.width * sz.h) / sz.w));
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        c.className = 'thumb-canvas';
        thumbs.set(key, c);
      }
      drawThumbsSoon();
    }
    return thumbs.get(key);
  }
  let idleId = 0;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 60));
  function drawThumbsSoon() {
    if (!idleId) idleId = idle(drawSomeThumbs, { timeout: 600 });
  }
  function drawSomeThumbs(deadline) {
    idleId = 0;
    const doc = S().doc;
    if (!doc || !queue.size) return;
    // The ones you can see first.
    const host = $('#left-body');
    const hr = host.getBoundingClientRect();
    const seen = (key) => {
      const el = holders.get(key);
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > hr.top && r.top < hr.bottom;
    };
    let done = 0;
    while (queue.size && (done === 0 || deadline.timeRemaining() > 12)) {
      const key = [...queue.keys()].find(seen) || queue.keys().next().value;
      const s = queue.get(key);
      queue.delete(key);
      if (s.kind === 'page' && !doc.pages[s.idx]) continue;
      const c = Render.thumb(doc, s, thumbWidth(s));
      c.className = 'thumb-canvas';
      const old = thumbs.get(key);
      thumbs.set(key, c);
      if (old && old.parentNode) old.replaceWith(c);
      done++;
    }
    if (queue.size) drawThumbsSoon();
  }
  function invalidateThumbs(surface) {
    if (!surface || surface.kind === 'master') allThumbsDirty = true;
    else dirtyThumbs.add(skey(surface));
  }
  const refreshThumbsSoon = debounce(() => {
    renderPages();
  }, 350);

  function renderPages() {
    const { doc, surface } = S();
    const host = $('#left-body');
    const st = host.scrollTop;
    const cur = (s) => Model.sameSurface(s, surface) || (surface.kind === 'master' && s.kind === 'master' && s.id === surface.id);
    let html = `<div class="pp-head"><h4>Pages <span class="muted">${doc.pages.length}</span></h4><button class="btn btn-sm" data-act="add-page" title="Add a page after this one">+ Page</button></div><div class="spreads">`;
    Model.spreads(doc).forEach((sp) => {
      const solo = doc.facing && sp.length === 1 ? (Model.side(doc, sp[0]) === 'right' ? ' solo-right' : ' solo-left') : '';
      html += `<div class="spread${doc.facing ? ' facing' : ''}${solo}">`;
      for (const idx of sp) {
        const p = doc.pages[idx];
        const m = Model.master(doc, p.master);
        html += `<div class="thumb${cur({ kind: 'page', idx }) ? ' on' : ''}" data-page="${idx}" title="Page ${Model.pageNumber(doc, idx)}${m ? ' · ' + esc(m.name) : ''}"><div class="thumb-img" data-thumb="page:${idx}"></div><span class="thumb-num">${Model.pageNumber(doc, idx)}${m ? `<em>${esc(m.name[0])}</em>` : ''}</span></div>`;
      }
      html += '</div>';
    });
    html += `</div><div class="pp-head"><h4>Masters</h4><button class="btn btn-sm" data-act="add-master">+ Master</button></div><p class="hint">Things on a master show on every page that uses it, like page numbers.</p><div class="masters">`;
    for (const m of doc.masters) {
      html += `<div class="master-row${surface.kind === 'master' && surface.id === m.id ? ' on' : ''}" data-master="${m.id}"><div class="spread${doc.facing ? ' facing' : ''}">${doc.facing ? `<div class="thumb"><div class="thumb-img" data-thumb="master:${m.id}:left"></div></div>` : ''}<div class="thumb"><div class="thumb-img" data-thumb="master:${m.id}:right"></div></div></div><span class="master-name">${esc(m.name)}</span></div>`;
    }
    html += '</div>';
    if (doc.facing || doc.kind === 'book') {
      html += `<div class="pp-head"><h4>Cover</h4><label class="switch"><input type="checkbox" data-act="toggle-cover" ${doc.cover.enabled ? 'checked' : ''}><span>Make a cover</span></label></div>`;
      if (doc.cover.enabled) {
        const c = Model.cover(doc);
        const inside = Model.isInside(surface);
        const single = Model.isSingle(doc);
        html += `<div class="seg seg-xs cover-layout" data-cover-layout><button data-v="spread" class="${single ? '' : 'on'}" title="Back, spine and front as one page">Spread</button><button data-v="single" class="${single ? 'on' : ''}" title="Front and back as separate pages">Single pages</button></div>`;
        if (!single) {
          html += `<div class="cover-row${surface.kind === 'cover' && !inside ? ' on' : ''}" data-cover="outside"><div class="thumb-img" data-thumb="cover"></div><span class="muted">Back, spine ${c.spine.toFixed(1)} mm, front</span></div>`;
          html += `<label class="switch cover-inside-switch"><input type="checkbox" data-act="toggle-inside" ${doc.cover.inside.enabled ? 'checked' : ''}><span>Print the inside too</span></label>`;
          if (doc.cover.inside.enabled) html += `<div class="cover-row${inside ? ' on' : ''}" data-cover="inside"><div class="thumb-img" data-thumb="cover:inside"></div><span class="muted">Inside front, inside back</span></div>`;
        } else {
          // One thumbnail per cover page, in the order they export.
          html += `<label class="switch cover-inside-switch"><input type="checkbox" data-act="toggle-inside" ${doc.cover.inside.enabled ? 'checked' : ''}><span>Print the inside too</span></label><div class="cover-pages">`;
          for (const s of Model.coverSurfaces(doc)) {
            const key = `${Model.isInside(s) ? 'inside' : 'outside'}:${s.part}`;
            html += `<div class="cover-row cover-page${Model.sameSurface(s, surface) ? ' on' : ''}" data-cover="${key}"><div class="thumb-img" data-thumb="cover:${key}"></div><span class="muted">${esc(Model.surfaceName(doc, s))}</span></div>`;
          }
          html += '</div>';
        }
      }
    }
    host.innerHTML = html;
    for (const el of $$('[data-thumb]', host)) {
      const [kind, a, b] = el.dataset.thumb.split(':');
      const s = kind === 'page' ? { kind, idx: +a } : kind === 'master' ? { kind, id: a, side: b } : coverFromKey(a, b);
      holders.set(skey(s), el);
      el.appendChild(thumbFor(s));
    }
    allThumbsDirty = false;
    host.scrollTop = st;
  }

  function onLeftClick(e) {
    const { doc } = S();
    const lay = e.target.closest('[data-cover-layout] [data-v]');
    if (lay) return App.setCoverLayout(lay.dataset.v);
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'add-page') return App.pageOp('add-after');
      if (a === 'add-master') return App.change('New master', () => {
        const id = uid('m');
        const letter = String.fromCharCode(65 + doc.masters.length);
        doc.masters.push({ id, name: `${letter}-Master`, left: [], right: [] });
        App.goTo({ kind: 'master', id, side: 'right' });
      }, { thumbs: 'all' });
      if (a === 'toggle-cover') return App.change(act.checked ? 'Add cover' : 'Remove cover', () => {
        doc.cover.enabled = act.checked;
        if (!act.checked && S().surface.kind === 'cover') App.goTo({ kind: 'page', idx: 0 });
      }, { thumbs: 'all' });
      if (a === 'toggle-inside') return App.change(act.checked ? 'Add inside cover' : 'Remove inside cover', () => {
        // Switching it off keeps what's on it, ready if it's switched back on.
        doc.cover.inside.enabled = act.checked;
        App.goTo(act.checked ? { kind: 'cover', side: 'inside' } : { kind: 'cover' });
      }, { thumbs: 'all' });
      return;
    }
    const t = e.target.closest('[data-page]');
    if (t) return App.goTo({ kind: 'page', idx: +t.dataset.page });
    const m = e.target.closest('[data-master]');
    if (m) {
      const side = e.target.closest('.thumb') && doc.facing && e.target.closest('.thumb') === $$('.thumb', m)[0] ? 'left' : 'right';
      return App.goTo({ kind: 'master', id: m.dataset.master, side });
    }
    const cv = e.target.closest('[data-cover]');
    if (cv) {
      const [a, b] = cv.dataset.cover.split(':');
      return App.goTo(coverFromKey(a, b));
    }
  }
  /* ---------- Layers (in the right panel, next to Properties) ---------- */
  function onLayerClick(e) {
    const { doc } = S();
    // A group's folder row: open or close it, hide or lock all of it, or pick the whole group.
    const grow = e.target.closest('[data-group-row]');
    if (grow) {
      const gid = grow.dataset.groupRow;
      const members = Model.groupMembers(Model.surfaceItems(doc, S().surface), gid);
      if (e.target.closest('[data-fold]')) {
        closedGroups.has(gid) ? closedGroups.delete(gid) : closedGroups.add(gid);
        return renderLayers();
      }
      const gt = e.target.closest('[data-gtog]');
      if (gt) {
        const k = gt.dataset.gtog;
        const to = !members.every((m) => m[k]);
        return App.change(k === 'hidden' ? (to ? 'Hide group' : 'Show group') : to ? 'Lock group' : 'Unlock group', () => members.forEach((m) => (m[k] = to)));
      }
      S().inGroup = null;
      const ids = members.map((m) => m.id);
      if (e.shiftKey || e.ctrlKey) {
        const sel = S().sel;
        const on = !ids.every((id) => sel.has(id));
        ids.forEach((id) => (on ? sel.add(id) : sel.delete(id)));
        return App.selectionChanged();
      }
      return App.select(ids);
    }
    const row = e.target.closest('[data-layer]');
    if (row) {
      const id = row.dataset.layer;
      const tog = e.target.closest('[data-tog]');
      if (tog) {
        const it = Model.findItem(doc, id)?.item;
        if (!it) return;
        return App.change(tog.dataset.tog === 'hidden' ? (it.hidden ? 'Show' : 'Hide') : it.locked ? 'Unlock' : 'Lock', () => (it[tog.dataset.tog] = !it[tog.dataset.tog]));
      }
      // A box inside a group, picked in Layers: you're in the group, working on just that box.
      const it = Model.findItem(doc, id, S().surface)?.item;
      if (e.shiftKey || e.ctrlKey) {
        const sel = S().sel;
        sel.has(id) ? sel.delete(id) : sel.add(id);
        App.selectionChanged();
      } else {
        S().inGroup = it && it.group ? it.group : null;
        App.select([id]);
      }
    }
  }
  function onLayerDbl(e) {
    const { doc } = S();
    const grow = e.target.closest('[data-group-row]');
    if (grow && !e.target.closest('[data-fold], [data-gtog]')) {
      const g = doc.groups[grow.dataset.groupRow];
      if (g) prompt('Group name', g.name).then((v) => v && v.trim() && App.change('Rename group', () => (g.name = v.trim())));
      return;
    }
    const row = e.target.closest('[data-layer]');
    if (row) {
      const it = Model.findItem(doc, row.dataset.layer)?.item;
      if (it) prompt('Name', it.name || Model.itemLabel(it)).then((v) => v != null && App.change('Rename', () => (it.name = v.trim())));
    }
  }
  function onLayerContext(e) {
    const grow = e.target.closest('[data-group-row]');
    if (grow) {
      e.preventDefault();
      const { doc } = S();
      const gid = grow.dataset.groupRow;
      const ids = Model.groupMembers(Model.surfaceItems(doc, S().surface), gid).map((m) => m.id);
      if (!ids.every((id) => S().sel.has(id))) (S().inGroup = null), App.select(ids);
      const g = doc.groups[gid];
      return contextMenu(e.clientX, e.clientY, [
        { label: 'Rename group…', run: () => g && prompt('Group name', g.name).then((v) => v && v.trim() && App.change('Rename group', () => (g.name = v.trim()))) },
        { label: 'Ungroup', key: 'Ctrl+Shift+G', run: () => App.cmd('ungroup') },
        '-',
        { label: 'Duplicate', key: 'Ctrl+D', run: () => App.cmd('duplicate') },
        { label: 'Delete', key: 'Del', run: () => App.cmd('delete') },
      ]);
    }
    const row = e.target.closest('[data-layer]');
    if (row) {
      e.preventDefault();
      if (!S().sel.has(row.dataset.layer)) App.select([row.dataset.layer]);
      Editor.stage.dispatchEvent(new MouseEvent('contextmenu', { clientX: e.clientX, clientY: e.clientY, bubbles: true }));
    }
  }
  function onLeftDbl(e) {
    const { doc } = S();
    const m = e.target.closest('.master-name');
    if (m) {
      const ms = Model.master(doc, m.closest('[data-master]').dataset.master);
      prompt('Master name', ms.name).then((v) => v && App.change('Rename master', () => (ms.name = v.trim())));
    }
  }
  function onLeftContext(e) {
    const { doc } = S();
    const t = e.target.closest('[data-page]');
    if (t) {
      e.preventDefault();
      const idx = +t.dataset.page;
      App.goTo({ kind: 'page', idx });
      const p = doc.pages[idx];
      contextMenu(e.clientX, e.clientY, [
        { label: 'Add a page after', run: () => App.pageOp('add-after') },
        { label: 'Add a page before', run: () => App.pageOp('add-before') },
        { label: 'Duplicate page', run: () => App.pageOp('duplicate') },
        { label: 'Move earlier', disabled: idx === 0, run: () => App.pageOp('earlier') },
        { label: 'Move later', disabled: idx === doc.pages.length - 1, run: () => App.pageOp('later') },
        '-',
        ...doc.masters.map((m) => ({ label: `${p.master === m.id ? '✓ ' : ''}Use ${m.name}`, run: () => App.change('Apply master', () => (p.master = m.id), { thumbs: 'all' }) })),
        { label: `${!p.master ? '✓ ' : ''}No master`, run: () => App.change('Apply master', () => (p.master = null), { thumbs: 'all' }) },
        { label: p.hideMaster ? 'Show master items' : 'Hide master items on this page', run: () => App.change('Master items', () => (p.hideMaster = !p.hideMaster), { thumbs: 'all' }) },
        '-',
        { label: 'Delete page', disabled: doc.pages.length < 2, run: () => App.pageOp('delete') },
      ]);
      return;
    }
    const m = e.target.closest('[data-master]');
    if (m) {
      e.preventDefault();
      const ms = Model.master(doc, m.dataset.master);
      contextMenu(e.clientX, e.clientY, [
        { label: 'Rename…', run: () => prompt('Master name', ms.name).then((v) => v && App.change('Rename master', () => (ms.name = v.trim()))) },
        { label: 'Apply to every page', run: () => App.change('Apply master', () => doc.pages.forEach((p) => (p.master = ms.id)), { thumbs: 'all' }) },
        { label: 'Delete master', disabled: doc.masters.length < 2, run: () => App.change('Delete master', () => {
          doc.masters = doc.masters.filter((x) => x.id !== ms.id);
          doc.pages.forEach((p) => p.master === ms.id && (p.master = null));
          if (S().surface.kind === 'master') App.goTo({ kind: 'page', idx: 0 });
        }, { thumbs: 'all' }) },
      ]);
    }
  }

  const ICON = { text: 'T', image: '▣', rect: '■', ellipse: '●', line: '╱', barcode: '▥' };
  // Groups whose folder is closed in Layers (open is the usual; this lasts while Endpaper is open).
  const closedGroups = new Set();
  const openGroup = (gid) => gid && closedGroups.delete(gid);
  function renderLayers() {
    const { doc, surface, sel } = S();
    const items = Model.surfaceItems(doc, surface).filter((it) => Model.onSurface(doc, surface, it));
    let html = `<div class="pp-head"><h4>Layers</h4><span class="muted">Top first. Drag to reorder.</span></div><div class="layers">`;
    const row = (it, inGroup) => `<div class="layer${sel.has(it.id) ? ' on' : ''}${it.hidden ? ' is-hidden' : ''}${inGroup ? ' in-group' : ''}" draggable="true" data-layer="${it.id}">
        <button class="tog" data-tog="hidden" title="${it.hidden ? 'Show' : 'Hide'}">${it.hidden ? '◌' : '◉'}</button>
        <button class="tog" data-tog="locked" title="${it.locked ? 'Unlock' : 'Lock'}">${it.locked ? '🔒' : '·'}</button>
        <span class="lic">${ICON[it.type]}</span><span class="lname">${esc(Model.itemLabel(it))}</span>${PhotoFX.active(it.effects).length ? '<span class="fx-tag" title="This has effects">fx</span>' : ''}</div>`;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it.group) {
        html += row(it, false);
        continue;
      }
      // A group: its folder row, then (open) its boxes, top first. They always sit together.
      const gid = it.group;
      const members = [];
      while (i >= 0 && items[i].group === gid) members.push(items[i--]);
      i++;
      const open = !closedGroups.has(gid);
      const allHidden = members.every((m) => m.hidden), allLocked = members.every((m) => m.locked);
      const on = members.every((m) => sel.has(m.id));
      html += `<div class="layer layer-group${on ? ' on' : ''}${allHidden ? ' is-hidden' : ''}" draggable="true" data-group-row="${gid}">
        <button class="tog" data-gtog="hidden" title="${allHidden ? 'Show the group' : 'Hide the group'}">${allHidden ? '◌' : '◉'}</button>
        <button class="tog" data-gtog="locked" title="${allLocked ? 'Unlock the group' : 'Lock the group'}">${allLocked ? '🔒' : '·'}</button>
        <button class="lfold" data-fold title="${open ? 'Close' : 'Open'}">${open ? '▾' : '▸'}</button><span class="lic">📁</span><span class="lname">${esc((doc.groups[gid] && doc.groups[gid].name) || 'Group')}</span>${doc.groups[gid] && ItemFX.hasAny(doc.groups[gid].effects) ? '<span class="fx-tag" title="This group has effects">fx</span>' : ''}<em class="muted">${members.length}</em></div>`;
      if (open) for (const m of members) html += row(m, true);
    }
    if (!items.length) html += '<p class="hint">Nothing on this page yet. Pick a tool at the top and drag on the page.</p>';
    if (surface.kind === 'page') {
      const mi = Model.masterItems(doc, surface.idx);
      if (mi.length) {
        const m = Model.master(doc, doc.pages[surface.idx].master);
        html += `<div class="layer-sep">From ${esc(m.name)}</div>`;
        for (let i = mi.length - 1; i >= 0; i--) html += `<div class="layer from-master"><span class="lic">${ICON[mi[i].type]}</span><span class="lname">${esc(Model.itemLabel(mi[i]))}</span></div>`;
      }
    }
    const host = $('#right-body');
    const st = host.scrollTop;
    host.innerHTML = html + '</div>';
    host.scrollTop = st;
  }
  const refreshLayers = debounce(() => (S().rightTab === 'layers' ? renderLayers() : null), 200);

  function layersDnD() {
    const host = $('#right-body');
    // What's being dragged: a box ({ id }) or a whole group ({ gid }).
    let dragging = null;
    const rowOf = (e) => e.target.closest('[data-layer], [data-group-row]');
    host.addEventListener('dragstart', (e) => {
      const r = rowOf(e);
      if (!r) return;
      dragging = r.dataset.groupRow ? { gid: r.dataset.groupRow } : { id: r.dataset.layer };
      e.dataTransfer.effectAllowed = 'move';
    });
    host.addEventListener('dragover', (e) => {
      if (!dragging) return;
      const r = rowOf(e);
      if (!r) return;
      e.preventDefault();
      $$('.layer.drop-above, .layer.drop-below', host).forEach((x) => x.classList.remove('drop-above', 'drop-below'));
      const above = e.offsetY < r.clientHeight / 2;
      r.classList.add(above ? 'drop-above' : 'drop-below');
    });
    host.addEventListener('drop', (e) => {
      const r = rowOf(e);
      const d = dragging;
      dragging = null;
      if (!d || !r) return;
      e.preventDefault();
      const above = r.classList.contains('drop-above');
      const tGroup = r.dataset.groupRow || null; // dropped on a group's folder row
      const tId = r.dataset.layer || null;
      if ((d.id && d.id === tId) || (d.gid && d.gid === tGroup)) return;
      App.change('Reorder', () => {
        const list = Model.surfaceItems(S().doc, S().surface);
        const moving = d.gid ? list.filter((x) => x.group === d.gid) : list.filter((x) => x.id === d.id);
        if (!moving.length) return;
        const rest = list.filter((x) => !moving.includes(x));
        // Where it lands. The list is shown top first, so "above" means later in the array.
        let at;
        let join = null; // a box dropped among a group's boxes joins that group
        if (tGroup) {
          const members = rest.filter((x) => x.group === tGroup);
          if (!members.length) return;
          at = above ? rest.indexOf(members[members.length - 1]) + 1 : rest.indexOf(members[0]);
          // Just under an open group's folder row is inside it, at the top.
          if (!above && d.id && !closedGroups.has(tGroup)) (at = rest.indexOf(members[members.length - 1]) + 1), (join = tGroup);
        } else {
          const t = rest.find((x) => x.id === tId);
          if (!t) return;
          at = rest.indexOf(t) + (above ? 1 : 0);
          if (t.group && t.group !== d.gid && d.id) join = t.group;
        }
        rest.splice(at, 0, ...moving);
        if (d.id) {
          const it = moving[0];
          if (join) it.group = join;
          else delete it.group;
        }
        list.splice(0, list.length, ...rest);
        Model.tidyGroups(list);
      });
    });
    host.addEventListener('dragend', () => (dragging = null));
  }

  /* ================= RIGHT ================= */
  function renderRight() {
    const tab = S().rightTab || 'props';
    $$('#right-tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'props') renderProps();
    else if (tab === 'layers') renderLayers();
    else if (tab === 'colours') renderColours();
    else if (tab === 'brand') renderBrand();
    else renderCheck();
    updateCheckBadge();
  }

  /* ---------- fields ---------- */
  const U = () => App.unit();
  const len = (label, f, v, o = {}) =>
    `<label class="field ${o.cls || ''}"><span>${label}</span><input class="input" data-f="${f}" data-kind="len" value="${Units.fmt(v, U(), S().doc.dpi)}"${o.dis ? ' disabled' : ''}><em>${U()}</em></label>`;
  const num = (label, f, v, unit = '', kind = 'num', o = {}) =>
    `<label class="field ${o.cls || ''}"><span>${label}</span><input class="input" data-f="${f}" data-kind="${kind}" value="${v == null ? '' : Number(Number(v).toFixed(4))}"${o.dis ? ' disabled' : ''}><em>${unit}</em></label>`;
  const colorBtn = (label, f, c, allowNone = true) =>
    `<div class="field"><span>${label}</span><button class="color-btn" data-color="${f}" data-none="${allowNone ? 1 : 0}"><i style="background:${c ? Color.css(Model.resolveColor(S().doc, c)) : 'transparent'}" class="${c ? '' : 'none'}"></i><b>${esc(Model.colorName(S().doc, c))}</b></button></div>`;
  const seg = (f, v, opts) => `<div class="seg" data-seg="${f}">${opts.map(([val, lab, t]) => `<button class="${val === v ? 'on' : ''}" data-v="${val}" title="${esc(t || lab)}">${lab}</button>`).join('')}</div>`;
  function fontPicker(path) {
    const fams = Fonts.families();
    const info = Fonts.info(path);
    const fam = info ? info.family : null;
    const styles = fam ? fams.find(([f]) => f === fam)?.[1] || [] : [];
    return `<div class="field field-wide"><span>Font</span><select class="input" data-font="family">${!info ? `<option selected>${path === '' ? 'Mixed' : 'Missing font'}</option>` : ''}${fams.map(([f]) => `<option ${f === fam ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
      <div class="field field-wide"><span>Style</span><select class="input" data-font="style">${styles.map((s) => `<option value="${esc(s.path)}" ${s.path.toLowerCase() === (path || '').toLowerCase() ? 'selected' : ''}>${esc(s.style)}</option>`).join('')}</select></div>`;
  }

  function renderProps() {
    const items = Editor.selectedItems();
    const { surface } = S();
    let html = '';
    if (items.length === 1) html = itemProps(items[0]);
    else if (items.length > 1) html = multiProps(items);
    else html = surface.kind === 'cover' ? coverProps() : docProps();
    $('#right-body').innerHTML = html;
    ItemFX.mount($('#right-body')); // texture grids and curves in the Effects list
  }
  const refreshGeometry = debounce(() => {
    if ((S().rightTab || 'props') !== 'props') return;
    const items = Editor.selectedItems();
    if (items.length !== 1) return;
    const it = items[0];
    for (const f of ['x', 'y', 'w', 'h']) {
      const el = $(`#right-body [data-f="${f}"]`);
      if (el && document.activeElement !== el) el.value = Units.fmt(it[f], U(), S().doc.dpi);
    }
    const r = $('#right-body [data-f="rot"]');
    if (r && document.activeElement !== r) r.value = it.rot || 0;
    const ppi = $('#right-body .ppi');
    if (ppi && it.type === 'image') ppi.outerHTML = ppiTag(it);
  }, 30);

  const ppiTag = (it) => {
    const p = Math.round(Render.ppi(it));
    const cls = p < 200 ? 'bad' : p < 280 ? 'warn' : 'ok';
    return `<span class="ppi ${cls}" title="Effective resolution at this size">${p} ppi${cls === 'ok' ? '' : cls === 'bad' ? ' · too low' : ' · a bit low'}</span>`;
  };

  function itemProps(it) {
    const { doc } = S();
    let h = `<section><h5>${esc(Model.typeName[it.type])}${it.locked ? ' <span class="tag">Locked</span>' : ''}</h5>
      <div class="grid2">${len('X', 'x', it.x)}${len('Y', 'y', it.y)}${it.type === 'barcode' ? '' : len('W', 'w', it.w)}${it.type === 'line' || it.type === 'barcode' ? '' : len('H', 'h', it.h)}${num('Rotate', 'rot', it.rot || 0, '°')}${num('Opacity', 'opacity', Math.round((it.opacity ?? 1) * 100), '%')}</div></section>`;
    if (it.masterRef) {
      const p = S().surface.kind === 'page' && doc.pages[S().surface.idx];
      const ms = p && Model.master(doc, p.master);
      h += `<section><h5>From the master</h5><p class="hint">This page's own copy of a box on ${esc(ms ? ms.name : 'its master')}. What you change here is just for this page; anything you leave alone (like where it sits) still follows the master.</p><div class="btn-row"><button class="btn btn-sm" data-act="reset-master">Reset to master</button></div></section>`;
    }
    if (it.type === 'text') h += textSection([it]);
    if (it.type === 'image') {
      const a = doc.assets[it.asset];
      h += `<section><h5>Photo</h5>
        ${a ? `<p class="file-line">${esc(a.name)} · ${a.w} × ${a.h} px ${ppiTag(it)}</p>` : '<p class="hint">No photo yet.</p>'}
        <div class="btn-row"><button class="btn btn-sm" data-act="replace-photo">${a ? 'Replace…' : 'Choose photo…'}</button>${a ? `<button class="btn btn-sm" data-act="crop">Adjust</button>` : ''}</div>
        ${a ? `<div class="field field-wide"><span>Fit</span><div class="btn-row fit-btns"><button class="btn btn-sm" data-act="fit-fill" title="Make the photo fill the frame, centred (its edges may be cropped)">Fill frame</button><button class="btn btn-sm" data-act="fit-fit" title="Fit all of the photo inside the frame, centred">Fit in frame</button></div></div>
        <div class="field field-wide"><span>Zoom</span><input type="range" min="20" max="400" value="${Math.round((it.s / ((d) => Math.max(it.w / d.w, it.h / d.h))(PhotoEdit.dims(it, a))) * 100)}" data-range="zoom"></div>` : ''}
        ${colorBtn('Border', 'stroke', it.stroke)}${it.stroke ? `<div class="grid2">${len('Border', 'strokeW', it.strokeW)}</div>` : ''}
      </section>`;
      if (a) h += `<section><h5>Effects</h5>${PhotoEdit.propsHtml(it)}</section>`;
    }
    if (it.type === 'rect' || it.type === 'ellipse') {
      h += `<section><h5>Colour</h5>${colorBtn('Fill', 'fill', it.fill)}${colorBtn('Border', 'stroke', it.stroke)}
        <div class="grid2">${it.stroke ? len('Border', 'strokeW', it.strokeW) : ''}${it.type === 'rect' ? len('Corners', 'radius', it.radius || 0) : ''}</div></section>`;
    }
    if (it.type === 'line') h += `<section><h5>Line</h5>${colorBtn('Colour', 'stroke', it.stroke, false)}<div class="grid2">${len('Weight', 'strokeW', it.strokeW)}</div></section>`;
    // Effects on a text box or shape (a photo's are in Edit photo).
    if (it.type === 'barcode') h += barcodeSection(it);
    if (it.type !== 'image' && it.type !== 'barcode') h += `<section><h5>Effects</h5>${ItemFX.panelHtml(doc, 'i:' + it.id)}</section>`;
    h += `<section><div class="btn-row"><button class="btn btn-sm" data-act="lock">${it.locked ? 'Unlock' : 'Lock'}</button><button class="btn btn-sm" data-act="duplicate">Duplicate</button><button class="btn btn-sm btn-danger-ghost" data-act="delete">Delete</button></div></section>`;
    return h;
  }


  // An ISBN barcode: whose ISBN, the price code, and its size (80% to 200% of the standard).
  function barcodeSection(it) {
    const { doc } = S();
    const v = Barcode.isbnOf(doc, it);
    const p = Barcode.parse(v);
    const pct = Math.round(Barcode.scaleOf(it) * 100);
    return `<section><h5>ISBN barcode</h5>
      <div class="field field-wide"><span>ISBN</span><input class="input" data-bc="isbn" value="${esc(v)}" placeholder="978-…" spellcheck="false"></div>
      <p class="hint ${v && !p.ok ? 'bad' : ''}">${!v ? 'Type the ISBN, 10 or 13 digits.' : p.ok ? `Checked: ${p.isbn ? 'ISBN ' + p.line : 'EAN ' + p.ean}.` : esc(p.error)} ${it.own ? 'This barcode has its own ISBN.' : "It's the book's ISBN, also in File, Shipment preparation."}</p>
      <label class="switch"><input type="checkbox" data-bc="own" ${it.own ? 'checked' : ''}><span>Its own ISBN, not the book's</span></label>
      <label class="switch"><input type="checkbox" data-bc="price" ${it.price ? 'checked' : ''}><span>Price code beside it</span></label>
      ${it.price ? `<div class="field field-wide"><span>Price code</span><input class="input" data-bc="priceCode" value="${esc(it.priceCode || '')}" maxlength="5" spellcheck="false"></div>
      <p class="hint ${Barcode.priceOk(it.priceCode) ? '' : 'bad'}">5 digits: the currency first (5 is US dollars), then the price, like 51299 for $12.99. 90000 means no price.</p>` : ''}
      <div class="grid2"><label class="field"><span>Size</span><input class="input" data-bc="scale" value="${pct}"><em>%</em></label></div>
      <p class="hint">80% to 200%; 100% is the standard size. Drag a corner to change it.</p></section>`;
  }
  function barcodeField(el) {
    const { doc } = S();
    const it = Editor.selectedItems()[0];
    if (!it || it.type !== 'barcode') return;
    const k = el.dataset.bc;
    // Changes that make it wider or narrower keep its right edge where it is (it usually sits
    // in the back cover's bottom-right corner).
    const resize = (fn) => {
      const right = it.x + it.w, bottom = it.y + it.h;
      fn();
      it.x = right - it.w;
      it.y = bottom - it.h;
    };
    if (k === 'isbn') return App.change('ISBN', () => (it.own ? (it.isbn = el.value.trim()) : (doc.print.isbn = el.value.trim())), { thumbs: 'all' });
    if (k === 'own') return App.change('Barcode', () => ((it.own = el.checked), el.checked && !it.isbn && (it.isbn = doc.print.isbn || '')), { thumbs: 'all' });
    if (k === 'price')
      return App.change('Price code', () =>
        resize(() => {
          const s = Barcode.scaleOf(it);
          it.price = el.checked;
          const b = Barcode.base(it);
          it.w = b.w * s;
          it.h = b.h * s;
        })
      );
    if (k === 'priceCode') return App.change('Price code', () => (it.priceCode = el.value.trim()));
    if (k === 'scale') {
      const v = parseFloat(String(el.value).replace(',', '.'));
      if (!(v > 0)) return renderProps();
      const s = clamp(v, Barcode.MIN * 100, Barcode.MAX * 100) / 100;
      return App.change('Barcode size', () =>
        resize(() => {
          const b = Barcode.base(it);
          it.w = b.w * s;
          it.h = b.h * s;
        })
      );
    }
  }

  // The Text section for one text box or several. With several, a field shows a value only when
  // all of them share it; whatever you set goes to every selected box and nothing else.
  function textSection(texts) {
    const { doc } = S();
    const it = texts[0];
    const many = texts.length > 1 ? texts.length : 0;
    // Linked text looks the way its first box says, so that's what to show.
    const chain = !many ? Model.chainOf(doc, it.id) : [];
    const linked = chain.length > 1 ? chain.length : 0;
    const sts = texts.map((x) => Model.styleOf(doc, Model.chainOf(doc, x.id)[0]?.it || x));
    const st = sts[0];
    const same = (k, d) => (sts.every((s) => (s[k] ?? d) === (st[k] ?? d)) ? st[k] ?? d : null);
    const styleIds = new Set(texts.map((x) => x.styleId || ''));
    const styleId = styleIds.size === 1 ? it.styleId : null;
    const shared = styleId && doc.styles.find((s) => s.id === styleId);
    return `<section><h5>Text${many ? ` <span class="muted">· ${many} boxes</span>` : ''}</h5>
      <div class="field field-wide"><span>Style</span><select class="input" data-style-pick="1">${styleIds.size > 1 ? '<option value="-" selected>Mixed</option>' : ''}<option value="">No style</option>${doc.styles.map((s) => `<option value="${s.id}" ${styleIds.size === 1 && s.id === it.styleId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <p class="hint">${many ? `Changes here go to the ${many} selected text boxes, and only to them.` : linked ? `This text runs through ${linked} linked boxes. Changes here go to all of it.` : 'Changes here are just for this box.'}${shared ? ` ${many ? 'Their' : 'Its'} settings started from “${esc(shared.name)}”. <a href="#" data-act="reset-style">Reset to “${esc(shared.name)}”</a>` : ''}</p>
      ${fontPicker(same('font', ''))}
      <div class="grid2">${num('Size', 's.size', same('size'), 'pt')}${num('Leading', 's.leading', same('leading'), 'pt')}${num('Tracking', 's.tracking', same('tracking', 0), '/1000')}${num('After ¶', 's.spaceAfter', same('spaceAfter', 0), 'pt')}${num('Indent', 's.indent', same('indent', 0), 'mm')}</div>
      ${colorBtn('Colour', 's.color', st.color, false)}
      <div class="field field-wide"><span>Align</span>${seg('s.align', same('align', 'left'), [['left', '⟸', 'Left'], ['center', '≡', 'Centre'], ['right', '⟹', 'Right'], ['justify', '☰', 'Justified']])}</div>
      <div class="field field-wide"><span>Vertical</span>${seg('s.valign', same('valign', 'top'), [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']])}</div>
      ${many ? '' : `<div class="btn-row"><button class="btn btn-sm" data-act="edit-text">Edit text</button><button class="btn btn-sm" data-act="story">Story…</button>${linked ? '<button class="btn btn-sm" data-act="format-story">Format story…</button>' : ''}</div>
      <div class="btn-row">${it.next ? '<button class="btn btn-sm" data-act="unlink">Stop continuing</button>' : '<button class="btn btn-sm" data-act="link">Continue in another box…</button>'}<button class="btn btn-sm" data-act="style-from">New style from this</button></div>`}
    </section>`;
  }

  function multiProps(items) {
    const gid = App.selectedGroup();
    const g = gid && S().doc.groups[gid];
    const head = g
      ? `<section><h5>Group · ${esc(g.name)} <span class="muted">· ${items.length}</span></h5>
        <p class="hint">Drag a corner to scale everything in it, text included. Double-click a box to work on it on its own.</p>
        <div class="btn-row"><button class="btn btn-sm" data-act="rename-group">Rename…</button><button class="btn btn-sm" data-act="ungroup" title="Ctrl+Shift+G">Ungroup</button></div></section>
        <section><h5>Group effects</h5><p class="hint">These go on the group as one shape: one shadow, one outline round the outside.</p>${ItemFX.panelHtml(S().doc, 'g:' + gid)}</section>`
      : `<section><div class="btn-row"><button class="btn btn-sm" data-act="group" title="Keep these together (Ctrl+G)">Group</button>${items.some((x) => x.group) ? '<button class="btn btn-sm" data-act="ungroup" title="Ctrl+Shift+G">Ungroup</button>' : ''}</div></section>`;
    return `${head}<section><h5>${items.length} selected</h5>
      <div class="field field-wide"><span>Align</span><div class="seg">
        <button data-align="left" title="Left edges">⇤</button><button data-align="hcenter" title="Centres">↔</button><button data-align="right" title="Right edges">⇥</button>
        <button data-align="top" title="Tops">⤒</button><button data-align="vcenter" title="Middles">↕</button><button data-align="bottom" title="Bottoms">⤓</button></div></div>
      ${items.length > 2 ? `<div class="field field-wide"><span>Spread out</span><div class="seg"><button data-align="dist-h">Across</button><button data-align="dist-v">Down</button></div></div>` : ''}
      <div class="grid2">${num('Opacity', 'opacity', Math.round((items[0].opacity ?? 1) * 100), '%')}</div>
      <div class="btn-row"><button class="btn btn-sm" data-act="duplicate">Duplicate</button><button class="btn btn-sm btn-danger-ghost" data-act="delete">Delete</button></div></section>
      ${PhotoEdit.multiHtml(items)}
      ${items.some((x) => x.type === 'text') ? textSection(items.filter((x) => x.type === 'text')) : ''}`;
  }

  function docProps() {
    const { doc, surface } = S();
    const sideNames = doc.facing ? ['Inside', 'Outside'] : ['Left', 'Right'];
    let h = `<section><h5>Document</h5>
      <div class="field field-wide"><span>Name</span><input class="input" data-f="d.name" data-kind="text" value="${esc(doc.name)}"></div>
      <div class="field field-wide"><span>Size</span><select class="input" data-preset="1"><option value="">Custom size</option>${Model.PRESETS.map((g) => `<optgroup label="${esc(g.group)}">${g.items.map(([n, w, hh]) => `<option value="${w}x${hh}" ${Math.abs(w - doc.w) < 0.05 && Math.abs(hh - doc.h) < 0.05 ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`).join('')}</select></div>
      <div class="grid2">${len('Width', 'd.w', doc.w)}${len('Height', 'd.h', doc.h)}</div>
      <div class="btn-row"><button class="btn btn-sm" data-act="swap">Swap width and height</button></div>
      <div class="grid2">${len('Bleed', 'd.bleed', doc.bleed)}${num('px are at', 'd.dpi', doc.dpi, 'dpi')}</div>
      <p class="hint">Bleed is the extra ${Units.label(doc.bleed, U(), doc.dpi)} that gets trimmed off. Run backgrounds and photos to the dashed red line.</p>
      </section><section><h5>Margins (safe area)</h5>
      <div class="grid2">${len('Top', 'd.m.top', doc.margins.top)}${len('Bottom', 'd.m.bottom', doc.margins.bottom)}${len(sideNames[0], 'd.m.inside', doc.margins.inside)}${len(sideNames[1], 'd.m.outside', doc.margins.outside)}</div>
      <label class="switch"><input type="checkbox" data-check="d.facing" ${doc.facing ? 'checked' : ''}><span>Facing pages (spreads, like a book)</span></label>
      </section>`;
    if (surface.kind === 'page') {
      const p = doc.pages[surface.idx];
      h += `<section><h5>Page ${Model.pageNumber(doc, surface.idx)}</h5>
        <div class="field field-wide"><span>Master</span><select class="input" data-pagemaster="1"><option value="">None</option>${doc.masters.map((m) => `<option value="${m.id}" ${p.master === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
        <label class="switch"><input type="checkbox" data-check="p.hideMaster" ${p.hideMaster ? 'checked' : ''}><span>Hide master items on this page</span></label>
        <div class="grid2">${num('Starts at', 'd.pageStart', doc.pageStart, '')}</div>
        <div class="btn-row"><button class="btn btn-sm" data-act="page-numbers">Add page numbers to the master</button></div></section>`;
    }
    if (surface.kind === 'master') h += `<section><h5>Editing ${esc(Model.master(doc, surface.id).name)}</h5><p class="hint">Anything here shows on every page that uses this master. Type <b>{page}</b> in a text box for the page number, <b>{pages}</b> for the page count, <b>{title}</b> for the document name.</p></section>`;
    return h;
  }

  function coverProps() {
    const { doc } = S();
    const c = Model.cover(doc);
    const single = Model.isSingle(doc);
    const inside = Model.isInside(S().surface);
    return `<section><h5>Cover</h5>
      <p class="big-num">${c.spine.toFixed(2)} mm <span class="muted">spine</span></p>
      <p class="hint">Worked out from ${Model.coverPages(doc)} pages × ${Number(Model.perPage(doc).toFixed(4))} mm a page${doc.cover.spineExtra ? ` + ${doc.cover.spineExtra} mm` : ''}. Check the number with your printer before you send it.</p>
      <div class="field field-wide"><span>Paper</span><div class="paper-line"><span>${esc(Shipment.summary(doc))}</span><button class="btn btn-sm" data-act="shipment" title="Paper, binding and the weight of a copy (File, Shipment preparation)">Change…</button></div></div>
      <div class="grid2">${num('Extra', 'c.spineExtra', doc.cover.spineExtra || 0, 'mm')}${len('Bleed', 'c.bleed', doc.cover.bleed)}</div>
      <p class="hint">Whole cover ${Units.label(c.w, U(), doc.dpi)} × ${Units.label(c.h, U(), doc.dpi)} plus bleed. Keep text 6 mm inside the violet lines${single ? '' : ', and spine text inside the spine'}.</p></section>
      <section><h5>Layout</h5>
      <div class="field field-wide"><span>Cover as</span><select class="input" data-cover-layout-select>
        <option value="spread" ${single ? '' : 'selected'}>One spread: back, spine, front</option>
        <option value="single" ${single ? 'selected' : ''}>Single pages: front and back</option></select></div>
      ${single ? `${doc.cover.inside.enabled ? `<div class="field field-wide"><span>Page order</span><select class="input" data-cover-order>
        <option value="outside-first" ${doc.cover.order !== 'reading' ? 'selected' : ''}>Front, back, inside front, inside back</option>
        <option value="reading" ${doc.cover.order === 'reading' ? 'selected' : ''}>Front, inside front, inside back, back</option></select></div>` : ''}
      <p class="hint">The front and back are separate pages, and export as separate pages of the cover PDF in this order. The spine isn't shown and doesn't print. Anything on it, and the part of a picture that wraps round it, comes back when you switch to one spread.</p>`
        : '<p class="hint">Switch to single pages to work on the front and back on their own, and to export them as separate pages. Nothing is lost when you switch back.</p>'}</section>
      ${inside ? `<section><h5>Inside cover</h5>
      <p class="hint">${single ? 'The inside front and inside back covers, the backs of the front and back.' : 'The back of the cover sheet: the inside front cover on the left, the inside back cover on the right.'} Leave either side empty if you only need one.</p>
      <p class="hint">The spine and ${((c.glue[1] - c.glue[0] - c.spine) / 2).toFixed(0)} mm either side of it are glued to the pages, so keep ${single ? 'the strip along the spine edge' : 'that strip'} clear. Not every printer prints inside covers (Amazon KDP doesn't), so check with yours first.</p>
      ${single ? '' : '<p class="hint">It exports as page 2 of the cover PDF.</p>'}</section>` : ''}`;
  }

  /* ---------- applying field changes ---------- */
  function readField(el) {
    const { doc } = S();
    const kind = el.dataset.kind;
    if (kind === 'text') return el.value;
    if (kind === 'len') return Units.parse(el.value, U(), doc.dpi);
    const v = parseFloat(String(el.value).replace(',', '.'));
    return isFinite(v) ? v : null;
  }

  function applyField(f, v) {
    const { doc } = S();
    const items = Editor.selectedItems();
    if (f.startsWith('d.') || f.startsWith('c.') || f.startsWith('p.')) {
      return App.change('Document', () => {
        if (f === 'd.name') doc.name = v || 'Untitled';
        else if (f === 'd.w') doc.w = clamp(v, 10, 5000);
        else if (f === 'd.h') doc.h = clamp(v, 10, 5000);
        else if (f === 'd.bleed') doc.bleed = clamp(v, 0, 25);
        else if (f === 'd.dpi') doc.dpi = clamp(Math.round(v), 30, 2400);
        else if (f === 'd.pageStart') doc.pageStart = Math.max(1, Math.round(v));
        else if (f.startsWith('d.m.')) doc.margins[f.slice(4)] = clamp(v, 0, 500);
        else if (f === 'c.spineExtra') doc.cover.spineExtra = clamp(v, -50, 100);
        else if (f === 'c.bleed') doc.cover.bleed = clamp(v, 0, 25);
      }, { thumbs: 'all', title: f === 'd.name' });
    }
    App.change('Edit', () => {
      for (const it of f.startsWith('s.') ? Model.withLinked(doc, items) : items) {
        if (f.startsWith('s.')) {
          if (it.type !== 'text') continue;
          const k = f.slice(2);
          // Text settings belong to this box only.
          const target = Model.styleOf(doc, it);
          if (k === 'size') {
            const ratio = (target.leading || target.size * 1.2) / target.size;
            target.size = clamp(v, 1, 1000);
            target.leading = Math.round(target.size * ratio * 10) / 10;
          } else target[k] = v;
          continue;
        }
        if (f === 'opacity') it.opacity = clamp(v / 100, 0, 1);
        else if (f === 'rot') it.rot = ((v % 360) + 540) % 360 - 180;
        else if (f === 'w' || f === 'h') {
          it[f] = Math.max(0.5, v);
          if (it.type === 'image' && it.fit !== 'custom') Render.fitImage(it, doc.assets[it.asset], it.fit);
        } else it[f] = v;
      }
    }, { thumbsShared: f.startsWith('s.') });
  }

  function onFieldChange(e) {
    const el = e.target;
    const { doc } = S();
    if (el.dataset.f) {
      const v = readField(el);
      if (v == null) return renderProps();
      return applyField(el.dataset.f, v);
    }
    if (el.dataset.bc) return barcodeField(el);
    if (el.dataset.font) {
      const items = Editor.selectedItems();
      let path;
      if (el.dataset.font === 'family') {
        const fam = Fonts.families().find(([f]) => f === el.value);
        if (!fam) return;
        const firstText = items.find((x) => x.type === 'text');
        const cur = firstText && Fonts.info(Model.styleOf(doc, firstText).font);
        const pick = fam[1].find((s) => cur && s.style === cur.style) || fam[1].find((s) => /^regular$/i.test(s.style)) || fam[1][0];
        path = pick.path;
      } else path = el.value;
      Fonts.load(path).then(() => applyField('s.font', path));
      return;
    }
    if (el.dataset.stylePick !== undefined && el.dataset.stylePick !== '') {
      const id = el.value;
      if (id === '-') return; // "Mixed": nothing to apply
      return App.change('Apply style', () => {
        for (const it of Model.withLinked(doc, Editor.selectedItems())) if (it.type === 'text') Model.applyStyle(doc, it, id ? doc.styles.find((s) => s.id === id) : null);
      });
    }
    if (el.dataset.preset) {
      if (!el.value) return;
      const [w, h] = el.value.split('x').map(Number);
      return App.change('Page size', () => ((doc.w = w), (doc.h = h)), { thumbs: 'all' });
    }
    if (el.dataset.check) {
      const f = el.dataset.check;
      return App.change('Document', () => {
        if (f === 'd.facing') doc.facing = el.checked;
        if (f === 'p.hideMaster') doc.pages[S().surface.idx].hideMaster = el.checked;
      }, { thumbs: 'all' });
    }
    if (el.dataset.pagemaster !== undefined) return App.change('Apply master', () => (doc.pages[S().surface.idx].master = el.value || null), { thumbs: 'all' });
    if (el.dataset.coverLayoutSelect !== undefined) return App.setCoverLayout(el.value);
    if (el.dataset.coverOrder !== undefined) return App.change('Cover page order', () => (doc.cover.order = el.value), { thumbs: 'all' });
    if (el.dataset.range === 'zoom') return;
  }

  // Up and down arrows nudge numbers; Shift for bigger steps.
  function onFieldKey(e) {
    const el = e.target;
    if (!el.dataset || !el.dataset.f || el.dataset.kind === 'text') return;
    if (e.key === 'Enter') return el.blur();
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
    const v = parseFloat(el.value) || 0;
    el.value = String(Number((v + step * (el.dataset.kind === 'len' && U() === 'cm' ? 0.1 : 1)).toFixed(3)));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function onRightClick(e) {
    const { doc } = S();
    const items = Editor.selectedItems();
    const it = items[0];
    const segBtn = e.target.closest('[data-seg] button');
    if (segBtn) {
      const f = segBtn.closest('[data-seg]').dataset.seg;
      if (f === 'fit') {
        const v = segBtn.dataset.v;
        return App.change('Fit photo', () => {
          for (const x of items) if (x.type === 'image') v === 'custom' ? (x.fit = 'custom') : Render.fitImage(x, doc.assets[x.asset], v);
        });
      }
      return applyField(f, segBtn.dataset.v);
    }
    const fxT = e.target.closest('[data-fx-toggle]');
    if (fxT && it) return PhotoEdit.toggle(it, fxT.dataset.fxToggle);
    const al = e.target.closest('[data-align]');
    if (al) return App.align(al.dataset.align);
    const cb = e.target.closest('[data-color]');
    if (cb) {
      const f = cb.dataset.color;
      const cur = f === 's.color' ? Model.styleOf(doc, it).color : it ? it[f] : null;
      return ColorPicker.open(cb, cur, cb.dataset.none === '1', (val) => applyField(f, val));
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      e.preventDefault();
      const a = act.dataset.act;
      if (a === 'edit-text') return Text.edit(it);
      if (a === 'story') return Story.open(it);
      if (a === 'format-story') return PlaceText.format(it);
      if (a === 'link') return startLink(it);
      if (a === 'unlink') return App.change('Stop continuing', () => (it.next = null));
      if (a === 'shipment') return Shipment.open();
      if (a === 'reset-master') return App.resetToMaster(Editor.selectedItems());
      if (a === 'reset-style') return App.change('Reset to style', () => { for (const x of Model.withLinked(doc, Editor.selectedItems())) if (x.type === 'text' && x.styleId) Model.applyStyle(doc, x, doc.styles.find((s) => s.id === x.styleId)); });
      if (a === 'style-from') return newStyleFrom(it);
      if (a === 'replace-photo') return App.pickPhotoFor(it);
      if (a === 'crop') return App.startCrop(it);
      // Fill frame and Fit in frame happen once; resizing afterwards always crops or scales.
      if (a === 'fit-fill' || a === 'fit-fit')
        return App.change(a === 'fit-fill' ? 'Fill frame' : 'Fit in frame', () => {
          for (const x of items) if (x.type === 'image' && x.asset) Render.fitImage(x, doc.assets[x.asset], a === 'fit-fill' ? 'fill' : 'fit');
        });
      if (a === 'edit-photo') return PhotoEdit.open(it);
      if (a === 'copy-effects') return PhotoEdit.copyEffects(it);
      if (a === 'paste-effects') return PhotoEdit.pasteEffects(Editor.selectedItems());
      if (a === 'swap') return App.change('Swap size', () => ([doc.w, doc.h] = [doc.h, doc.w]), { thumbs: 'all' });
      if (a === 'page-numbers') return App.change('Page numbers', () => Model.addPageNumbers(doc), { thumbs: 'all' });
      if (['lock', 'duplicate', 'delete', 'group', 'ungroup'].includes(a)) return App.cmd(a);
      if (a === 'rename-group') {
        const g = doc.groups[App.selectedGroup()];
        return g && prompt('Group name', g.name).then((v) => v && v.trim() && App.change('Rename group', () => (g.name = v.trim())));
      }
      if (a === 'new-swatch') return SwatchEditor.open(null);
      if (a === 'new-style') return StyleEditor.open(null);
      if (a === 'kit-add-colours') return App.kit.addSwatches(doc.swatches);
      if (a === 'kit-add-styles') return App.kit.addStyles(doc.styles);
      if (a === 'kit-add-logo') return App.kit.addLogo(it);
      if (a === 'kit-add-fonts') return Fonts && ep.fonts.add().then(async (n) => n && (await Fonts.refresh(), toast(`Added ${n} font${n === 1 ? '' : 's'}.`), render()));
      if (a === 'run-check') return renderCheck();
    }
    const sw = e.target.closest('[data-swatch]');
    if (sw) {
      const id = sw.dataset.swatch;
      if (e.target.closest('[data-edit]')) return SwatchEditor.open(doc.swatches.find((s) => s.id === id));
      if (!items.length) return SwatchEditor.open(doc.swatches.find((s) => s.id === id));
      return App.change('Colour', () => {
        for (const x of Model.withLinked(doc, items)) {
          if (x.type === 'text') Model.styleOf(doc, x).color = { sw: id };
          else if (x.type === 'line' || x.type === 'image') x.stroke = { sw: id };
          else x.fill = { sw: id };
        }
      });
    }
    const sty = e.target.closest('[data-stylerow]');
    if (sty) {
      const id = sty.dataset.stylerow;
      if (e.target.closest('[data-edit]') || !items.some((x) => x.type === 'text')) return StyleEditor.open(doc.styles.find((s) => s.id === id));
      return App.change('Apply style', () => {
        const st = doc.styles.find((s) => s.id === id);
        for (const x of Model.withLinked(doc, items)) if (x.type === 'text') Model.applyStyle(doc, x, st);
      });
    }
    const ks = e.target.closest('[data-kitswatch]');
    if (ks) return App.kit.useSwatch(+ks.dataset.kitswatch);
    const kst = e.target.closest('[data-kitstyle]');
    if (kst) return App.kit.useStyle(+kst.dataset.kitstyle);
    const kl = e.target.closest('[data-kitlogo]');
    if (kl) return App.kit.useLogo(+kl.dataset.kitlogo);
    const issue = e.target.closest('[data-issue]');
    if (issue) {
      const p = lastIssues[+issue.dataset.issue];
      if (p) {
        App.goTo(p.surface, {});
        if (p.itemId) App.select([p.itemId]);
      }
    }
  }
  function onRightContext(e) {
    const { doc } = S();
    const sw = e.target.closest('[data-swatch]');
    if (sw) {
      e.preventDefault();
      const s = doc.swatches.find((x) => x.id === sw.dataset.swatch);
      return contextMenu(e.clientX, e.clientY, [
        { label: 'Edit…', run: () => SwatchEditor.open(s) },
        { label: 'Add to brand kit', run: () => App.kit.addSwatches([s]) },
        { label: 'Delete', run: () => App.change('Delete swatch', () => {
          // Things using it keep the colour.
          for (const sf of Model.allSurfaces(doc)) for (const it of Model.surfaceItems(doc, sf)) for (const k of ['fill', 'stroke']) if (it[k] && it[k].sw === s.id) it[k] = { c: s.c, m: s.m, y: s.y, k: s.k };
          for (const st of doc.styles) if (st.color && st.color.sw === s.id) st.color = { c: s.c, m: s.m, y: s.y, k: s.k };
          for (const sf of Model.allSurfaces(doc)) for (const it of Model.surfaceItems(doc, sf)) if (it.style && it.style.color && it.style.color.sw === s.id) it.style.color = { c: s.c, m: s.m, y: s.y, k: s.k };
          doc.swatches = doc.swatches.filter((x) => x !== s);
        }) },
      ]);
    }
    const st = e.target.closest('[data-stylerow]');
    if (st) {
      e.preventDefault();
      const s = doc.styles.find((x) => x.id === st.dataset.stylerow);
      return contextMenu(e.clientX, e.clientY, [
        { label: 'Edit…', run: () => StyleEditor.open(s) },
        { label: 'Add to brand kit', run: () => App.kit.addStyles([s]) },
        { label: 'Delete', run: () => App.change('Delete style', () => {
          // Boxes keep their own settings; they just no longer say which style they came from.
          for (const sf of Model.allSurfaces(doc)) for (const it of Model.surfaceItems(doc, sf)) if (it.styleId === s.id) it.styleId = null;
          doc.styles = doc.styles.filter((x) => x !== s);
        }) },
      ]);
    }
    const kl = e.target.closest('[data-kitlogo], [data-kitswatch], [data-kitstyle]');
    if (kl) {
      e.preventDefault();
      const [kind, idx] = kl.dataset.kitlogo != null ? ['logos', +kl.dataset.kitlogo] : kl.dataset.kitswatch != null ? ['swatches', +kl.dataset.kitswatch] : ['styles', +kl.dataset.kitstyle];
      contextMenu(e.clientX, e.clientY, [{ label: 'Remove from brand kit', run: () => App.kit.remove(kind, idx) }]);
    }
  }

  // Zoom slider for photos (live, one undo step).
  document.addEventListener('input', (e) => {
    if (e.target.dataset && e.target.dataset.range === 'zoom') {
      const it = Editor.selectedItems()[0];
      const a = it && S().doc.assets[it.asset];
      if (!a) return;
      App.history.begin();
      const d = PhotoEdit.dims(it, a); // after any turn
      const base = Math.max(it.w / d.w, it.h / d.h);
      const ns = (base * e.target.value) / 100;
      const cx = it.w / 2, cy = it.h / 2;
      it.ox = cx - (cx - it.ox) * (ns / it.s);
      it.oy = cy - (cy - it.oy) * (ns / it.s);
      it.s = ns;
      it.fit = 'custom';
      Editor.paintSelected();
      App.history.commitSoon('Zoom photo');
    }
  });

  /* ---------- threads ---------- */
  function startLink(it) {
    S().linkFrom = it.id;
    document.body.classList.add('linking');
    toast('Click the text box the text should continue in. Esc to cancel.', { ms: 6000 });
  }
  function finishLink(id) {
    const from = S().linkFrom;
    S().linkFrom = null;
    document.body.classList.remove('linking');
    if (!id || id === from) return;
    const { doc } = S();
    const target = Model.findItem(doc, id)?.item;
    if (!target || target.type !== 'text') return toast('That isn’t a text box.');
    if (Model.chainOf(doc, from).some((c) => c.it.id === id)) return toast('Those boxes are already joined.');
    App.change('Continue text', () => {
      Model.findItem(doc, from).item.next = id;
      target.text = '';
      // Text that continues into this box uses the first box's settings.
      const head = Model.findItem(doc, from).item;
      target.style = clone(Model.styleOf(doc, head));
      target.styleId = head.styleId;
    });
  }

  /* ---------- colours & styles ---------- */
  function renderColours() {
    const { doc } = S();
    let h = `<section><div class="pp-head"><h5>Swatches</h5><button class="btn btn-sm" data-act="new-swatch">+ Swatch</button></div>
      <p class="hint">Click a swatch to use it on what's selected. Right-click to edit, delete or save it in your brand kit.</p><div class="swatches">`;
    for (const s of doc.swatches)
      h += `<div class="swatch" data-swatch="${s.id}" title="${esc(s.name)} · C${s.c} M${s.m} Y${s.y} K${s.k}"><i style="background:${Color.css(s)}"></i><span>${esc(s.name)}</span><em>${s.c}/${s.m}/${s.y}/${s.k}</em><button class="mini" data-edit="1" title="Edit">✎</button></div>`;
    h += `</div></section><section><div class="pp-head"><h5>Text styles</h5><button class="btn btn-sm" data-act="new-style">+ Style</button></div>
      <p class="hint">Click a style to give the selected text its settings. Each text box keeps its own settings, so changing a style only changes boxes when you choose to.</p><div class="styles">`;
    for (const s of doc.styles) {
      const f = Fonts.get(s.font);
      h += `<div class="style-row" data-stylerow="${s.id}"><span class="style-sample" style="font-family:'${f ? f.cssName : 'sans-serif'}';color:${Color.css(Model.resolveColor(doc, s.color))}">${esc(s.name)}</span><em>${esc(Fonts.info(s.font)?.family || 'Missing font')} ${s.size}/${s.leading} pt</em><button class="mini" data-edit="1" title="Edit">✎</button></div>`;
    }
    h += `</div></section><section><p class="hint">Colours are shown as they'll print on ${esc(Color.profileName || 'a standard press')}. Screens can't show CMYK exactly, so get a printed proof for important colours.</p></section>`;
    $('#right-body').innerHTML = h;
  }

  function newStyleFrom(it) {
    const { doc } = S();
    prompt('Name for the new style', 'My style').then((name) => {
      if (!name) return;
      App.change('New style', () => {
        const st = { ...clone(Model.styleOf(doc, it)), id: uid('st'), name: name.trim() };
        doc.styles.push(st);
        it.styleId = st.id;
      });
    });
  }

  /* ---------- brand kit ---------- */
  function renderBrand() {
    const kit = App.kit.data;
    const it = Editor.selectedItems()[0];
    let h = `<section><h5>Brand kit</h5><p class="hint">Your own colours, text styles and logos, ready in every design. Kept on this computer.</p></section>
      <section><div class="pp-head"><h5>Colours</h5><button class="btn btn-sm" data-act="kit-add-colours">Save this document's</button></div><div class="swatches">`;
    kit.swatches.forEach((s, i) => (h += `<div class="swatch" data-kitswatch="${i}" title="Add to this document"><i style="background:${Color.css(s)}"></i><span>${esc(s.name)}</span><em>${s.c}/${s.m}/${s.y}/${s.k}</em></div>`));
    if (!kit.swatches.length) h += '<p class="hint">No colours yet.</p>';
    h += `</div></section><section><div class="pp-head"><h5>Text styles</h5><button class="btn btn-sm" data-act="kit-add-styles">Save this document's</button></div><div class="styles">`;
    kit.styles.forEach((s, i) => {
      const f = Fonts.get(s.font);
      h += `<div class="style-row" data-kitstyle="${i}" title="Add to this document"><span class="style-sample" style="font-family:'${f ? f.cssName : 'sans-serif'}'">${esc(s.name)}</span><em>${esc(Fonts.info(s.font)?.family || 'Missing font')} ${s.size} pt</em></div>`;
    });
    if (!kit.styles.length) h += '<p class="hint">No styles yet.</p>';
    h += `</div></section><section><div class="pp-head"><h5>Logos and pictures</h5>${it && it.type === 'image' && it.asset ? '<button class="btn btn-sm" data-act="kit-add-logo">Save selected photo</button>' : ''}</div><div class="logos">`;
    kit.logos.forEach((l, i) => (h += `<button class="logo" data-kitlogo="${i}" title="Place ${esc(l.name)}"><img src="data:${l.mime};base64,${l.data}" alt=""><span>${esc(l.name)}</span></button>`));
    if (!kit.logos.length) h += '<p class="hint">Select a photo or logo on the page and save it here.</p>';
    h += `</div></section><section><div class="pp-head"><h5>Fonts</h5><button class="btn btn-sm" data-act="kit-add-fonts">Add font files…</button></div><p class="hint">Fonts installed in Windows are already here. Add .ttf or .otf files to use fonts that aren't installed.</p></section>`;
    $('#right-body').innerHTML = h;
  }

  /* ---------- check (preflight) ---------- */
  let lastIssues = [];
  function renderCheck() {
    const { doc } = S();
    lastIssues = Preflight.run(doc);
    const errs = lastIssues.filter((x) => x.level === 'error').length;
    const warns = lastIssues.filter((x) => x.level === 'warn').length;
    let h = `<section><h5>Ready to print?</h5>${!errs && !warns ? '<p class="ok-big">✓ Nothing to fix.</p>' : `<p>${errs ? `<b class="bad">${errs} to fix</b>` : ''}${errs && warns ? ' · ' : ''}${warns ? `<b class="warn">${warns} to check</b>` : ''}</p>`}
      <p class="hint">Click a problem to go to it.</p></section><section class="issues">`;
    lastIssues.forEach((p, i) => (h += `<button class="issue ${p.level}" data-issue="${i}"><i>${p.level === 'error' ? '!' : p.level === 'warn' ? '!' : 'i'}</i><span><b>${esc(p.where)}</b> ${esc(p.text)}</span></button>`));
    h += `</section><section><button class="btn btn-sm" data-act="run-check">Check again</button></section>`;
    $('#right-body').innerHTML = h;
  }
  const updateCheckBadge = debounce(() => {
    const { doc } = S();
    if (!doc) return;
    const n = Preflight.run(doc).filter((x) => x.level !== 'info').length;
    const b = $('#check-badge');
    b.textContent = n || '';
    b.hidden = !n;
  }, 600);

  return { init, render, renderLeft, renderRight, renderProps, refreshGeometry, refreshLayers, refreshThumbsSoon, invalidateThumbs, startLink, finishLink, updateCheckBadge, openGroup };
})();

/* ---------- colour picker: swatches, CMYK values, or a screen colour converted to CMYK ---------- */
const ColorPicker = (() => {
  let pop = null;
  function close() {
    if (pop) pop.remove();
    pop = null;
    document.removeEventListener('pointerdown', away, true);
  }
  const away = (e) => pop && !pop.contains(e.target) && close();
  function open(anchor, current, allowNone, onPick) {
    close();
    const { doc } = App.S;
    let val = Model.resolveColor(doc, current) || { c: 0, m: 0, y: 0, k: 100 };
    pop = document.createElement('div');
    pop.className = 'cpop';
    const draw = () => {
      const ink = Model.ink(val);
      pop.innerHTML = `${allowNone ? `<button class="cp-none ${!current ? 'on' : ''}" data-none="1">None</button>` : ''}
        <div class="cp-sw">${doc.swatches.map((s) => `<button title="${esc(s.name)}" data-sw="${s.id}" class="${current && current.sw === s.id ? 'on' : ''}" style="background:${Color.css(s)}"></button>`).join('')}</div>
        <div class="cp-prev" style="background:${Color.css(val)}"></div>
        ${['c', 'm', 'y', 'k'].map((ch) => `<label class="cp-row"><b>${ch.toUpperCase()}</b><input type="range" min="0" max="100" value="${val[ch]}" data-ch="${ch}"><input class="input" value="${val[ch]}" data-chn="${ch}"></label>`).join('')}
        <p class="cp-ink ${ink > 300 ? 'bad' : ''}">Total ink ${ink}%${ink > 300 ? ' · over 300%, most printers will ask you to lower it' : ''}</p>
        <label class="cp-row cp-screen"><span>Screen colour</span><input type="color" value="${Color.hex(val)}" data-hex="1"><em>converted to CMYK</em></label>
        <div class="btn-row"><button class="btn btn-sm" data-save="1">Save as swatch</button></div>`;
    };
    draw();
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.left = Math.min(r.left, innerWidth - pr.width - 10) + 'px';
    pop.style.top = Math.min(r.bottom + 6, innerHeight - pr.height - 10) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
    const live = debounce((v) => onPick(v), 60);
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.none) return onPick(null), close();
      if (b.dataset.sw) {
        current = { sw: b.dataset.sw };
        val = Model.resolveColor(doc, current);
        onPick(current);
        return draw();
      }
      if (b.dataset.save)
        prompt('Swatch name', `C${val.c} M${val.m} Y${val.y} K${val.k}`).then((name) => {
          if (!name) return;
          const sw = { id: uid('sw'), name: name.trim(), ...val };
          App.change('New swatch', () => doc.swatches.push(sw));
          onPick({ sw: sw.id });
          close();
        });
    });
    pop.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.ch || t.dataset.chn) {
        const ch = t.dataset.ch || t.dataset.chn;
        val = { ...val, [ch]: clamp(Math.round(+t.value || 0), 0, 100) };
      } else if (t.dataset.hex) val = Color.fromHex(t.value);
      else return;
      current = { ...val };
      $('.cp-prev', pop).style.background = Color.css(val);
      for (const ch of ['c', 'm', 'y', 'k']) {
        const a = $(`[data-ch="${ch}"]`, pop), n = $(`[data-chn="${ch}"]`, pop);
        if (a !== t) a.value = val[ch];
        if (n !== t) n.value = val[ch];
      }
      const ink = Model.ink(val);
      const p = $('.cp-ink', pop);
      p.className = 'cp-ink ' + (ink > 300 ? 'bad' : '');
      p.textContent = `Total ink ${ink}%${ink > 300 ? ' · over 300%, most printers will ask you to lower it' : ''}`;
      live({ ...val });
    });
    pop.addEventListener('keydown', (e) => (e.stopPropagation(), e.key === 'Escape' && close()));
  }
  return { open, close };
})();

/* ---------- editing a swatch ---------- */
const SwatchEditor = (() => {
  function open(sw) {
    const { doc } = App.S;
    const v = sw ? { ...sw } : { name: 'New colour', c: 0, m: 0, y: 0, k: 0 };
    const m = openModal({
      title: sw ? 'Edit swatch' : 'New swatch',
      body: `<label class="field field-wide"><span>Name</span><input class="input" data-n="name" value="${esc(v.name)}"></label>
        <div class="sw-big" style="background:${Color.css(v)}"></div>
        <div class="grid2">${['c', 'm', 'y', 'k'].map((ch) => `<label class="field"><span>${ch.toUpperCase()}</span><input class="input" data-n="${ch}" value="${v[ch]}"><em>%</em></label>`).join('')}</div>
        <label class="field field-wide"><span>Or a screen colour</span><input type="color" data-hex="1" value="${Color.hex(v)}"></label>
        <p class="hint">Everything using this swatch changes when you save.</p>
        <div class="modal-actions"><button class="btn btn-ghost" data-a="no">Cancel</button><button class="btn btn-accent" data-a="yes">Save</button></div>`,
    });
    const upd = () => ($('.sw-big', m.el).style.background = Color.css(v));
    m.el.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.hex) {
        Object.assign(v, Color.fromHex(t.value));
        for (const ch of ['c', 'm', 'y', 'k']) $(`[data-n="${ch}"]`, m.el).value = v[ch];
      } else if (t.dataset.n === 'name') v.name = t.value;
      else if (t.dataset.n) v[t.dataset.n] = clamp(Math.round(+t.value || 0), 0, 100);
      upd();
    });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'yes')
        App.change(sw ? 'Edit swatch' : 'New swatch', () => {
          if (sw) Object.assign(sw, { name: v.name, c: v.c, m: v.m, y: v.y, k: v.k });
          else doc.swatches.push({ id: uid('sw'), name: v.name, c: v.c, m: v.m, y: v.y, k: v.k });
        }, { thumbs: 'all' });
      m.close();
    });
  }
  return { open };
})();

/* ---------- editing a text style ---------- */
const StyleEditor = (() => {
  function open(st) {
    const { doc } = App.S;
    const v = st ? clone(st) : { ...Model.textStyle(), id: uid('st'), name: 'New style' };
    const fams = Fonts.families();
    const famOf = (p) => Fonts.info(p)?.family;
    const m = openModal({
      title: st ? `Edit “${st.name}”` : 'New text style',
      body: `<label class="field field-wide"><span>Name</span><input class="input" data-n="name" value="${esc(v.name)}"></label>
        <div class="field field-wide"><span>Font</span><select class="input" data-fam="1">${fams.map(([f]) => `<option ${f === famOf(v.font) ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
        <div class="field field-wide"><span>Style</span><select class="input" data-sty="1"></select></div>
        <div class="grid2">
          <label class="field"><span>Size</span><input class="input" data-n="size" value="${v.size}"><em>pt</em></label>
          <label class="field"><span>Leading</span><input class="input" data-n="leading" value="${v.leading}"><em>pt</em></label>
          <label class="field"><span>Tracking</span><input class="input" data-n="tracking" value="${v.tracking || 0}"><em>/1000</em></label>
          <label class="field"><span>After ¶</span><input class="input" data-n="spaceAfter" value="${v.spaceAfter || 0}"><em>pt</em></label>
          <label class="field"><span>Indent</span><input class="input" data-n="indent" value="${v.indent || 0}"><em>mm</em></label>
          <label class="field"><span>Align</span><select class="input" data-n="align">${['left', 'center', 'right', 'justify'].map((a) => `<option value="${a}" ${v.align === a ? 'selected' : ''}>${{ left: 'Left', center: 'Centre', right: 'Right', justify: 'Justified' }[a]}</option>`).join('')}</select></label>
        </div>
        <div class="field field-wide"><span>Colour</span><select class="input" data-n="color">${doc.swatches.map((s) => `<option value="${s.id}" ${v.color && v.color.sw === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}${v.color && !v.color.sw ? '<option value="" selected>Custom colour</option>' : ''}</select></div>
        <div class="style-preview"></div>
        <div class="modal-actions"><button class="btn btn-ghost" data-a="no">Cancel</button><button class="btn btn-accent" data-a="yes">Save</button></div>`,
    });
    const fillStyles = () => {
      const fam = fams.find(([f]) => f === $('[data-fam]', m.el).value);
      $('[data-sty]', m.el).innerHTML = (fam ? fam[1] : []).map((s) => `<option value="${esc(s.path)}" ${s.path.toLowerCase() === (v.font || '').toLowerCase() ? 'selected' : ''}>${esc(s.style)}</option>`).join('');
      if (fam && !fam[1].some((s) => s.path.toLowerCase() === (v.font || '').toLowerCase())) v.font = (fam[1].find((s) => /^regular$/i.test(s.style)) || fam[1][0]).path;
      preview();
    };
    const preview = async () => {
      const f = await Fonts.load(v.font);
      $('.style-preview', m.el).innerHTML = `<span style="font-family:'${f ? f.cssName : 'sans-serif'}';font-size:${Math.min(v.size, 36)}pt;line-height:1.2">${esc(v.name)} · The quick brown fox</span>`;
    };
    fillStyles();
    m.el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.fam) fillStyles();
      else if (t.dataset.sty) (v.font = t.value), preview();
      else if (t.dataset.n === 'name') v.name = t.value;
      else if (t.dataset.n === 'align') v.align = t.value;
      else if (t.dataset.n === 'color') t.value && (v.color = { sw: t.value });
      else if (t.dataset.n) v[t.dataset.n] = parseFloat(t.value) || 0;
      preview();
    });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'yes') {
        v.name = $('[data-n="name"]', m.el).value || 'Style';
        App.change(st ? 'Edit style' : 'New style', () => {
          if (st) Object.assign(st, v);
          else doc.styles.push(v);
        }, { thumbs: 'all' });
        // Boxes keep their own settings, so ask before giving them the style's new ones.
        const using = st ? Model.allSurfaces(doc).flatMap((s) => Model.surfaceItems(doc, s)).filter((it) => it.type === 'text' && it.styleId === st.id) : [];
        if (using.length) {
          m.close();
          ask(`Update the ${using.length} text box${using.length === 1 ? '' : 'es'} that use “${st.name}”?`, {
            detail: "They get the style's new settings, replacing any changes made to them one by one. Choose Just the style to leave them as they are.",
            ok: 'Update them',
            cancel: 'Just the style',
          }).then((yes) => yes && App.change('Update boxes to style', () => using.forEach((it) => Model.applyStyle(doc, it, st)), { thumbs: 'all' }));
          return;
        }
      }
      m.close();
    });
  }
  return { open };
})();
