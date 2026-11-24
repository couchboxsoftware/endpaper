/* Place text (Insert, Place text…) and Format story (Type, Format story…): a panel docked over
   the right-hand panel, beside the pages.

   Place text: paste a long text and it appears on the real pages as you go, in a text box inside
   the margins of each page from one page to another, linked so the text flows from page to page.
   A line with just --- starts a new page (and empty lines can, Empty lines). Change the look
   (style, font, size, spacing, colour, alignment) and the pages update live, with pages added
   after the range when "Add pages if it needs more" is ticked, and taken away again when they're
   no longer needed. Nothing is kept until Done, which is one step to undo; Cancel puts
   everything back.

   Format story: the text and the same look settings for text that's already placed, live on all
   its linked boxes. The page count only changes when you press Add or Remove.

   While the panel is open the rest of Endpaper is paused: you can look around (scroll, zoom,
   click page thumbnails) but not change anything else. */
const PlaceText = (() => {
  const MAX_PAGES = 2000;
  let P = null; // the open panel

  // The box a page gets: the area inside its margins.
  function frame(doc, idx) {
    const m = Model.margins(doc, Model.side(doc, idx));
    return { x: m.left, y: m.top, w: doc.w - m.left - m.right, h: doc.h - m.top - m.bottom };
  }

  // Pasted text, tidied: Windows line ends, tabs, spaces at line ends, and blank lines (or
  // breaks) at the very end. A break at the start is kept: it leaves the first page empty.
  // emptyLines 'break': empty lines start a new page too. A run of empty lines is one break,
  // and empty lines next to a --- add nothing to it (two --- in a row still leave a page empty).
  function clean(text, { emptyLines = 'gap' } = {}) {
    let lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n').map((l) => l.replace(/[  ]+$/, ''));
    // Empty lines before the text are never a break.
    while (lines.length && !lines[0].trim()) lines.shift();
    if (emptyLines === 'break') {
      const out = [];
      for (let i = 0; i < lines.length; ) {
        if (lines[i].trim() && !Layout.isBreak(lines[i])) {
          out.push(lines[i++]);
          continue;
        }
        let breaks = 0;
        for (; i < lines.length && (!lines[i].trim() || Layout.isBreak(lines[i])); i++) if (Layout.isBreak(lines[i])) breaks++;
        for (let k = 0; k < Math.max(1, breaks); k++) out.push('---');
      }
      lines = out;
    }
    while (lines.length && (!lines[lines.length - 1].trim() || Layout.isBreak(lines[lines.length - 1]))) lines.pop();
    return lines.join('\n');
  }

  // How many pages the text needs from a page, in a look. more: it needs more than MAX_PAGES.
  function pagesNeeded(doc, text, look, fromIdx) {
    if (!String(text || '').trim()) return { pages: 0, more: false };
    const f = frame(doc, fromIdx);
    let n = 8;
    for (;;) {
      const r = Layout.measure(doc, text, look, f.w, f.h, n);
      if (!r.overflow) return { pages: r.used, more: false };
      if (n >= MAX_PAGES) return { pages: MAX_PAGES, more: true };
      n = Math.min(MAX_PAGES, n * 4);
    }
  }

  // A text style's settings without its name and id: what a box keeps as its own.
  const lookOf = (st) => {
    const { id, name, ...rest } = clone(st);
    return rest;
  };
  const sameLook = (a, b) => [...new Set([...Object.keys(lookOf(a)), ...Object.keys(lookOf(b))])].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
  const pl = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

  /* ---------- making the boxes ---------- */
  // Adds pages after toIdx (add of them) and a linked box on count pages from fromIdx.
  // Returns the new boxes' ids and the new pages' ids.
  function makeBoxes(doc, { text, look, styleId, fromIdx, toIdx, count, add }) {
    const master = doc.pages[toIdx].master;
    const pages = [];
    for (let k = 0; k < add; k++) {
      const p = Model.newPage(doc, master);
      doc.pages.splice(toIdx + 1 + k, 0, p);
      pages.push(p.id);
    }
    const boxes = [];
    for (let i = 0; i < count; i++) {
      const idx = fromIdx + i;
      const f = frame(doc, idx);
      const it = Model.newItem('text', f.x, f.y, f.w, f.h, doc);
      it.style = clone(look);
      it.styleId = styleId || null;
      if (i === 0) it.text = text;
      doc.pages[idx].items.push(it);
      boxes.push(it);
    }
    boxes.forEach((b, i) => (b.next = boxes[i + 1] ? boxes[i + 1].id : null));
    return { boxes: boxes.map((b) => b.id), pages };
  }

  // Puts text on pages in one go, as one step to undo (used by tests and scripts).
  function place(doc, { text, style, fromIdx, toIdx, count, add }) {
    let ids = [];
    App.change('Place text', () => (ids = makeBoxes(doc, { text, look: lookOf(style), styleId: style.id, fromIdx, toIdx, count, add }).boxes), { thumbs: 'all' });
    App.goTo({ kind: 'page', idx: fromIdx });
    App.select([ids[0]]);
    return ids;
  }

  /* ---------- the panel ---------- */
  const canFormat = (it) => !!(it && it.type === 'text' && App.S.doc && Model.chainOf(App.S.doc, it.id).length > 1);

  function start(mode, extra) {
    const doc = App.S.doc;
    if (!doc || P) return;
    if (Text.active) Text.finish();
    const h = App.history;
    h.begin();
    P = { mode, before: h.pending, undoLen: h.undo.length, wasDirty: App.S.dirty, surface0: { ...App.S.surface }, boxIds: [], addedPages: [], need: { pages: 0, more: false }, ...extra };
    App.select([]);
    const el = document.createElement('div');
    el.className = 'pt-panel blocks-menus';
    $('#right').appendChild(el);
    P.el = el;
    el.innerHTML = shell();
    renderLook();
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKey);
    const ta = $('.pt-text', el);
    if (ta) {
      // Place: the pasted text, tidied each time. Format: the story's own text, as it is.
      if (mode === 'format') ta.value = Model.findItem(doc, P.headId).item.text || '';
      P.typed = debounce(() => {
        if (!P) return;
        if (P.mode === 'format') Model.findItem(App.S.doc, P.headId).item.text = ta.value;
        else P.raw = ta.value;
        live();
      }, 250);
      ta.addEventListener('input', P.typed);
      if (mode === 'place') setTimeout(() => ta.focus(), 0);
    }
    lock(true);
    live();
  }

  // Insert, Place text…
  async function open() {
    const doc = App.S.doc;
    if (!doc) return;
    const st = doc.styles.find((s) => s.id === 'st-body') || doc.styles[0];
    if (st && Fonts.exists(st.font)) await Fonts.load(st.font);
    const fromIdx = App.S.surface.kind === 'page' ? App.S.surface.idx : 0;
    start('place', {
      raw: '',
      styleId: st ? st.id : null,
      look: st ? lookOf(st) : Model.textStyle(),
      fromIdx,
      toIdx: doc.pages.length - 1,
      emptyLines: App.S.settings.placeEmptyLines === 'break' ? 'break' : 'gap',
      addPages: App.S.settings.placeAddPages !== false,
    });
  }

  // Type, Format story…: the look of text that's already placed, on all its linked boxes.
  function format(it) {
    const doc = App.S.doc;
    if (!canFormat(it)) return;
    const head = Model.chainOf(doc, it.id)[0].it;
    start('format', { headId: head.id, styleId: head.styleId || null, look: clone(Model.styleOf(doc, head)) });
  }

  function shell() {
    const doc = App.S.doc;
    if (P.mode === 'format') {
      return `<div class="pt-head"><h3>Format story</h3><button class="icon-btn" data-a="cancel" title="Cancel">✕</button></div>
        <div class="pt-scroll"><p class="hint">This text and how it looks, on all its linked boxes. The pages change as you go. A line with just --- starts a new page. Nothing is kept until you press Done.</p>
        <textarea class="pt-text" spellcheck="true"></textarea>
        <section><h5>Look</h5><div class="pt-look"></div></section></div>
        <div class="pt-foot"><p class="pt-info"></p><div class="pt-fit"></div><div class="btn-row pt-end"><button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-accent" data-a="done">Done</button></div></div>`;
    }
    const first = Model.pageNumber(doc, 0), last = Model.pageNumber(doc, doc.pages.length - 1);
    const num = (k, v) => `<input class="input" type="number" data-pt="${k}" min="${first}" max="${last}" value="${v}">`;
    return `<div class="pt-head"><h3>Place text</h3><button class="icon-btn" data-a="cancel" title="Cancel">✕</button></div>
      <div class="pt-scroll">
        <p class="hint">Paste your text. It appears on the pages as you go, in a box inside the margins of each page. A line with just --- starts a new page. Nothing is kept until you press Done.</p>
        <textarea class="pt-text" spellcheck="true" placeholder="Paste or type your text here"></textarea>
        <section><h5>Pages</h5>
          <div class="pt-range"><span>From page</span>${num('from', Model.pageNumber(doc, P.fromIdx))}<span>to</span>${num('to', Model.pageNumber(doc, P.toIdx))}</div>
          <label class="switch"><input type="checkbox" data-pt="add" ${P.addPages ? 'checked' : ''}><span>Add pages if it needs more</span></label>
          <div class="pt-empty"><span class="muted">Empty lines</span><div class="seg" data-pt-seg="empty">${[['gap', 'Leave a gap'], ['break', 'Start a new page']].map(([v, l]) => `<button data-v="${v}" class="${v === P.emptyLines ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        </section>
        <section><h5>Look</h5><div class="pt-look"></div></section>
      </div>
      <div class="pt-foot"><p class="pt-info"></p><div class="btn-row pt-end"><button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-accent" data-a="done">Done</button></div></div>`;
  }

  // The look settings: style, font, sizes and spacing, colour and alignment.
  function renderLook() {
    const doc = App.S.doc;
    const L = P.look;
    const st = doc.styles.find((s) => s.id === P.styleId);
    const info = Fonts.info(L.font);
    const fams = Fonts.families();
    const fam = info ? info.family : null;
    const weights = fam ? fams.find(([f]) => f === fam)?.[1] || [] : [];
    const n = (label, k, unit, d = 0) => `<label class="field"><span>${label}</span><input class="input" data-lk="${k}" value="${Number(Number(L[k] ?? d).toFixed(2))}"><em>${unit}</em></label>`;
    const c = Model.resolveColor(doc, L.color) || { c: 0, m: 0, y: 0, k: 100 };
    $('.pt-look', P.el).innerHTML = `
      <div class="field field-wide"><span>Style</span><select class="input" data-lk="style">${st ? '' : '<option value="" selected>No style</option>'}${doc.styles.map((s) => `<option value="${esc(s.id)}" ${s === st ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="btn-row"><button class="btn btn-sm" data-a="save-style">Save as new style…</button>${st && !sameLook(st, L) ? `<button class="btn btn-sm" data-a="update-style">Update “${esc(st.name)}”</button>` : ''}</div>
      <div class="field field-wide"><span>Font</span><select class="input" data-lk="family">${info ? '' : '<option selected>Missing font</option>'}${fams.map(([f]) => `<option ${f === fam ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
      <div class="field field-wide"><span>Weight</span><select class="input" data-lk="weight">${weights.map((w) => `<option value="${esc(w.path)}" ${w.path.toLowerCase() === (L.font || '').toLowerCase() ? 'selected' : ''}>${esc(w.style)}</option>`).join('')}</select></div>
      <div class="grid2">${n('Size', 'size', 'pt', 11)}${n('Leading', 'leading', 'pt', 15)}${n('Tracking', 'tracking', '/1000')}${n('After ¶', 'spaceAfter', 'pt')}${n('Indent', 'indent', 'mm')}</div>
      <div class="field"><span>Colour</span><button class="color-btn" data-lk-color="1"><i style="background:${Color.css(c)}"></i><b>${esc(Model.colorName(doc, L.color))}</b></button></div>
      <div class="field field-wide"><span>Align</span><div class="seg" data-lk-seg="align">${[['left', '⟸', 'Left'], ['center', '≡', 'Centre'], ['right', '⟹', 'Right'], ['justify', '☰', 'Justified']].map(([v, l, t]) => `<button data-v="${v}" title="${t}" class="${(L.align || 'left') === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>`;
  }

  /* ---------- live ---------- */
  // Place: takes away what the last round put on the pages and puts it on again.
  function rebuild() {
    const doc = App.S.doc;
    const gone = new Set(P.boxIds);
    for (const p of doc.pages) if (p.items.some((it) => gone.has(it.id))) p.items = p.items.filter((it) => !gone.has(it.id));
    const extra = new Set(P.addedPages);
    for (let i = doc.pages.length - 1; i >= 0; i--) if (extra.has(doc.pages[i].id)) doc.pages.splice(i, 1);
    P.boxIds = [];
    P.addedPages = [];
    const text = clean(P.raw, { emptyLines: P.emptyLines });
    P.need = pagesNeeded(doc, text, P.look, P.fromIdx);
    P.placed = 0;
    if (!P.need.pages) return;
    const room = P.toIdx - P.fromIdx + 1;
    let count = Math.min(P.need.pages, room);
    let add = 0;
    if (P.need.pages > room && P.addPages) {
      add = P.need.pages - room;
      count = P.need.pages;
    }
    const made = makeBoxes(doc, { text, look: P.look, styleId: P.styleId, fromIdx: P.fromIdx, toIdx: P.toIdx, count, add });
    P.boxIds = made.boxes;
    P.addedPages = made.pages;
    P.placed = count;
  }

  // Format: the look goes to every box the text runs through.
  function restyle() {
    const doc = App.S.doc;
    for (const { it } of Model.chainOf(doc, P.headId)) {
      it.style = clone(P.look);
      it.styleId = P.styleId || null;
      it.styleOverride = null;
    }
  }

  function live() {
    if (!P) return;
    if (P.mode === 'place') rebuild();
    else restyle();
    Layout.invalidate();
    Panels.invalidateThumbs();
    const doc = App.S.doc;
    // Keep the page you're looking at, unless it was one that's just gone; on first showing
    // the text, go to its first page.
    if (P.mode === 'place' && P.placed && !P.shown) {
      P.shown = true;
      App.goTo({ kind: 'page', idx: P.fromIdx });
    } else if (App.S.surface.kind === 'page' && App.S.surface.idx >= doc.pages.length) App.goTo({ kind: 'page', idx: doc.pages.length - 1 });
    else App.render();
    info();
  }

  function info() {
    const doc = App.S.doc;
    const out = $('.pt-info', P.el);
    out.classList.remove('warn');
    const done = $('[data-a="done"]', P.el);
    if (P.mode === 'place') {
      done.disabled = !P.placed;
      const need = P.need;
      if (!need.pages) return (out.textContent = 'Paste some text to see it on the pages.');
      const p0 = Model.pageNumber(doc, P.fromIdx);
      const room = P.toIdx - P.fromIdx + 1;
      const fills = P.placed === 1 ? `Fills page ${p0}` : `Fills pages ${p0} to ${p0 + P.placed - 1}`;
      if (need.pages <= room) return (out.textContent = `${fills}.`);
      if (P.addPages) return (out.textContent = `${fills}, with ${pl(P.addedPages.length, 'new page')}.`);
      out.textContent = `Needs ${need.more ? 'more than' : 'about'} ${need.pages} pages. You chose ${room}, so the rest waits in the last box.`;
      out.classList.add('warn');
      return;
    }
    // Format: how the text fits its boxes, and buttons to add or take away pages.
    const chain = Model.chainOf(doc, P.headId);
    const last = chain[chain.length - 1];
    const over = Layout.box(doc, last.it, null).overflow;
    let empty = 0;
    for (let i = chain.length - 1; i > 0 && !Layout.box(doc, chain[i].it, null).lines.length; i--) empty++;
    const fit = $('.pt-fit', P.el);
    fit.innerHTML = '';
    P.fit = null;
    if (over) {
      const onPages = last.s.kind === 'page';
      const firstIdx = chain[0].s.kind === 'page' ? chain[0].s.idx : 0;
      const more = onPages ? Math.max(1, pagesNeeded(doc, chain[0].it.text, P.look, firstIdx).pages - chain.length) : 0;
      out.textContent = `There's more text than fits in its ${pl(chain.length, 'box', 'boxes')}.`;
      out.classList.add('warn');
      if (onPages) {
        P.fit = { add: more };
        fit.innerHTML = `<button class="btn btn-sm" data-a="fit-add">Add ${pl(more, 'page')}</button>`;
      }
    } else if (empty) {
      const removable = chain.slice(chain.length - empty).filter((c) => c.s.kind === 'page' && doc.pages[c.s.idx].items.length === 1 && !doc.pages[c.s.idx].items[0].masterRef).length;
      out.textContent = `The text fits, with ${pl(empty, 'empty box', 'empty boxes')} at the end.`;
      P.fit = { remove: empty };
      fit.innerHTML = `<button class="btn btn-sm" data-a="fit-remove">${removable ? `Remove ${pl(removable, 'empty page')}` : `Remove ${empty === 1 ? 'the empty box' : `${empty} empty boxes`}`}</button>`;
    } else out.textContent = `The text fits its ${pl(chain.length, 'box', 'boxes')}.`;
  }

  // Format: more pages for text that doesn't fit, after the page its last box is on.
  function fitAdd(n) {
    const doc = App.S.doc;
    const chain = Model.chainOf(doc, P.headId);
    const last = chain[chain.length - 1];
    if (last.s.kind !== 'page') return;
    const at = last.s.idx;
    const made = makeBoxes(doc, { text: '', look: P.look, styleId: P.styleId, fromIdx: at + 1, toIdx: at, count: n, add: n });
    last.it.next = made.boxes[0];
    live();
  }
  // Format: takes away the empty boxes at the end, and their pages when nothing else is on them.
  function fitRemove(n) {
    const doc = App.S.doc;
    const chain = Model.chainOf(doc, P.headId);
    const drop = chain.slice(chain.length - n);
    chain[chain.length - n - 1].it.next = null;
    const pagesGone = new Set();
    for (const c of drop) {
      const list = Model.surfaceItems(doc, c.s);
      const i = list.indexOf(c.it);
      if (i >= 0) list.splice(i, 1);
      if (c.s.kind === 'page' && !doc.pages[c.s.idx].items.length) pagesGone.add(doc.pages[c.s.idx].id);
    }
    if (pagesGone.size && doc.pages.length > pagesGone.size) doc.pages = doc.pages.filter((p) => !pagesGone.has(p.id));
    live();
  }

  /* ---------- events ---------- */
  function onClick(e) {
    const seg = e.target.closest('[data-pt-seg="empty"] [data-v]');
    if (seg) {
      if (seg.dataset.v === P.emptyLines) return;
      P.emptyLines = seg.dataset.v;
      $$('[data-pt-seg="empty"] [data-v]', P.el).forEach((x) => x.classList.toggle('on', x === seg));
      ep.settings.set({ placeEmptyLines: P.emptyLines }).then((s) => (App.S.settings = s));
      return live();
    }
    const al = e.target.closest('[data-lk-seg="align"] [data-v]');
    if (al) return setLook({ align: al.dataset.v });
    const col = e.target.closest('[data-lk-color]');
    if (col) return ColorPicker.open(col, P.look.color, false, (v) => setLook({ color: v }));
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'cancel') return cancel();
    if (a === 'done') return done();
    if (a === 'save-style') return saveStyle();
    if (a === 'update-style') return updateStyle();
    if (a === 'fit-add' && P.fit) return fitAdd(P.fit.add);
    if (a === 'fit-remove' && P.fit) return fitRemove(P.fit.remove);
  }

  async function onChange(e) {
    const el = e.target;
    const doc = App.S.doc;
    const pt = el.dataset.pt;
    if (pt === 'add') {
      P.addPages = el.checked;
      ep.settings.set({ placeAddPages: P.addPages }).then((s) => (App.S.settings = s));
      return live();
    }
    if (pt === 'from' || pt === 'to') {
      const first = Model.pageNumber(doc, 0);
      const lastIdx = doc.pages.length - 1 - P.addedPages.length;
      const idx = (v) => Math.max(0, Math.min(lastIdx, Math.round(Number(v) || first) - first));
      const from = idx($('[data-pt="from"]', P.el).value);
      const to = Math.max(from, idx($('[data-pt="to"]', P.el).value));
      P.fromIdx = from;
      P.toIdx = to;
      $('[data-pt="from"]', P.el).value = Model.pageNumber(doc, from);
      $('[data-pt="to"]', P.el).value = Model.pageNumber(doc, to);
      P.shown = false;
      return live();
    }
    const k = el.dataset.lk;
    if (!k) return;
    if (k === 'style') {
      const st = doc.styles.find((s) => s.id === el.value);
      if (!st) return;
      if (Fonts.exists(st.font)) await Fonts.load(st.font);
      P.styleId = st.id;
      P.look = lookOf(st);
      renderLook();
      return live();
    }
    if (k === 'family' || k === 'weight') {
      let path = el.value;
      if (k === 'family') {
        const fam = Fonts.families().find(([f]) => f === el.value);
        if (!fam) return;
        const cur = Fonts.info(P.look.font);
        const pick = fam[1].find((s) => cur && s.style === cur.style) || fam[1].find((s) => /^regular$/i.test(s.style)) || fam[1][0];
        path = pick.path;
      }
      await Fonts.load(path);
      return setLook({ font: path });
    }
    const v = parseFloat(String(el.value).replace(',', '.'));
    if (!isFinite(v)) return renderLook();
    if (k === 'size') {
      const L = P.look;
      const ratio = (L.leading || L.size * 1.2) / L.size;
      const size = clamp(v, 1, 1000);
      return setLook({ size, leading: Math.round(size * ratio * 10) / 10 });
    }
    const lim = { leading: [0.5, 1000], tracking: [-500, 2000], spaceAfter: [0, 500], indent: [0, 500] }[k] || [-1e6, 1e6];
    setLook({ [k]: clamp(v, lim[0], lim[1]) });
  }

  function onKey(e) {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      if (P.typed && P.typed.flush) P.typed.flush();
      return done();
    }
    const el = e.target;
    if (el.dataset && el.dataset.lk && el.tagName === 'INPUT') {
      if (e.key === 'Enter') return el.blur();
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1) * (el.dataset.lk === 'size' || el.dataset.lk === 'leading' ? 0.5 : 1);
      el.value = String(Number(((parseFloat(el.value) || 0) + step).toFixed(2)));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setLook(patch) {
    Object.assign(P.look, patch);
    renderLook();
    live();
  }

  async function saveStyle() {
    const doc = App.S.doc;
    const base = doc.styles.find((s) => s.id === P.styleId);
    const name = await prompt('New text style', base ? `${base.name} 2` : 'My style', { ok: 'Save', label: 'Name' });
    if (!P || !name || !name.trim()) return;
    const st = { id: uid('st'), name: name.trim(), ...clone(P.look) };
    doc.styles.push(st);
    P.styleId = st.id;
    renderLook();
    live();
    toast(`Saved “${st.name}”. It's in your text styles (Colours).`);
  }
  function updateStyle() {
    const doc = App.S.doc;
    const st = doc.styles.find((s) => s.id === P.styleId);
    if (!st) return;
    Object.assign(st, clone(P.look), { id: st.id, name: st.name });
    renderLook();
    toast(`Updated “${st.name}”. Boxes already using it keep their own settings.`);
  }

  /* ---------- finishing ---------- */
  function close() {
    lock(false);
    if (P && P.el) P.el.remove();
    const was = P;
    P = null;
    return was;
  }
  function done() {
    if (!P) return;
    if (P.mode === 'place' && !P.placed) return;
    const doc = App.S.doc;
    const was = close();
    const h = App.history;
    h.undo.splice(was.undoLen);
    h.pending = was.before;
    const label = was.mode === 'place' ? 'Place text' : 'Format story';
    if (!h.commit(label, { thumbs: 'all' })) App.render();
    if (was.mode === 'place') {
      App.goTo({ kind: 'page', idx: was.fromIdx });
      App.select([was.boxIds[0]]);
      const p0 = Model.pageNumber(doc, was.fromIdx);
      toast(was.placed === 1 ? `Placed on page ${p0}.` : `Placed on pages ${p0} to ${p0 + was.placed - 1}${was.addedPages.length ? `, with ${pl(was.addedPages.length, 'new page')}` : ''}.`, { action: 'Undo', onAction: () => App.history.doUndo() });
    } else App.select([was.headId]);
  }
  function cancel() {
    if (!P) return;
    const was = close();
    const h = App.history;
    h.undo.splice(was.undoLen);
    h.pending = null;
    h.restore(was.before, was.surface0);
    App.S.dirty = was.wasDirty;
    App.updateTitle();
  }

  /* ---------- the rest of Endpaper waits ---------- */
  // Looking around is fine (scrolling, zooming, page thumbnails); changing anything isn't.
  const OK_ZONES = '.pt-panel, .modal-overlay, .cpop, #toasts, .ctx, .right-resize';
  function guard(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (e.type === 'keydown') {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key;
      if (ctrl && k.toLowerCase() === 's') return e.preventDefault(), e.stopPropagation();
      if (t && t.closest(OK_ZONES)) return;
      if (ctrl && ['=', '+', '-', '0', '1'].includes(k)) return;
      if (['Control', 'Shift', 'Alt', 'Meta', 'Tab', 'F11'].includes(k)) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (t && t.closest(OK_ZONES)) return;
    if ((e.type === 'click' || e.type === 'pointerdown') && t && (t.closest('#left-body [data-page]') || t.closest('[data-cmd^="zoom"]'))) return;
    e.stopPropagation();
    if (e.type !== 'pointerdown') e.preventDefault();
  }
  const EVENTS = ['keydown', 'pointerdown', 'click', 'dblclick', 'contextmenu', 'dragstart', 'drop'];
  function lock(on) {
    for (const t of EVENTS) (on ? window.addEventListener : window.removeEventListener).call(window, t, guard, true);
    document.body.classList.toggle('placing', on);
  }

  return { open, format, canFormat, clean, pagesNeeded, place, frame, get active() { return !!P; } };
})();
