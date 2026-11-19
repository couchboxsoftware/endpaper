/* Endpaper app: state, undo, files, export, settings, What's new, the start screen and
   keyboard shortcuts. */
const App = (() => {
  const S = {
    doc: null,
    filePath: null,
    dirty: false,
    rev: 0,
    surface: { kind: 'page', idx: 0 },
    sel: new Set(),
    zoom: 1,
    tool: 'select',
    settings: {},
    leftTab: 'pages',
    rightTab: 'props',
    editing: null,
    crop: null,
    linkFrom: null,
    clip: null,
    version: '',
  };
  const unit = () => S.settings.units || 'mm';
  // Windows paths don't care about capitals (C:\WINDOWS and C:\Windows are the same folder).
  const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  /* ================= undo ================= */
  const history = {
    undo: [],
    redo: [],
    pending: null,
    snap() {
      const { assets, ...rest } = S.doc;
      return JSON.stringify(rest);
    },
    begin() {
      if (this.pending == null && S.doc) this.pending = this.snap();
    },
    commit(label = 'Change', opts = {}) {
      if (this.pending == null) return false;
      const before = this.pending;
      this.pending = null;
      if (before === this.snap()) return false;
      this.undo.push({ label, state: before, surface: { ...S.surface } });
      if (this.undo.length > 300) this.undo.shift();
      this.redo = [];
      markDirty();
      afterChange(opts);
      return true;
    },
    commitSoon: debounce((label) => history.commit(label), 500),
    reset() {
      this.undo = [];
      this.redo = [];
      this.pending = null;
    },
    restore(state, surface) {
      const assets = S.doc.assets;
      S.doc = JSON.parse(state);
      S.doc.assets = assets;
      if (surface) S.surface = surface;
      validateSurface();
      S.sel = new Set([...S.sel].filter((id) => Model.findItem(S.doc, id)));
      S.crop = null;
      markDirty();
      afterChange({ thumbs: 'all' });
    },
    doUndo() {
      if (Text.active) Text.finish();
      this.commitSoon.flush && this.pending != null && this.commit('Change');
      const e = this.undo.pop();
      if (!e) return toast('Nothing to undo.');
      this.redo.push({ label: e.label, state: this.snap(), surface: { ...S.surface } });
      this.restore(e.state, e.surface);
      status(`Undid ${e.label.toLowerCase()}`);
    },
    doRedo() {
      const e = this.redo.pop();
      if (!e) return toast('Nothing to redo.');
      this.undo.push({ label: e.label, state: this.snap(), surface: { ...S.surface } });
      this.restore(e.state, e.surface);
      status(`Redid ${e.label.toLowerCase()}`);
    },
  };

  function change(label, fn, opts = {}) {
    if (!S.doc) return;
    history.begin();
    fn();
    if (!history.commit(label, opts)) afterChange(opts);
  }
  function afterChange(opts = {}) {
    Layout.invalidate();
    if (opts.thumbs === 'all' || S.surface.kind === 'master' || opts.thumbsShared) Panels.invalidateThumbs();
    else for (const s of Editor.spreadSurfaces(S.doc, S.surface)) Panels.invalidateThumbs(s);
    if (S.surface.kind === 'page' && S.doc.cover.enabled) Panels.invalidateThumbs({ kind: 'cover' });
    render();
  }
  function markDirty() {
    S.dirty = true;
    S.rev++;
    updateTitle();
  }
  function validateSurface() {
    const s = S.surface;
    if (s.kind === 'page' && !(s.idx < S.doc.pages.length)) S.surface = { kind: 'page', idx: Math.max(0, S.doc.pages.length - 1) };
    if (s.kind === 'master' && !Model.master(S.doc, s.id)) S.surface = { kind: 'page', idx: 0 };
    if (s.kind === 'master' && !S.doc.facing) s.side = 'right';
    if (s.kind === 'cover' && !S.doc.cover.enabled) S.surface = { kind: 'page', idx: 0 };
  }

  function render() {
    if (!S.doc) return;
    Editor.render();
    Panels.render();
    Panels.refreshThumbsSoon();
    Panels.updateCheckBadge();
    updateToolbar();
  }

  /* ================= selection and navigation ================= */
  function select(ids) {
    S.sel = new Set(ids);
    selectionChanged();
  }
  function selectionChanged() {
    if (S.crop && !S.sel.has(S.crop)) S.crop = null;
    Editor.renderOverlay();
    if (S.rightTab === 'props' || !S.sel.size) Panels.renderRight();
    if (S.leftTab === 'layers') Panels.renderLeft();
  }
  function goTo(surface, { keepSel = false } = {}) {
    const same = Model.sameSurface(surface, S.surface);
    const sameSpread = Editor.spreadSurfaces(S.doc, S.surface).some((s) => Model.sameSurface(s, surface));
    S.surface = { ...surface };
    validateSurface();
    if (!keepSel && !same) S.sel = new Set();
    S.crop = null;
    if (Text.active) Text.finish();
    if (sameSpread) {
      Editor.render();
      Panels.render();
    } else {
      Editor.fit();
      Panels.render();
    }
    updateToolbar();
  }
  function setTool(t) {
    S.tool = t;
    Editor.stage && Editor.stage.classList.toggle('drawing', t !== 'select');
    updateToolbar();
  }

  /* ================= adding things ================= */
  function addItem(type, x, y, w, h) {
    let it;
    change(`Add ${Model.typeName[type].toLowerCase()}`, () => {
      it = Model.newItem(type, x, y, w, h, S.doc);
      Model.surfaceItems(S.doc, S.surface).push(it);
      S.sel = new Set([it.id]);
    });
    setTool('select');
    if (type === 'text') setTimeout(() => Text.edit(it), 30);
    if (type === 'image') pickPhotoFor(it);
    return it;
  }

  async function pickPhotoFor(it) {
    const files = await ep.image.pick(false);
    if (files[0]) await setPhoto(it, files[0]);
  }
  async function setPhoto(it, file) {
    try {
      history.begin();
      const id = await Assets.add(S.doc, file);
      it.asset = id;
      Render.fitImage(it, S.doc.assets[id], it.fit === 'fit' ? 'fit' : 'fill');
      history.commit('Add photo');
      lowResWarning(it);
    } catch (e) {
      history.commit('Add photo');
      toast(e.message, { kind: 'bad' });
    }
  }
  async function placePhotos(files, at) {
    const sz = Model.surfaceSize(S.doc, S.surface);
    history.begin();
    const added = [];
    let n = 0;
    for (const f of files) {
      try {
        const id = await Assets.add(S.doc, f);
        const a = S.doc.assets[id];
        const maxW = sz.w * 0.6, maxH = sz.h * 0.6;
        const sc = Math.min(maxW / a.w, maxH / a.h, 25.4 / 150);
        const w = a.w * sc, h = a.h * sc;
        const it = Model.newItem('image', 0, 0, w, h, S.doc);
        it.x = (at ? at.x : sz.w / 2) - w / 2 + n * 6;
        it.y = (at ? at.y : sz.h / 2) - h / 2 + n * 6;
        it.asset = id;
        it.name = f.name.replace(/\.[^.]+$/, '');
        Render.fitImage(it, a, 'fill');
        Model.surfaceItems(S.doc, S.surface).push(it);
        added.push(it);
        n++;
      } catch (e) {
        toast(e.message, { kind: 'bad' });
      }
    }
    S.sel = new Set(added.map((x) => x.id));
    history.commit(added.length > 1 ? 'Add photos' : 'Add photo');
    added.forEach(lowResWarning);
  }
  function lowResWarning(it) {
    const p = Math.round(Render.ppi(it));
    if (p < 200) toast(`This photo is ${p} ppi at this size, so it will print blurry. Make it smaller for sharper print.`, { kind: 'warn', ms: 7000 });
  }

  function startCrop(it) {
    if (!it.asset) return pickPhotoFor(it);
    S.crop = it.id;
    S.sel = new Set([it.id]);
    Editor.render();
    Panels.renderRight();
    status('Drag to move the photo in its frame, scroll to zoom. Enter or Esc when done.');
  }
  function endCrop() {
    if (!S.crop) return;
    S.crop = null;
    Editor.render();
  }

  /* ================= commands ================= */
  function selectedList() {
    return Model.surfaceItems(S.doc, S.surface).filter((it) => S.sel.has(it.id));
  }
  function cmd(name) {
    if (!S.doc) return;
    const list = Model.surfaceItems(S.doc, S.surface);
    const sel = selectedList();
    if (name === 'selectAll') return select(list.filter((it) => !it.locked && !it.hidden).map((it) => it.id));
    if (name === 'paste') return paste();
    if (!sel.length) return;
    if (name === 'copy' || name === 'cut') {
      const assets = {};
      for (const it of sel) if (it.asset) assets[it.asset] = S.doc.assets[it.asset];
      S.clip = { items: clone(sel), assets };
      if (name === 'copy') return status(`Copied ${sel.length} item${sel.length === 1 ? '' : 's'}`);
    }
    if (name === 'delete' || name === 'cut') {
      const ids = new Set(sel.map((x) => x.id));
      return change(name === 'cut' ? 'Cut' : 'Delete', () => {
        for (const s of Model.allSurfaces(S.doc)) {
          const l = Model.surfaceItems(S.doc, s);
          for (let i = l.length - 1; i >= 0; i--) {
            if (ids.has(l[i].id)) l.splice(i, 1);
            else if (l[i].next && ids.has(l[i].next)) l[i].next = null;
          }
        }
        S.sel = new Set();
      });
    }
    if (name === 'duplicate') {
      return change('Duplicate', () => {
        const copies = sel.map((it) => ({ ...clone(it), id: uid('i'), x: it.x + 5, y: it.y + 5, next: null }));
        list.push(...copies);
        S.sel = new Set(copies.map((c) => c.id));
      });
    }
    if (name === 'lock') {
      const to = !sel.every((it) => it.locked);
      return change(to ? 'Lock' : 'Unlock', () => sel.forEach((it) => (it.locked = to)));
    }
    if (['front', 'forward', 'backward', 'back'].includes(name)) {
      return change('Arrange', () => {
        const ids = new Set(sel.map((x) => x.id));
        if (name === 'front' || name === 'back') {
          const rest = list.filter((x) => !ids.has(x.id));
          const moved = list.filter((x) => ids.has(x.id));
          list.length = 0;
          list.push(...(name === 'front' ? [...rest, ...moved] : [...moved, ...rest]));
        } else if (name === 'forward') {
          for (let i = list.length - 2; i >= 0; i--) if (ids.has(list[i].id) && !ids.has(list[i + 1].id)) [list[i], list[i + 1]] = [list[i + 1], list[i]];
        } else for (let i = 1; i < list.length; i++) if (ids.has(list[i].id) && !ids.has(list[i - 1].id)) [list[i], list[i - 1]] = [list[i - 1], list[i]];
      });
    }
  }
  function paste() {
    if (!S.clip) return;
    change('Paste', () => {
      Object.assign(S.doc.assets, S.clip.assets);
      const list = Model.surfaceItems(S.doc, S.surface);
      const copies = S.clip.items.map((it) => ({ ...clone(it), id: uid('i'), next: null }));
      // Pasting onto the same spot offsets it so you can see the copy.
      const clash = copies.some((c) => list.some((x) => Math.abs(x.x - c.x) < 0.5 && Math.abs(x.y - c.y) < 0.5));
      if (clash) copies.forEach((c) => ((c.x += 5), (c.y += 5)));
      list.push(...copies);
      S.sel = new Set(copies.map((c) => c.id));
      S.clip.items = clone(copies);
    });
  }
  function nudge(dx, dy) {
    const sel = selectedList().filter((it) => !it.locked);
    if (!sel.length) return;
    history.begin();
    sel.forEach((it) => ((it.x += dx), (it.y += dy)));
    Editor.paintSelected();
    history.commitSoon('Nudge');
  }
  function align(mode) {
    const sel = selectedList();
    if (!sel.length) return;
    const sz = Model.surfaceSize(S.doc, S.surface);
    const box = sel.length === 1 ? { x0: 0, y0: 0, x1: sz.w, y1: sz.h } : { x0: Math.min(...sel.map((i) => i.x)), y0: Math.min(...sel.map((i) => i.y)), x1: Math.max(...sel.map((i) => i.x + i.w)), y1: Math.max(...sel.map((i) => i.y + i.h)) };
    change('Align', () => {
      if (mode === 'dist-h' || mode === 'dist-v') {
        const h = mode === 'dist-h';
        const s = [...sel].sort((a, b) => (h ? a.x - b.x : a.y - b.y));
        const total = s.reduce((a, i) => a + (h ? i.w : i.h), 0);
        const gap = ((h ? box.x1 - box.x0 : box.y1 - box.y0) - total) / (s.length - 1);
        let p = h ? box.x0 : box.y0;
        for (const i of s) {
          if (h) i.x = p;
          else i.y = p;
          p += (h ? i.w : i.h) + gap;
        }
        return;
      }
      for (const i of sel) {
        if (mode === 'left') i.x = box.x0;
        if (mode === 'right') i.x = box.x1 - i.w;
        if (mode === 'hcenter') i.x = (box.x0 + box.x1) / 2 - i.w / 2;
        if (mode === 'top') i.y = box.y0;
        if (mode === 'bottom') i.y = box.y1 - i.h;
        if (mode === 'vcenter') i.y = (box.y0 + box.y1) / 2 - i.h / 2;
      }
    });
  }

  /* ================= pages ================= */
  async function pageOp(op) {
    const doc = S.doc;
    let idx = S.surface.kind === 'page' ? S.surface.idx : doc.pages.length - 1;
    if (op === 'delete') {
      const p = doc.pages[idx];
      if (doc.pages.length < 2) return;
      if (p.items.length && !(await ask(`Delete page ${Model.pageNumber(doc, idx)}?`, { detail: 'Everything on it goes too. You can undo this.', ok: 'Delete', danger: true }))) return;
      return change('Delete page', () => {
        const ids = new Set(p.items.map((i) => i.id));
        doc.pages.splice(idx, 1);
        for (const s of Model.allSurfaces(doc)) for (const it of Model.surfaceItems(doc, s)) if (it.next && ids.has(it.next)) it.next = null;
        S.surface = { kind: 'page', idx: Math.min(idx, doc.pages.length - 1) };
        S.sel = new Set();
        Editor.fit();
      }, { thumbs: 'all' });
    }
    change(op === 'duplicate' ? 'Duplicate page' : op === 'earlier' || op === 'later' ? 'Move page' : 'Add page', () => {
      const cur = doc.pages[idx];
      if (op === 'add-after' || op === 'add-before') {
        const np = Model.newPage(doc, cur ? cur.master : 'm-a');
        const at = op === 'add-after' ? idx + 1 : idx;
        doc.pages.splice(at, 0, np);
        S.surface = { kind: 'page', idx: at };
      } else if (op === 'duplicate') {
        const np = clone(cur);
        np.id = uid('p');
        np.items.forEach((it) => ((it.id = uid('i')), (it.next = null)));
        doc.pages.splice(idx + 1, 0, np);
        S.surface = { kind: 'page', idx: idx + 1 };
      } else if (op === 'earlier' && idx > 0) {
        [doc.pages[idx - 1], doc.pages[idx]] = [doc.pages[idx], doc.pages[idx - 1]];
        S.surface = { kind: 'page', idx: idx - 1 };
      } else if (op === 'later' && idx < doc.pages.length - 1) {
        [doc.pages[idx + 1], doc.pages[idx]] = [doc.pages[idx], doc.pages[idx + 1]];
        S.surface = { kind: 'page', idx: idx + 1 };
      }
      S.sel = new Set();
    }, { thumbs: 'all' });
    Editor.fit();
  }

  /* ================= brand kit ================= */
  const kit = {
    data: { swatches: [], styles: [], logos: [], fonts: [] },
    async load() {
      this.data = { swatches: [], styles: [], logos: [], fonts: [], ...(await ep.brandkit.get()) };
    },
    save() {
      ep.brandkit.set(this.data);
      if (S.rightTab === 'brand') Panels.renderRight();
    },
    addSwatches(list) {
      let n = 0;
      for (const s of list) {
        if (this.data.swatches.some((x) => x.name === s.name && x.c === s.c && x.m === s.m && x.y === s.y && x.k === s.k)) continue;
        this.data.swatches.push({ name: s.name, c: s.c, m: s.m, y: s.y, k: s.k });
        n++;
      }
      this.save();
      toast(n ? `Saved ${n} colour${n === 1 ? '' : 's'} in your brand kit.` : 'Those colours are already in your brand kit.');
    },
    addStyles(list) {
      let n = 0;
      for (const s of list) {
        const { id, ...rest } = s;
        const color = Model.resolveColor(S.doc, s.color);
        const i = this.data.styles.findIndex((x) => x.name === s.name);
        if (i >= 0) this.data.styles[i] = { ...rest, color };
        else this.data.styles.push({ ...rest, color });
        n++;
      }
      this.save();
      toast(`Saved ${n} style${n === 1 ? '' : 's'} in your brand kit.`);
    },
    addLogo(it) {
      const a = it && S.doc.assets[it.asset];
      if (!a) return;
      this.data.logos.push({ name: it.name || a.name.replace(/\.[^.]+$/, ''), mime: a.mime, data: a.data });
      this.save();
      toast('Saved in your brand kit.');
    },
    useSwatch(i) {
      const s = this.data.swatches[i];
      let sw = S.doc.swatches.find((x) => x.c === s.c && x.m === s.m && x.y === s.y && x.k === s.k);
      change('Brand colour', () => {
        if (!sw) S.doc.swatches.push((sw = { id: uid('sw'), ...s }));
        for (const it of selectedList()) {
          if (it.type === 'text') {
            const shared = it.styleId && S.doc.styles.find((x) => x.id === it.styleId);
            (shared || it.style).color = { sw: sw.id };
          } else if (it.type === 'line') it.stroke = { sw: sw.id };
          else if (it.type !== 'image') it.fill = { sw: sw.id };
        }
      });
    },
    useStyle(i) {
      const s = this.data.styles[i];
      Fonts.load(s.font).then(() =>
        change('Brand style', () => {
          let st = S.doc.styles.find((x) => x.name === s.name);
          if (st) Object.assign(st, clone(s));
          else S.doc.styles.push((st = { ...clone(s), id: uid('st') }));
          for (const it of selectedList()) if (it.type === 'text') (it.styleId = st.id), (it.styleOverride = null);
          toast(`“${s.name}” is in this document's text styles.`);
        })
      );
    },
    useLogo(i) {
      const l = this.data.logos[i];
      placePhotos([{ name: l.name, mime: l.mime, bytes: base64ToBytes(l.data) }]);
    },
    remove(kind, idx) {
      this.data[kind].splice(idx, 1);
      this.save();
    },
  };

  /* ================= files ================= */
  function serialize({ forFile = false } = {}) {
    const d = clone(S.doc);
    if (forFile) Model.pruneAssets(d);
    try {
      d.thumb = Render.thumb(S.doc, { kind: 'page', idx: 0 }, 260).toDataURL('image/jpeg', 0.75);
    } catch {}
    return JSON.stringify(d);
  }
  async function save(saveAs = false) {
    if (!S.doc) return false;
    if (Text.active) Text.finish();
    const p = await ep.file.save({ path: S.filePath, text: serialize({ forFile: true }), name: S.doc.name, saveAs });
    if (!p) return false;
    S.filePath = p;
    S.dirty = false;
    ep.recovery.clear(S.doc.id);
    updateTitle();
    toast('Saved.');
    return true;
  }
  async function saveTemplate() {
    const name = await prompt('Save as a template', S.doc.name, { ok: 'Save template', label: 'Templates show on the start screen, ready to copy for your next job.' });
    if (!name) return;
    const d = JSON.parse(serialize({ forFile: true }));
    d.name = name.trim();
    await ep.templates.save({ name: name.trim(), text: JSON.stringify(d) });
    toast(`Saved “${name.trim()}” as a template.`);
  }
  // true when it's OK to throw the current document away.
  async function confirmDiscard() {
    if (!S.doc || !S.dirty) return true;
    const r = await ep.app.confirm({ message: `Save changes to “${S.doc.name}”?`, detail: "If you don't, your changes since the last save are lost.", buttons: ['Save', "Don't save", 'Cancel'], cancelId: 2 });
    if (r === 2) return false;
    if (r === 0) return await save();
    ep.recovery.clear(S.doc.id);
    return true;
  }
  async function openFile(path) {
    if (!(await confirmDiscard())) return;
    try {
      const r = path ? await ep.file.read(path) : await ep.file.open();
      if (!r) return;
      await loadDoc(JSON.parse(r.text), r.path);
    } catch (e) {
      console.error(e);
      toast("That file couldn't be opened. It may not be an Endpaper design.", { kind: 'bad' });
    }
  }
  async function loadDoc(doc, path, { dirty = false } = {}) {
    if (doc.format !== 'endpaper') throw new Error('not an endpaper file');
    delete doc.thumb;
    delete doc.filePath;
    Model.normalise(doc);
    showLoading(true);
    try {
      await Fonts.ensureDoc(doc);
      await Assets.ensureDoc(doc);
    } finally {
      showLoading(false);
    }
    S.doc = doc;
    S.filePath = path || null;
    S.dirty = dirty;
    S.surface = { kind: 'page', idx: 0 };
    S.sel = new Set();
    S.crop = null;
    history.reset();
    Layout.invalidate();
    Panels.invalidateThumbs();
    showEditor();
    updateTitle();
    requestAnimationFrame(() => Editor.fit());
    render();
  }
  async function newDocument(opts) {
    if (!(await confirmDiscard())) return;
    const doc = Model.newDoc({ bleed: S.settings.bleed ?? 3, ...opts });
    await loadDoc(doc, null, { dirty: false });
  }
  async function fromTemplate(t) {
    if (!(await confirmDiscard())) return;
    const d = JSON.parse(await ep.templates.read(t.path));
    d.id = uid('d');
    await loadDoc(d, null);
    S.dirty = true;
    updateTitle();
  }
  async function closeDoc() {
    if (!(await confirmDiscard())) return;
    S.doc = null;
    S.filePath = null;
    S.dirty = false;
    showHome();
  }

  // Unsaved work is copied to a recovery file every 20 seconds, so a crash loses little.
  let recRev = -1;
  setInterval(() => {
    if (!S.doc || !S.dirty || recRev === S.rev) return;
    recRev = S.rev;
    const d = JSON.parse(JSON.stringify(S.doc));
    d.filePath = S.filePath;
    ep.recovery.write({ id: S.doc.id, text: JSON.stringify(d) });
  }, 20000);

  /* ================= export ================= */
  async function openExport() {
    if (!S.doc) return;
    if (Text.active) Text.finish();
    const doc = S.doc;
    const issues = Preflight.run(doc).filter((i) => i.level !== 'info');
    const errs = issues.filter((i) => i.level === 'error').length;
    const profiles = await ep.icc.list();
    const curPage = S.surface.kind === 'page' ? S.surface.idx : 0;
    const isBook = doc.facing && doc.cover.enabled;
    const m = openModal({
      title: 'Export',
      wide: true,
      body: `<div class="export">
        <div class="ex-col">
          <div class="field field-wide"><span>Export</span><select class="input" data-x="what">
            ${isBook ? '<option value="book">Book: inside pages and cover (2 PDFs)</option>' : ''}
            <option value="all">All pages</option>
            <option value="current">This page (${Model.pageNumber(doc, curPage)})</option>
            <option value="range">Pages…</option>
            ${doc.cover.enabled ? '<option value="cover">Cover only</option>' : ''}
          </select></div>
          <div class="field field-wide" data-show="range" hidden><span>Pages</span><input class="input" data-x="range" placeholder="e.g. 1-4, 7"></div>
          <div class="field field-wide"><span>As</span><div class="seg" data-xseg="format"><button class="on" data-v="pdf">Print PDF</button><button data-v="png">PNG</button><button data-v="jpg">JPG</button></div></div>
          <div data-show="pdf">
            <label class="switch"><input type="checkbox" data-x="bleed" checked><span>Include bleed (${doc.bleed} mm)</span></label>
            <label class="switch"><input type="checkbox" data-x="crop" ${S.settings.cropMarks !== false && !isBook ? 'checked' : ''}><span>Crop marks</span></label>
            ${doc.facing ? '<label class="switch"><input type="checkbox" data-x="spine"><span>No bleed on the spine edge (what print-on-demand sites ask for)</span></label>' : ''}
            <div class="field field-wide"><span>Colour profile</span><select class="input" data-x="profile">${profiles.map((p) => `<option value="${esc(p.path)}" ${samePath(p.path, S.settings.profile) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}${profiles.length ? '' : '<option value="">None found</option>'}</select></div>
            <p class="hint">Ask your printer which profile they want. Coated FOGRA39 suits most UK and European printers on coated paper.</p>
          </div>
          <div data-show="img" hidden>
            <div class="grid2"><label class="field"><span>Resolution</span><input class="input" data-x="dpi" value="${doc.dpi || 300}"><em>dpi</em></label></div>
            <label class="switch"><input type="checkbox" data-x="ibleed"><span>Include bleed</span></label>
            <p class="hint">PNG and JPG are RGB images for screens, social media or proofs. For printing, use Print PDF.</p>
          </div>
        </div>
        <div class="ex-col ex-check">
          <h5>Check</h5>
          ${issues.length ? `<p>${errs ? `<b class="bad">${errs} to fix</b> ` : ''}${issues.length - errs ? `<b class="warn">${issues.length - errs} to check</b>` : ''}</p><div class="ex-issues">${issues.slice(0, 6).map((i) => `<div class="issue ${i.level}"><i>!</i><span><b>${esc(i.where)}</b> ${esc(i.text)}</span></div>`).join('')}${issues.length > 6 ? `<p class="hint">And ${issues.length - 6} more in the Check tab.</p>` : ''}</div>` : '<p class="ok-big">✓ Ready to print.</p>'}
          <div class="ex-summary"></div>
        </div></div>
        <div class="ex-progress" hidden><div class="bar"><i></i></div><span></span></div>
        <div class="modal-actions"><button class="btn btn-ghost" data-a="no">Cancel</button><button class="btn btn-accent" data-a="go">${errs ? 'Export anyway' : 'Export'}</button></div>`,
    });
    const el = m.el;
    let format = 'pdf';
    const q = (k) => $(`[data-x="${k}"]`, el);
    const refresh = () => {
      $('[data-show="range"]', el).hidden = q('what').value !== 'range';
      $('[data-show="pdf"]', el).hidden = format !== 'pdf';
      $('[data-show="img"]', el).hidden = format === 'pdf';
      const what = q('what').value;
      let txt = '';
      if (format === 'pdf') txt = `PDF/X-4 · CMYK · photos converted with ${q('profile')?.selectedOptions[0]?.text || 'no profile'} · fonts embedded`;
      else {
        const dpi = +q('dpi').value || 300;
        const sz = what === 'cover' ? Model.cover(doc) : doc;
        const b = q('ibleed').checked ? doc.bleed * 2 : 0;
        txt = `${Math.round(((sz.w + b) / 25.4) * dpi)} × ${Math.round(((sz.h + b) / 25.4) * dpi)} px each`;
      }
      if (what === 'book') txt += `<br>Spine ${Model.cover(doc).spine.toFixed(2)} mm for ${Model.coverPages(doc)} pages`;
      $('.ex-summary', el).innerHTML = `<p class="hint">${txt}</p>`;
    };
    refresh();
    el.addEventListener('change', refresh);
    el.addEventListener('input', refresh);
    $('[data-xseg="format"]', el).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      format = b.dataset.v;
      $$('[data-xseg="format"] button', el).forEach((x) => x.classList.toggle('on', x === b));
      if (format !== 'pdf' && q('what').value === 'book') q('what').value = 'all';
      refresh();
    });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'no') return m.close();
      const what = q('what').value;
      let idxs = doc.pages.map((_, i) => i);
      if (what === 'current') idxs = [curPage];
      if (what === 'range') {
        idxs = parseRange(q('range').value, doc);
        if (!idxs.length) return toast('Type the pages to export, like 1-4, 7.', { kind: 'warn' });
      }
      const pages = idxs.map((idx) => ({ kind: 'page', idx }));
      b.disabled = true;
      $('.ex-progress', el).hidden = false;
      const prog = (f, label) => {
        $('.ex-progress i', el).style.width = Math.round(f * 100) + '%';
        $('.ex-progress span', el).textContent = label || '';
      };
      try {
        if (format === 'pdf') {
          const prof = q('profile').value;
          if (prof && !samePath(prof, S.settings.profile)) {
            S.settings = await ep.settings.set({ profile: prof });
            await loadProfile();
          }
          const common = { bleed: q('bleed').checked, cropMarks: q('crop').checked, pdfx: true, maxPpi: 450, targetPpi: 300, quality: S.settings.imageQuality || 92 };
          const jobs = [];
          if (what === 'book') {
            jobs.push({ surfaces: pages, name: `${doc.name} - inside.pdf`, noSpineBleed: q('spine')?.checked, title: `${doc.name} (inside)` });
            jobs.push({ surfaces: [{ kind: 'cover' }], name: `${doc.name} - cover.pdf`, title: `${doc.name} (cover)` });
          } else if (what === 'cover') jobs.push({ surfaces: [{ kind: 'cover' }], name: `${doc.name} - cover.pdf`, title: `${doc.name} (cover)` });
          else jobs.push({ surfaces: pages, name: `${doc.name}.pdf`, noSpineBleed: q('spine')?.checked, title: doc.name });
          const saved = [];
          for (const [ji, job] of jobs.entries()) {
            const bytes = await Pdf.build(doc, { ...common, ...job }, (f, s) => prog((ji + f) / jobs.length, s ? `Making ${job.name}: ${s.kind === 'cover' ? 'cover' : 'page ' + Model.pageNumber(doc, s.idx)}…` : 'Finishing…'));
            const p = await ep.file.export({ bytes, name: job.name, ext: 'pdf', label: 'PDF' });
            if (p) saved.push(p);
          }
          m.close();
          if (saved.length) toast(`Exported ${saved.length === 1 ? saved[0].split(/[\\/]/).pop() : saved.length + ' PDFs'}.`, { action: 'Show in folder', onAction: () => ep.app.reveal(saved[0]), ms: 8000 });
        } else {
          const dpi = clamp(+q('dpi').value || 300, 30, 1200);
          const surfaces = what === 'cover' ? [{ kind: 'cover' }] : pages;
          const files = [];
          for (const [i, s] of surfaces.entries()) {
            prog(i / surfaces.length, `Drawing ${s.kind === 'cover' ? 'cover' : 'page ' + Model.pageNumber(doc, s.idx)}…`);
            await sleep(0);
            files.push({ name: `${doc.name}${surfaces.length > 1 ? ` - ${s.kind === 'cover' ? 'cover' : 'page ' + Model.pageNumber(doc, s.idx)}` : ''}.${format}`, bytes: await raster(doc, s, dpi, q('ibleed').checked, format) });
          }
          prog(1, 'Saving…');
          let p;
          if (files.length === 1) p = await ep.file.export({ bytes: files[0].bytes, name: files[0].name, ext: format, label: format.toUpperCase() });
          else p = await ep.file.exportMany({ files });
          m.close();
          if (p) toast(`Exported ${files.length} image${files.length === 1 ? '' : 's'}.`, { action: 'Show in folder', onAction: () => ep.app.reveal(files.length === 1 ? p : p + '\\' + files[0].name), ms: 8000 });
        }
      } catch (err) {
        console.error(err);
        b.disabled = false;
        $('.ex-progress', el).hidden = true;
        toast(`The export didn't work: ${err.message}`, { kind: 'bad', ms: 9000 });
      }
    });
  }
  function parseRange(text, doc) {
    const out = new Set();
    for (const part of String(text).split(/[,\s]+/).filter(Boolean)) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = +m[1], b = m[2] ? +m[2] : a;
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) {
        const idx = n - doc.pageStart;
        if (idx >= 0 && idx < doc.pages.length) out.add(idx);
      }
    }
    return [...out].sort((a, b) => a - b);
  }
  async function raster(doc, s, dpi, bleed, format) {
    const sz = Model.surfaceSize(doc, s);
    const b = bleed ? sz.bleed : 0;
    const scale = dpi / 25.4;
    const c = document.createElement('canvas');
    c.width = Math.round((sz.w + 2 * b) * scale);
    c.height = Math.round((sz.h + 2 * b) * scale);
    if (c.width * c.height > 200e6) throw new Error('that size is too big for one image. Try a lower resolution.');
    Render.draw(c.getContext('2d'), doc, s, scale, { bleed });
    const blob = await new Promise((r) => c.toBlob(r, format === 'png' ? 'image/png' : 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return format === 'png' ? pngDpi(bytes, dpi) : jpgDpi(bytes, dpi);
  }
  // Writes the resolution into the file, so other apps open it at the right size.
  function pngDpi(bytes, dpi) {
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4);
    dv.setUint32(8, ppm);
    dv.setUint32(12, ppm);
    chunk[16] = 1;
    dv.setUint32(17, crc32(chunk.subarray(4, 17)));
    const at = 33; // after the signature and IHDR
    const out = new Uint8Array(bytes.length + 21);
    out.set(bytes.subarray(0, at));
    out.set(chunk, at);
    out.set(bytes.subarray(at), at + 21);
    return out;
  }
  function jpgDpi(bytes, dpi) {
    if (bytes[2] === 0xff && bytes[3] === 0xe0 && bytes[6] === 0x4a) {
      bytes[13] = 1;
      bytes[14] = dpi >> 8;
      bytes[15] = dpi & 255;
      bytes[16] = dpi >> 8;
      bytes[17] = dpi & 255;
    }
    return bytes;
  }
  let crcT;
  function crc32(u8) {
    if (!crcT) {
      crcT = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcT[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (const b of u8) c = crcT[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ================= settings and What's new ================= */
  async function loadProfile() {
    let ok = false;
    if (S.settings.profile) {
      try {
        const bytes = await ep.icc.read(S.settings.profile);
        ok = await Color.init(bytes, S.settings.intent, S.settings.profile.split(/[\\/]/).pop().replace(/\.(icc|icm)$/i, ''));
      } catch {}
    }
    if (!ok) await Color.init(null);
    $('#st-profile').textContent = Color.ready ? Color.profileName : 'No colour profile';
    Panels.invalidateThumbs();
    for (const el of $$('.item')) el._sig = null;
  }

  async function openSettings(tab) {
    tab = tab || S.settings.settingsTab || 'general';
    const profiles = await ep.icc.list();
    const changelog = await ep.changelog.get();
    const set = S.settings;
    const m = openModal({
      title: 'Settings',
      wide: true,
      cls: 'settings',
      body: `<div class="tabs" data-stabs>${[['general', 'General'], ['colour', 'Colour'], ['export', 'Export'], ['app', 'App']].map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="stab" data-tab="general">
          <div class="field field-wide"><span>Units</span><div class="seg" data-sset="units">${Units.list.map((u) => `<button data-v="${u}" class="${set.units === u ? 'on' : ''}">${u}</button>`).join('')}</div></div>
          <div class="grid2"><label class="field"><span>New bleed</span><input class="input" data-sn="bleed" value="${set.bleed ?? 3}"><em>mm</em></label></div>
          <label class="switch"><input type="checkbox" data-sc="snap" ${set.snap !== false ? 'checked' : ''}><span>Snap to edges, margins and other boxes (hold Ctrl to stop it)</span></label>
          <label class="switch"><input type="checkbox" data-sc="showGuides" ${set.showGuides !== false ? 'checked' : ''}><span>Show bleed and margin guides</span></label>
          <div class="field field-wide"><span>Opens</span><select class="input" data-ss="openMode">${[['last', 'As you left it'], ['window', 'In a window'], ['maximised', 'Maximised'], ['fullscreen', 'Full screen']].map(([v, l]) => `<option value="${v}" ${set.openMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        <div class="stab" data-tab="colour">
          <div class="field field-wide"><span>Printing profile</span><select class="input" data-ss="profile">${profiles.map((p) => `<option value="${esc(p.path)}" ${samePath(p.path, set.profile) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
          <div class="btn-row"><button class="btn btn-sm" data-act="add-profile">Add a profile from your printer…</button></div>
          <p class="hint">Used to show colours as they'll print and to turn photos into CMYK. Coated FOGRA39 suits most UK and European printers on coated paper. Ask your printer if you're not sure.</p>
          <div class="field field-wide"><span>Photos</span><select class="input" data-ss="intent"><option value="relative" ${set.intent !== 'perceptual' ? 'selected' : ''}>Keep colours accurate (relative colorimetric)</option><option value="perceptual" ${set.intent === 'perceptual' ? 'selected' : ''}>Keep bright photos smooth (perceptual)</option></select></div>
        </div>
        <div class="stab" data-tab="export">
          <label class="switch"><input type="checkbox" data-sc="cropMarks" ${set.cropMarks !== false ? 'checked' : ''}><span>Crop marks on new exports</span></label>
          <div class="grid2"><label class="field"><span>Photo quality</span><input class="input" data-sn="imageQuality" value="${set.imageQuality || 92}"><em>of 100</em></label></div>
          <p class="hint">Photos sharper than 450 ppi are reduced to 300 ppi to keep files a sensible size.</p>
        </div>
        <div class="stab" data-tab="app">
          <p>${BRAND.wordmark} <span class="muted">version ${esc(S.version)}</span></p>
          <div class="up-section">${Updates.settingsHtml()}</div>
          <h5>What's new</h5>
          <div class="whatsnew">${changelog.map(whatsNewEntry).join('')}</div>
        </div>`,
    });
    const showTab = (t) => {
      $$('[data-stabs] button', m.el).forEach((b) => b.classList.toggle('on', b.dataset.t === t));
      $$('.stab', m.el).forEach((s) => (s.hidden = s.dataset.tab !== t));
      ep.settings.set({ settingsTab: t }).then((s) => (S.settings = s));
    };
    showTab(tab);
    m.el.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-t]');
      if (t) return showTab(t.dataset.t);
      const sb = e.target.closest('[data-sset] button');
      if (sb) {
        $$('button', sb.parentElement).forEach((x) => x.classList.toggle('on', x === sb));
        return applySetting({ [sb.parentElement.dataset.sset]: sb.dataset.v });
      }
      if (e.target.closest('[data-act="add-profile"]')) {
        const r = await ep.icc.add();
        if (!r) return;
        if (r.error) return toast(r.error, { kind: 'bad' });
        await applySetting({ profile: r.path });
        m.close();
        openSettings('colour');
      }
    });
    m.el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.sc) applySetting({ [t.dataset.sc]: t.checked });
      if (t.dataset.ss) applySetting({ [t.dataset.ss]: t.value });
      if (t.dataset.sn) applySetting({ [t.dataset.sn]: parseFloat(t.value) || 0 });
    });
  }
  async function applySetting(patch) {
    S.settings = await ep.settings.set(patch);
    if ('profile' in patch || 'intent' in patch) await loadProfile();
    if (S.doc) render();
    updateStatusUnits();
  }
  const whatsNewEntry = (e) =>
    `<div class="wn"><div class="wn-head"><b>${esc(e.version)}</b><span class="muted">${esc(e.date)}</span></div><p>${esc(e.headline)}</p>${e.groups.map((g) => `<h6>${esc(g.name)}</h6><ul>${g.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`).join('')}</div>`;
  async function showWhatsNew() {
    const log = await ep.changelog.get();
    const e = log[0];
    if (!e) return;
    const m = openModal({ title: `What's new in ${e.version}`, body: whatsNewEntry(e) + `<div class="modal-actions"><button class="btn btn-accent" data-a="ok">Got it</button></div>` });
    $('[data-a="ok"]', m.el).onclick = () => m.close();
  }

  /* ================= the start screen ================= */
  async function showHome() {
    $('#editor').hidden = true;
    $('#home').hidden = false;
    document.title = 'Endpaper';
    const [recent, templates, recovery] = await Promise.all([ep.recent.list(), ep.templates.list(), ep.recovery.list()]);
    $('#home').innerHTML = `<div class="home">
      <header class="home-head"><div class="brand big">${BRAND.icon}${BRAND.wordmark}</div><button class="icon-btn" data-h="settings" title="Settings">⚙</button></header>
      ${recovery.length ? `<section class="recover"><h3>Recover unsaved work</h3><p class="muted">Endpaper closed before these were saved.</p>${recovery.map((r) => `<div class="rec-row"><b>${esc(r.name)}</b><span class="muted">${timeAgo(r.saved)}</span><button class="btn btn-sm btn-accent" data-rec="${r.id}">Open it</button><button class="btn btn-sm btn-ghost" data-recdel="${r.id}">Discard</button></div>`).join('')}</section>` : ''}
      <section class="home-new">
        <button class="big-btn" data-h="new-print"><span class="bb-icon">▭</span><b>New design</b><span>Flyers, posters, cards and other print</span></button>
        <button class="big-btn" data-h="new-book"><span class="bb-icon">${BRAND.icon}</span><b>New book</b><span>Spreads, page numbers and a cover with the spine worked out</span></button>
        <button class="big-btn" data-h="open"><span class="bb-icon">⇪</span><b>Open…</b><span>An Endpaper design (.endpaper)</span></button>
      </section>
      ${templates.length ? `<section><h3>Your templates</h3><div class="tpl-grid">${templates.map((t, i) => `<button class="tpl" data-tpl="${i}" title="Start a new design from this template">${t.thumb ? `<img src="${t.thumb}" alt="">` : '<div class="tpl-empty"></div>'}<b>${esc(t.name)}</b><span class="muted">${timeAgo(t.modified)}</span></button>`).join('')}</div><p class="hint">Right-click a template to delete it. Deleted templates stay in the <a href="#" data-h="bin">bin</a> for 30 days.</p></section>` : `<section><h3>Your templates</h3><p class="hint">Save any design as a template (⋯ menu, Save as template) and it shows here, ready to copy for the next job. <a href="#" data-h="bin">Bin</a></p></section>`}
      ${recent.length ? `<section><h3>Recent</h3><div class="recent">${recent.map((r, i) => `<button class="recent-row" data-recent="${i}"><b>${esc(r.name)}</b><span class="muted">${esc(r.path)}</span><span class="muted">${timeAgo(r.modified)}</span></button>`).join('')}</div></section>` : ''}
      <footer class="muted">Version ${esc(S.version)} · <a href="#" data-h="whatsnew">What's new</a></footer>
    </div>`;
    const home = $('#home');
    home.onclick = async (e) => {
      const h = e.target.closest('[data-h]');
      if (h) {
        e.preventDefault();
        const a = h.dataset.h;
        if (a === 'new-print') return newDialog('print');
        if (a === 'new-book') return newDialog('book');
        if (a === 'open') return openFile();
        if (a === 'settings') return openSettings();
        if (a === 'bin') return binDialog();
        if (a === 'whatsnew') return openSettings('app');
      }
      const t = e.target.closest('[data-tpl]');
      if (t) return fromTemplate(templates[+t.dataset.tpl]);
      const r = e.target.closest('[data-recent]');
      if (r) return openFile(recent[+r.dataset.recent].path);
      const rec = e.target.closest('[data-rec]');
      if (rec) {
        const text = await ep.recovery.read(rec.dataset.rec);
        const d = JSON.parse(text);
        const fp = d.filePath;
        await loadDoc(d, fp || null, { dirty: true });
        S.dirty = true;
        updateTitle();
        return;
      }
      const rd = e.target.closest('[data-recdel]');
      if (rd) {
        if (await ask('Discard this unsaved work?', { ok: 'Discard', danger: true })) {
          await ep.recovery.clear(rd.dataset.recdel);
          showHome();
        }
      }
    };
    home.oncontextmenu = (e) => {
      const t = e.target.closest('[data-tpl]');
      if (!t) return;
      e.preventDefault();
      const tp = templates[+t.dataset.tpl];
      contextMenu(e.clientX, e.clientY, [
        { label: 'New design from this', run: () => fromTemplate(tp) },
        { label: 'Delete template', run: async () => {
          const binned = await ep.templates.delete(tp.path);
          showHome();
          toast(`Moved “${tp.name}” to the bin.`, { action: 'Undo', onAction: async () => (await ep.bin.restore(binned), showHome()) });
        } },
      ]);
    };
  }

  async function binDialog() {
    const list = await ep.bin.list();
    const m = openModal({
      title: 'Bin',
      body: list.length
        ? `<p class="hint">Deleted templates are kept for 30 days.</p>${list.map((b, i) => `<div class="rec-row"><b>${esc(b.name)}</b><span class="muted">deleted ${timeAgo(b.deleted)}</span><button class="btn btn-sm" data-restore="${i}">Put back</button></div>`).join('')}<div class="modal-actions"><button class="btn btn-danger" data-empty="1">Empty the bin</button></div>`
        : '<p class="muted">The bin is empty.</p>',
    });
    m.el.addEventListener('click', async (e) => {
      const r = e.target.closest('[data-restore]');
      if (r) {
        await ep.bin.restore(list[+r.dataset.restore].path);
        m.close();
        showHome();
        toast('Put back.');
      }
      if (e.target.closest('[data-empty]') && (await ask('Empty the bin?', { detail: "These templates will be gone for good. This can't be undone.", ok: 'Empty the bin', danger: true }))) {
        await ep.bin.empty();
        m.close();
      }
    });
  }

  function newDialog(kind) {
    let u = unit();
    const book = kind === 'book';
    let w = book ? 129 : 210, h = book ? 198 : 297;
    let dpi = 300;
    const m = openModal({
      title: book ? 'New book' : 'New design',
      wide: true,
      body: `<div class="newdoc"><div class="nd-col">
        <label class="field field-wide"><span>Name</span><input class="input" data-n="name" value="${book ? 'My book' : 'Untitled'}" autofocus></label>
        <div class="field field-wide"><span>Size</span><select class="input" data-n="preset"><option value="">Custom size</option>${Model.PRESETS.map((g) => `<optgroup label="${esc(g.group)}">${g.items.map(([n, pw, ph]) => `<option value="${pw}x${ph}" ${pw === w && ph === h ? 'selected' : ''}>${esc(n)} (${pw} × ${ph} mm)</option>`).join('')}</optgroup>`).join('')}</select></div>
        <div class="field field-wide"><span>Units</span><div class="seg" data-nunit>${Units.list.map((x) => `<button data-v="${x}" class="${x === u ? 'on' : ''}">${x}</button>`).join('')}</div></div>
        <div class="grid2">
          <label class="field"><span>Width</span><input class="input" data-n="w"><em data-u></em></label>
          <label class="field"><span>Height</span><input class="input" data-n="h"><em data-u></em></label>
          <label class="field" data-dpi hidden><span>At</span><input class="input" data-n="dpi" value="300"><em>dpi</em></label>
          <label class="field"><span>Bleed</span><input class="input" data-n="bleed" value="${S.settings.bleed ?? 3}"><em>mm</em></label>
          <label class="field"><span>Pages</span><input class="input" data-n="pages" value="${book ? 24 : 1}"></label>
        </div>
        <div class="btn-row"><button class="btn btn-sm" data-swap="1">⤾ Swap to ${w > h ? 'portrait' : 'landscape'}</button></div>
        ${book ? '<p class="hint">Books get facing pages, an A-Master with page numbers, and a cover with the spine worked out from the page count.</p>' : '<label class="switch"><input type="checkbox" data-n="facing"><span>Facing pages (for brochures and booklets)</span></label>'}
        </div><div class="nd-col nd-preview"><div class="nd-page"></div><p class="nd-size muted"></p></div></div>
        <div class="modal-actions"><button class="btn btn-ghost" data-a="no">Cancel</button><button class="btn btn-accent" data-a="yes">Create</button></div>`,
    });
    const el = m.el;
    const n = (k) => $(`[data-n="${k}"]`, el);
    const show = () => {
      n('w').value = Units.fmt(w, u, dpi);
      n('h').value = Units.fmt(h, u, dpi);
      $$('[data-u]', el).forEach((x) => (x.textContent = u));
      $('[data-dpi]', el).hidden = u !== 'px';
      const pv = $('.nd-page', el);
      const sc = Math.min(200 / w, 200 / h);
      pv.style.width = w * sc + 'px';
      pv.style.height = h * sc + 'px';
      $('.nd-size', el).textContent = `${Units.fmt(w, 'mm')} × ${Units.fmt(h, 'mm')} mm · ${Units.fmt(w, 'cm')} × ${Units.fmt(h, 'cm')} cm · ${Units.fmt(w, 'px', dpi)} × ${Units.fmt(h, 'px', dpi)} px at ${dpi} dpi`;
      $('[data-swap]', el).textContent = `⤾ Swap to ${w > h ? 'portrait' : 'landscape'}`;
      const match = Model.PRESETS.flatMap((g) => g.items).find(([, pw, ph]) => Math.abs(pw - w) < 0.05 && Math.abs(ph - h) < 0.05);
      n('preset').value = match ? `${match[1]}x${match[2]}` : '';
    };
    show();
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t === n('preset') && t.value) [w, h] = t.value.split('x').map(Number);
      if (t === n('w')) w = Units.parse(t.value, u, dpi) || w;
      if (t === n('h')) h = Units.parse(t.value, u, dpi) || h;
      if (t === n('dpi')) dpi = clamp(parseInt(t.value) || 300, 30, 2400);
      w = clamp(w, 10, 5000);
      h = clamp(h, 10, 5000);
      show();
    });
    el.addEventListener('click', (e) => {
      const ub = e.target.closest('[data-nunit] button');
      if (ub) {
        u = ub.dataset.v;
        $$('[data-nunit] button', el).forEach((x) => x.classList.toggle('on', x === ub));
        return show();
      }
      if (e.target.closest('[data-swap]')) return ([w, h] = [h, w]), show();
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'no') return m.close();
      // Catch a size typed but not yet confirmed.
      w = Units.parse(n('w').value, u, dpi) || w;
      h = Units.parse(n('h').value, u, dpi) || h;
      const pages = clamp(parseInt(n('pages').value) || 1, 1, 2000);
      const opts = { name: n('name').value.trim() || 'Untitled', w, h, dpi, bleed: clamp(parseFloat(n('bleed').value) || 0, 0, 25), pages, kind, facing: book || !!(n('facing') && n('facing').checked) };
      m.close();
      newDocument(opts);
    });
  }

  /* ================= chrome: toolbar, status, title ================= */
  function showEditor() {
    $('#home').hidden = true;
    $('#editor').hidden = false;
  }
  function showLoading(on) {
    document.body.classList.toggle('loading', on);
  }
  function updateTitle() {
    if (!S.doc) return;
    const name = S.doc.name || 'Untitled';
    document.title = `${S.dirty ? '• ' : ''}${name} - Endpaper`;
    $('#doc-name').textContent = name;
    $('#doc-dirty').hidden = !S.dirty;
  }
  function updateToolbar() {
    $$('#tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
    $('#btn-undo').disabled = !history.undo.length;
    $('#btn-redo').disabled = !history.redo.length;
    const s = S.surface;
    $('#st-page').textContent = s.kind === 'page' ? `Page ${Model.pageNumber(S.doc, s.idx)} of ${S.doc.pages.length}` : s.kind === 'cover' ? 'Cover' : `Master: ${Model.master(S.doc, s.id)?.name}`;
    updateStatusUnits();
  }
  function updateStatusUnits() {
    $$('#units button').forEach((b) => b.classList.toggle('on', b.dataset.v === unit()));
    $('#st-dpi').textContent = unit() === 'px' && S.doc ? `px at ${S.doc.dpi} dpi` : '';
  }
  function zoomChanged() {
    $('#zoom-pct').textContent = Math.round((S.zoom / (96 / 25.4)) * 100) + '%';
  }
  const status = (t) => ($('#st-pos').textContent = t);

  function bindChrome() {
    $('#tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (b) setTool(b.dataset.tool);
    });
    $('#topbar').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      const c = b.dataset.cmd;
      if (c === 'home') return closeDoc();
      if (c === 'undo') return history.doUndo();
      if (c === 'redo') return history.doRedo();
      if (c === 'zoom-in') return Editor.zoomAt(S.zoom * 1.25);
      if (c === 'zoom-out') return Editor.zoomAt(S.zoom / 1.25);
      if (c === 'zoom-fit') return Editor.fit();
      if (c === 'zoom-100') return Editor.zoomAt(96 / 25.4);
      if (c === 'place') {
        const files = await ep.image.pick(true);
        if (files.length) placePhotos(files);
        return;
      }
      if (c === 'save') return save();
      if (c === 'export') return openExport();
      if (c === 'settings') return openSettings();
      if (c === 'check') {
        S.rightTab = 'check';
        return Panels.renderRight();
      }
      if (c === 'menu')
        return contextMenu(b.getBoundingClientRect().left, b.getBoundingClientRect().bottom + 4, [
          { label: 'New design…', key: 'Ctrl+N', run: () => newDialog('print') },
          { label: 'New book…', run: () => newDialog('book') },
          { label: 'Open…', key: 'Ctrl+O', run: () => openFile() },
          '-',
          { label: 'Save', key: 'Ctrl+S', run: () => save() },
          { label: 'Save as…', key: 'Ctrl+Shift+S', run: () => save(true) },
          { label: 'Save as template…', run: () => saveTemplate() },
          { label: 'Export…', key: 'Ctrl+E', run: () => openExport() },
          '-',
          { label: 'Show file in folder', disabled: !S.filePath, run: () => ep.app.reveal(S.filePath) },
          { label: 'Close design', key: 'Ctrl+W', run: () => closeDoc() },
          '-',
          { label: "What's new", run: () => openSettings('app') },
          { label: 'Settings', run: () => openSettings() },
        ]);
    });
    $('#units').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) applySetting({ units: b.dataset.v });
    });
    $('#doc-name').addEventListener('dblclick', async () => {
      const v = await prompt('Document name', S.doc.name);
      if (v) change('Rename', () => (S.doc.name = v.trim()));
      updateTitle();
    });
    document.addEventListener('paste', async (e) => {
      if (!S.doc || isTyping()) return;
      const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
      if (files.length) {
        e.preventDefault();
        placePhotos(await Promise.all(files.map(async (f) => ({ name: f.name || 'Pasted picture.png', mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }))));
      } else if (S.clip) {
        e.preventDefault();
        paste();
      }
    });
    window.addEventListener('keydown', onKey);
    ep.on('app:close-request', async () => {
      ep.app.closeAck();
      let ok;
      try {
        ok = await confirmDiscard();
      } catch (e) {
        // Never trap someone in the app: if asking fails, keep a recovery copy and close.
        console.error(e);
        try {
          if (S.doc && S.dirty) await ep.recovery.write({ id: S.doc.id, text: JSON.stringify({ ...S.doc, filePath: S.filePath }) });
        } catch (_) {}
        ok = true;
      }
      if (ok) ep.app.closeOk();
    });
    ep.on('app:open-file', (p) => openFile(p));
  }
  const isTyping = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);

  function onKey(e) {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k.toLowerCase() === 's') {
      e.preventDefault();
      return save(e.shiftKey);
    }
    if (ctrl && k.toLowerCase() === 'o') return e.preventDefault(), openFile();
    if (ctrl && k.toLowerCase() === 'n') return e.preventDefault(), newDialog('print');
    if ($('.modal-overlay')) return;
    if (!S.doc || isTyping()) return;
    if (ctrl && k.toLowerCase() === 'e') return e.preventDefault(), openExport();
    if (ctrl && k.toLowerCase() === 'w') return e.preventDefault(), closeDoc();
    if (ctrl && k.toLowerCase() === 'z') return e.preventDefault(), e.shiftKey ? history.doRedo() : history.doUndo();
    if (ctrl && k.toLowerCase() === 'y') return e.preventDefault(), history.doRedo();
    if (ctrl && k.toLowerCase() === 'a') return e.preventDefault(), cmd('selectAll');
    if (ctrl && k.toLowerCase() === 'c') return cmd('copy');
    if (ctrl && k.toLowerCase() === 'x') return cmd('cut');
    if (ctrl && k.toLowerCase() === 'd') return e.preventDefault(), cmd('duplicate');
    if (ctrl && k.toLowerCase() === 'l') return e.preventDefault(), cmd('lock');
    if (ctrl && (k === ']' || k === '}')) return e.preventDefault(), cmd(e.shiftKey ? 'front' : 'forward');
    if (ctrl && (k === '[' || k === '{')) return e.preventDefault(), cmd(e.shiftKey ? 'back' : 'backward');
    if (ctrl && (k === '=' || k === '+')) return e.preventDefault(), Editor.zoomAt(S.zoom * 1.25);
    if (ctrl && k === '-') return e.preventDefault(), Editor.zoomAt(S.zoom / 1.25);
    if (ctrl && k === '0') return e.preventDefault(), Editor.fit();
    if (ctrl && k === '1') return e.preventDefault(), Editor.zoomAt(96 / 25.4);
    if (ctrl && k === ';') return e.preventDefault(), applySetting({ showGuides: S.settings.showGuides === false });
    if (k === 'Delete' || k === 'Backspace') return e.preventDefault(), cmd('delete');
    if (k === 'Escape') {
      if (S.linkFrom) return Panels.finishLink(null);
      if (S.crop) return endCrop();
      if (S.tool !== 'select') return setTool('select');
      return select([]);
    }
    if (k === 'Enter' && S.crop) return endCrop();
    if (k === 'Enter' && S.sel.size === 1) {
      const it = selectedList()[0];
      if (it && it.type === 'text') return e.preventDefault(), Text.edit(it);
    }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      const step = unit() === 'px' ? Units.from(e.shiftKey ? 10 : 1, 'px', S.doc.dpi) : e.shiftKey ? 10 : 1;
      return nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0);
    }
    if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault();
      const sp = Model.spreads(S.doc);
      const curIdx = S.surface.kind === 'page' ? sp.findIndex((x) => x.includes(S.surface.idx)) : -1;
      const ni = clamp(curIdx + (k === 'PageDown' ? 1 : -1), 0, sp.length - 1);
      return goTo({ kind: 'page', idx: sp[ni][0] });
    }
    if (ctrl || e.altKey) return;
    const tools = { v: 'select', t: 'text', p: 'image', r: 'rect', e: 'ellipse', l: 'line' };
    if (tools[k.toLowerCase()]) setTool(tools[k.toLowerCase()]);
  }

  /* ================= start ================= */
  async function init() {
    showLoading(true);
    const info = await ep.app.info();
    S.version = info.version;
    S.settings = await ep.settings.get();
    ep.app.boot('settings');
    $('#brand-btn').innerHTML = BRAND.icon;
    bindChrome();
    Editor.init();
    Panels.init();
    // Each finished piece moves the splash screen's bar along.
    const step = (name) => (r) => (ep.app.boot(name), r);
    await Promise.all([Fonts.init().then(step('fonts')), kit.load().then(step('brand kit')), loadProfile().then(step('colour'))]);
    showLoading(false);
    Updates.init();
    // After an update: open the design that was open, on the page it was on.
    const again = (info.reopen || [])[0];
    if (again) {
      await openFile(again.path);
      if (S.doc && again.surface) goTo(again.surface);
      if (S.doc) toast(`Updated to Endpaper ${S.version}. “${S.doc.name}” is open where you left it.`, { ms: 6000 });
    } else if (info.openFile) await openFile(info.openFile);
    else await showHome();
    ep.app.boot('ready');
    if (info.updated) showWhatsNew();
  }

  return {
    S, unit, history, change, render, markDirty, select, selectionChanged, goTo, setTool,
    addItem, pickPhotoFor, setPhoto, placePhotos, startCrop, endCrop, cmd, align, pageOp,
    kit, status, zoomChanged, init, openExport, save, newDocument, loadDoc,
  };
})();

window.addEventListener('DOMContentLoaded', () => App.init().catch((e) => {
  console.error(e);
  ep.app.boot('ready');
  ep.on('app:close-request', () => ep.app.closeOk());
  document.body.innerHTML = `<pre style="padding:20px;color:#fff">Endpaper couldn't start:\n${esc(e.stack || e.message)}</pre>`;
}));
