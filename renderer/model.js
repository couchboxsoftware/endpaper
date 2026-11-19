/* The document model. All lengths are millimetres, type sizes are points, colours are CMYK
   (0-100) or a reference to a swatch. A "surface" is anything you can draw on: a page, one
   side of a master, or the book cover. */
const Model = (() => {
  const PRESETS = [
    { group: 'Paper', items: [['A2', 420, 594], ['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['A6', 105, 148], ['DL', 99, 210], ['US Letter', 215.9, 279.4]] },
    { group: 'Cards and small print', items: [['Business card', 85, 55], ['Postcard', 148, 105], ['Square card', 148, 148], ['Ticket', 210, 74], ['Bookmark', 50, 200]] },
    { group: 'Posters', items: [['A1', 594, 841], ['A0', 841, 1189], ['50 × 70 cm', 500, 700]] },
    {
      group: 'Books',
      items: [
        ['B-format paperback', 129, 198],
        ['A-format paperback', 110, 178],
        ['Royal', 156, 234],
        ['Demy', 138, 216],
        ['5 × 8 in', 127, 203.2],
        ['5.5 × 8.5 in', 139.7, 215.9],
        ['6 × 9 in', 152.4, 228.6],
        ["Picture book 8.5 × 8.5 in", 215.9, 215.9],
        ['Picture book 8 × 10 in', 203.2, 254],
        ['Picture book landscape 10 × 8 in', 254, 203.2],
        ['Square 210 mm', 210, 210],
      ],
    },
  ];

  // Thickness of one page (half a sheet), in mm. Printers and print-on-demand sites publish these.
  const PAPERS = [
    { id: 'kdp-white', name: 'Print on demand, white paper', perPage: 0.0572 },
    { id: 'kdp-cream', name: 'Print on demand, cream paper', perPage: 0.0635 },
    { id: 'kdp-colour', name: 'Print on demand, premium colour', perPage: 0.0596 },
    { id: 'uncoated-80', name: '80 gsm uncoated', perPage: 0.05 },
    { id: 'uncoated-100', name: '100 gsm uncoated', perPage: 0.062 },
    { id: 'silk-130', name: '130 gsm silk', perPage: 0.058 },
    { id: 'silk-170', name: '170 gsm silk', perPage: 0.075 },
    { id: 'custom', name: 'Custom', perPage: null },
  ];

  const SWATCHES = () => [
    { id: 'sw-black', name: 'Black', c: 0, m: 0, y: 0, k: 100 },
    { id: 'sw-paper', name: 'Paper', c: 0, m: 0, y: 0, k: 0 },
    { id: 'sw-rich', name: 'Rich black', c: 60, m: 40, y: 40, k: 100 },
    { id: 'sw-cyan', name: 'Cyan', c: 100, m: 0, y: 0, k: 0 },
    { id: 'sw-magenta', name: 'Magenta', c: 0, m: 100, y: 0, k: 0 },
    { id: 'sw-yellow', name: 'Yellow', c: 0, m: 0, y: 100, k: 0 },
    { id: 'sw-red', name: 'Red', c: 0, m: 100, y: 100, k: 0 },
    { id: 'sw-blue', name: 'Blue', c: 100, m: 70, y: 0, k: 0 },
    { id: 'sw-green', name: 'Green', c: 80, m: 0, y: 100, k: 0 },
  ];

  const DEFAULT_FONT = 'C:\\Windows\\Fonts\\arial.ttf';
  const textStyle = (o = {}) => ({ font: DEFAULT_FONT, size: 12, leading: 15, color: { sw: 'sw-black' }, align: 'left', valign: 'top', spaceAfter: 0, indent: 0, tracking: 0, ...o });

  function newDoc({ name = 'Untitled', w = 210, h = 297, bleed = 3, kind = 'print', facing = false, pages = 1, dpi = 300 } = {}) {
    const book = kind === 'book';
    const m = book ? { top: 15, bottom: 20, inside: 18, outside: 13 } : { top: 5, bottom: 5, inside: 5, outside: 5 };
    const doc = {
      format: 'endpaper',
      version: 1,
      id: uid('d'),
      name,
      kind,
      w,
      h,
      bleed,
      dpi,
      facing: book || facing,
      margins: m,
      pageStart: 1,
      pages: [],
      masters: [{ id: 'm-a', name: 'A-Master', left: [], right: [] }],
      swatches: SWATCHES(),
      styles: [
        { id: 'st-body', name: 'Body', ...textStyle({ font: 'C:\\Windows\\Fonts\\georgia.ttf', size: 11, leading: 15, align: book ? 'justify' : 'left', indent: book ? 5 : 0 }) },
        { id: 'st-head', name: 'Heading', ...textStyle({ font: 'C:\\Windows\\Fonts\\arialbd.ttf', size: 24, leading: 28, spaceAfter: 4 }) },
        { id: 'st-folio', name: 'Page number', ...textStyle({ font: 'C:\\Windows\\Fonts\\georgia.ttf', size: 9, leading: 11, align: 'center' }) },
      ],
      assets: {},
      cover: { enabled: book, paper: 'kdp-white', perPage: 0.0572, spineExtra: 0, bleed: 3, items: [], inside: { enabled: false, items: [] }, layout: 'spread', order: 'outside-first' },
      created: Date.now(),
      ownTextSettings: true,
    };
    for (let i = 0; i < Math.max(1, pages); i++) doc.pages.push(newPage(doc));
    if (book) addPageNumbers(doc);
    return doc;
  }
  const newPage = (doc, master = 'm-a') => ({ id: uid('p'), master: doc.masters.some((x) => x.id === master) ? master : null, items: [] });

  // Page numbers on the A-Master, at the foot of each page, outside corner on spreads.
  function addPageNumbers(doc) {
    const ma = doc.masters[0];
    const y = doc.h - doc.margins.bottom + 6;
    const w = 20;
    const mk = (x, align) => ({ ...base('text', x, y, w, 6), name: 'Page number', text: '{page}', styleId: 'st-folio', style: { ...ownCopy(doc.styles.find((s) => s.id === 'st-folio') || textStyle()), align }, next: null });
    ma.left = [mk(doc.margins.outside, 'left')];
    ma.right = [mk(doc.w - doc.margins.outside - w, 'right')];
  }

  const base = (type, x, y, w, h) => ({ id: uid('i'), type, name: '', x, y, w, h, rot: 0, opacity: 1, locked: false, hidden: false });
  function newItem(type, x, y, w, h, doc) {
    const it = base(type, x, y, w, h);
    if (type === 'text') Object.assign(it, { text: '', styleId: 'st-body', style: { ...(doc.styles.find((s) => s.id === 'st-body') || textStyle()) }, next: null });
    if (type === 'rect') Object.assign(it, { fill: { sw: 'sw-magenta' }, stroke: null, strokeW: 0.5, radius: 0 });
    if (type === 'ellipse') Object.assign(it, { fill: { sw: 'sw-cyan' }, stroke: null, strokeW: 0.5 });
    if (type === 'line') Object.assign(it, { stroke: { sw: 'sw-black' }, strokeW: 0.5 });
    if (type === 'image') Object.assign(it, { asset: null, fit: 'fill', s: 1, ox: 0, oy: 0, stroke: null, strokeW: 0.5 });
    delete it.style?.id;
    delete it.style?.name;
    return it;
  }

  const typeName = { text: 'Text', image: 'Photo', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line' };
  const itemLabel = (it) => it.name || (it.type === 'text' && it.text ? it.text.replace(/\s+/g, ' ').slice(0, 28) : typeName[it.type]);

  /* ---------- pages, spreads and masters ---------- */
  function spreads(doc) {
    const n = doc.pages.length;
    if (!doc.facing) return doc.pages.map((_, i) => [i]);
    const out = [[0]];
    for (let i = 1; i < n; i += 2) out.push(i + 1 < n ? [i, i + 1] : [i]);
    return out;
  }
  const side = (doc, idx) => (!doc.facing ? 'single' : idx % 2 === 0 ? 'right' : 'left');
  const pageNumber = (doc, idx) => doc.pageStart + idx;
  // Left and right margins of a page (inside/outside swap on left-hand pages).
  function margins(doc, s) {
    const m = doc.margins;
    if (s === 'left') return { top: m.top, bottom: m.bottom, left: m.outside, right: m.inside };
    return { top: m.top, bottom: m.bottom, left: m.inside, right: m.outside };
  }
  const master = (doc, id) => doc.masters.find((m) => m.id === id) || null;
  function masterItems(doc, idx) {
    const p = doc.pages[idx];
    const m = p && !p.hideMaster && master(doc, p.master);
    if (!m) return [];
    return side(doc, idx) === 'left' ? m.left : m.right;
  }

  /* ---------- cover ---------- */
  function coverPages(doc) {
    const n = doc.pages.length;
    return n + (n % 2);
  }
  function cover(doc) {
    const c = doc.cover;
    const per = c.perPage || 0.0572;
    const spine = Math.max(0, coverPages(doc) * per + (c.spineExtra || 0));
    const w = doc.w * 2 + spine;
    // The inside of the cover is the same sheet turned over: inside front on the left, inside back
    // on the right. The spine and a strip either side of it are glued to the pages.
    return { w, h: doc.h, spine, back: [0, doc.w], spineX: [doc.w, doc.w + spine], front: [doc.w + spine, w], glue: [Math.max(0, doc.w - GLUE), Math.min(w, doc.w + spine + GLUE)] };
  }
  const GLUE = 6; // mm either side of the spine kept clear on the inside of the cover
  const isInside = (s) => s.kind === 'cover' && s.side === 'inside';

  // A cover can be laid out as one spread (back, spine, front) or as single pages. Single pages
  // are windows onto the same cover sheet: { kind: 'cover', part: 'front' | 'back' }, plus
  // side: 'inside' for the inside cover. Nothing is moved or copied when switching, so the spine
  // (and anything on it) is just out of view until the cover is a spread again.
  const isSingle = (doc) => doc.cover.layout === 'single';
  const isCoverPage = (s) => s.kind === 'cover' && !!s.part;
  const COVER_ORDERS = {
    'outside-first': ['front', 'back', 'inside-front', 'inside-back'],
    reading: ['front', 'inside-front', 'inside-back', 'back'],
  };
  function coverSurfaces(doc) {
    if (!doc.cover.enabled) return [];
    const inside = doc.cover.inside.enabled;
    if (!isSingle(doc)) return [{ kind: 'cover' }, ...(inside ? [{ kind: 'cover', side: 'inside' }] : [])];
    return (COVER_ORDERS[doc.cover.order] || COVER_ORDERS['outside-first'])
      .filter((p) => inside || !p.startsWith('inside'))
      .map((p) => (p.startsWith('inside') ? { kind: 'cover', side: 'inside', part: p.slice(7) } : { kind: 'cover', part: p }));
  }
  // Where a surface's own 0 sits on its item list, in mm. Only cover pages in single-page
  // layout are offset: the front cover starts after the back and the spine.
  function surfaceOrigin(doc, s) {
    if (!isCoverPage(s)) return 0;
    const c = cover(doc);
    // Outside: back on the left, front on the right. Inside: inside front on the left.
    const right = isInside(s) ? s.part === 'back' : s.part === 'front';
    return right ? c.front[0] : 0;
  }
  // The cover surface to show for the current layout: switching layout keeps you on the same
  // side of the cover (and the front, when going to single pages).
  function coverSurfaceFor(doc, s) {
    if (s.kind !== 'cover') return s;
    const inside = isInside(s) && doc.cover.inside.enabled;
    if (isSingle(doc)) return { kind: 'cover', ...(inside ? { side: 'inside' } : {}), part: s.part || 'front' };
    return inside ? { kind: 'cover', side: 'inside' } : { kind: 'cover' };
  }
  // What to call a surface in labels, the status bar and print checks.
  function surfaceName(doc, s) {
    if (s.kind === 'page') return `Page ${pageNumber(doc, s.idx)}`;
    if (s.kind === 'cover') {
      if (isCoverPage(s)) return `${isInside(s) ? 'Inside ' + s.part : s.part === 'front' ? 'Front' : 'Back'} cover`;
      return isInside(s) ? 'Inside cover' : 'Cover';
    }
    return `${master(doc, s.id)?.name || 'Master'}${doc.facing ? (s.side === 'left' ? ', left' : ', right') : ''}`;
  }
  // Is a box on this surface's page (or its bleed)? Cover pages only show part of the sheet.
  // trim: only count the page itself, not its bleed (what survives trimming).
  function onSurface(doc, s, it, { trim = false } = {}) {
    if (!isCoverPage(s)) return true;
    const o = surfaceOrigin(doc, s);
    const b = trim ? 0 : doc.cover.bleed;
    return it.x < o + doc.w + b && it.x + it.w > o - b;
  }

  /* ---------- surfaces ---------- */
  // { kind: 'page', idx } | { kind: 'master', id, side: 'left'|'right' } | { kind: 'cover' } | { kind: 'cover', side: 'inside' }
  function surfaceItems(doc, s) {
    if (s.kind === 'page') return doc.pages[s.idx].items;
    if (s.kind === 'master') return master(doc, s.id)[s.side];
    return isInside(s) ? doc.cover.inside.items : doc.cover.items;
  }
  function surfaceSize(doc, s) {
    if (isCoverPage(s)) return { w: doc.w, h: doc.h, bleed: doc.cover.bleed };
    if (s.kind === 'cover') {
      const c = cover(doc);
      return { w: c.w, h: c.h, bleed: doc.cover.bleed };
    }
    return { w: doc.w, h: doc.h, bleed: doc.bleed };
  }
  const surfaceSide = (doc, s) => (s.kind === 'page' ? side(doc, s.idx) : s.kind === 'master' ? (doc.facing ? s.side : 'single') : 'single');
  const sameSurface = (a, b) => a && b && a.kind === b.kind && a.idx === b.idx && a.id === b.id && a.side === b.side && a.part === b.part;
  // Every surface that holds items, including a cover that's switched off (its items are kept,
  // so their photos, fonts, swatches and threads still count). printedSurfaces() is what prints.
  function allSurfaces(doc) {
    return [...printedSurfaces(doc).filter((s) => s.kind !== 'cover'), { kind: 'cover' }, { kind: 'cover', side: 'inside' }];
  }
  function printedSurfaces(doc) {
    const out = doc.pages.map((_, idx) => ({ kind: 'page', idx }));
    for (const m of doc.masters) {
      if (doc.facing) out.push({ kind: 'master', id: m.id, side: 'left' });
      out.push({ kind: 'master', id: m.id, side: 'right' });
    }
    out.push(...coverSurfaces(doc));
    return out;
  }
  // prefer: the surface being looked at. A cover page shares its items with the rest of the
  // cover, so a box found there is reported as being on that page.
  function findItem(doc, id, prefer) {
    for (const s of [...(prefer ? [prefer] : []), ...allSurfaces(doc)]) {
      const list = surfaceItems(doc, s);
      const i = list.findIndex((it) => it.id === id);
      if (i >= 0) return { item: list[i], list, index: i, surface: s };
    }
    return null;
  }

  /* ---------- colour ---------- */
  function resolveColor(doc, c) {
    if (!c) return null;
    if (c.sw) {
      const s = doc.swatches.find((x) => x.id === c.sw);
      return s ? { c: s.c, m: s.m, y: s.y, k: s.k } : { c: 0, m: 0, y: 0, k: 100 };
    }
    return { c: c.c || 0, m: c.m || 0, y: c.y || 0, k: c.k || 0 };
  }
  const colorName = (doc, c) => (!c ? 'None' : c.sw ? doc.swatches.find((x) => x.id === c.sw)?.name || 'Missing swatch' : `C${c.c} M${c.m} Y${c.y} K${c.k}`);
  const ink = (c) => (c ? c.c + c.m + c.y + c.k : 0);

  /* ---------- text styles ---------- */
  // A text box uses its style (the shared one, when it's linked) with its own alignment.
  function styleOf(doc, it) {
    // Every text box has its own settings (it.style). styleId only says which style they came
    // from; changing the box never changes the style or other boxes.
    if (it.style) return it.style;
    const shared = it.styleId && doc.styles.find((s) => s.id === it.styleId);
    return (it.style = shared ? ownCopy(shared) : textStyle());
  }
  // A style's settings, without its id and name, for a box to keep as its own.
  function ownCopy(st) {
    const { id, name, ...rest } = clone(st);
    return rest;
  }
  // Gives a box a style's settings (or keeps its own with st = null: "No style").
  function applyStyle(doc, it, st) {
    if (st) it.style = ownCopy(st);
    else it.style = styleOf(doc, it);
    it.styleId = st ? st.id : null;
    it.styleOverride = null;
  }

  /* ---------- threads (text that continues in another box) ---------- */
  function threadHeads(doc) {
    const pointedTo = new Set();
    const all = new Map();
    for (const s of allSurfaces(doc))
      for (const it of surfaceItems(doc, s))
        if (it.type === 'text') {
          all.set(it.id, { it, s });
          if (it.next) pointedTo.add(it.next);
        }
    return { all, pointedTo };
  }
  function chainOf(doc, id) {
    const { all, pointedTo } = threadHeads(doc);
    // Walk back to the first box.
    let head = id;
    const seen = new Set([head]);
    for (;;) {
      let prev = null;
      for (const [k, v] of all) if (v.it.next === head) prev = k;
      if (!prev || seen.has(prev)) break;
      seen.add(prev);
      head = prev;
    }
    const chain = [];
    const seen2 = new Set();
    let cur = head;
    while (cur && all.has(cur) && !seen2.has(cur)) {
      seen2.add(cur);
      chain.push(all.get(cur));
      cur = all.get(cur).it.next;
    }
    return chain;
  }

  /* ---------- assets ---------- */
  function usedAssets(doc) {
    const used = new Set();
    for (const s of allSurfaces(doc)) for (const it of surfaceItems(doc, s)) if (it.type === 'image' && it.asset) used.add(it.asset);
    return used;
  }
  function pruneAssets(doc) {
    const used = usedAssets(doc);
    for (const k of Object.keys(doc.assets)) if (!used.has(k)) delete doc.assets[k];
  }

  // Older files and files from templates: fill in anything newer versions added.
  function normalise(doc) {
    doc.cover = { enabled: false, paper: 'kdp-white', perPage: 0.0572, spineExtra: 0, bleed: 3, items: [], ...(doc.cover || {}) };
    doc.cover.inside = { enabled: false, items: [], ...(doc.cover.inside || {}) };
    doc.cover.layout = doc.cover.layout === 'single' ? 'single' : 'spread';
    doc.cover.order = doc.cover.order === 'reading' ? 'reading' : 'outside-first';
    doc.masters = doc.masters || [];
    doc.styles = doc.styles || [];
    doc.swatches = doc.swatches || SWATCHES();
    doc.assets = doc.assets || {};
    doc.dpi = doc.dpi || 300;
    doc.pageStart = doc.pageStart || 1;
    // Files from before 0.1.4 linked boxes to their style. Give each box its own copy of exactly
    // what it showed, once.
    if (!doc.ownTextSettings) {
      for (const s of allSurfaces(doc))
        for (const it of surfaceItems(doc, s)) {
          if (it.type !== 'text') continue;
          const shared = it.styleId && doc.styles.find((x) => x.id === it.styleId);
          if (shared) it.style = { ...ownCopy(shared), ...(it.styleOverride || {}) };
          else if (!it.style) it.style = textStyle();
          it.styleOverride = null;
        }
      doc.ownTextSettings = true;
    }
    return doc;
  }

  return {
    PRESETS, PAPERS, DEFAULT_FONT, textStyle, newDoc, newPage, newItem, itemLabel, typeName, addPageNumbers,
    spreads, side, pageNumber, margins, master, masterItems, cover, coverPages, isInside, coverSurfaces, surfaceName, isSingle, isCoverPage, surfaceOrigin, coverSurfaceFor, onSurface,
    surfaceItems, surfaceSize, surfaceSide, sameSurface, allSurfaces, printedSurfaces, findItem,
    resolveColor, colorName, ink, styleOf, applyStyle, chainOf, usedAssets, pruneAssets, normalise,
  };
})();
