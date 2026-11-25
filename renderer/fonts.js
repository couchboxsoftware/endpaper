/* Fonts: the fonts installed in Windows plus any you add. Each font file is read once, given to
   the browser (for the screen) and to fontkit (for measuring and for the PDF), so the lines
   break in exactly the same places on screen and in print. */
const Fonts = (() => {
  let list = [];
  const byPath = new Map();
  const loaded = new Map(); // path -> font object
  const loading = new Map(); // path -> promise
  const widths = new Map();
  let fallback = null;

  async function refresh() {
    list = await ep.fonts.list();
    byPath.clear();
    for (const f of list) byPath.set(f.path.toLowerCase(), f);
  }
  function families() {
    const fam = new Map();
    for (const f of list) {
      if (!fam.has(f.family)) fam.set(f.family, []);
      fam.get(f.family).push(f);
    }
    for (const v of fam.values()) v.sort((a, b) => a.italic - b.italic || a.weight - b.weight);
    return [...fam.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }
  const info = (p) => (p && byPath.get(p.toLowerCase())) || null;
  const exists = (p) => !!info(p);

  function load(p) {
    const key = (p || '').toLowerCase();
    if (loaded.has(key)) return Promise.resolve(loaded.get(key));
    if (loading.has(key)) return loading.get(key);
    const pr = (async () => {
      const bytes = await ep.fonts.read(p);
      const fk = fontkit.create(bytes);
      const cssName = 'epf-' + Math.abs(hash(key)).toString(36);
      const face = new FontFace(cssName, bytes);
      await face.load();
      document.fonts.add(face);
      const f = { path: p, bytes, fk, cssName, upm: fk.unitsPerEm, ascent: fk.ascent, descent: fk.descent, name: fk.fullName || info(p)?.full || p.split(/[\\/]/).pop() };
      loaded.set(key, f);
      return f;
    })().catch((e) => {
      console.warn('Font failed', p, e);
      loaded.set(key, null);
      return null;
    }).finally(() => loading.delete(key));
    loading.set(key, pr);
    return pr;
  }
  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  // The loaded font for a path, or the fallback while it loads (or if it's missing).
  function get(p) {
    const f = loaded.get((p || '').toLowerCase());
    return f || fallback;
  }
  const isReady = (p) => !!loaded.get((p || '').toLowerCase());

  async function init() {
    await refresh();
    const candidates = [Model.DEFAULT_FONT, ...list.filter((f) => /^(arial|segoe ui|calibri)$/i.test(f.family)).map((f) => f.path), list[0]?.path].filter(Boolean);
    for (const c of candidates) {
      fallback = await load(c);
      if (fallback) break;
    }
  }

  // Every font a document uses, loaded before drawing.
  async function ensureDoc(doc) {
    const paths = new Set();
    for (const s of doc.styles) paths.add(s.font);
    for (const sf of Model.allSurfaces(doc))
      for (const it of Model.surfaceItems(doc, sf)) if (it.type === 'text') paths.add(Model.styleOf(doc, it).font);
    await Promise.all([...paths].filter(Boolean).map((p) => (exists(p) ? load(p) : null)));
  }

  // Width of a run of text in mm at a size in mm (kerning included).
  function width(f, text, sizeMm, tracking = 0) {
    if (!text) return 0;
    const key = f.cssName + '\u0001' + text;
    let w = widths.get(key);
    if (w === undefined) {
      try {
        w = f.fk.layout(text).advanceWidth / f.upm;
      } catch {
        w = text.length * 0.5;
      }
      if (widths.size > 50000) widths.clear();
      widths.set(key, w);
    }
    return w * sizeMm + (tracking / 1000) * sizeMm * [...text].length;
  }

  return { init, refresh, families, info, exists, load, get, isReady, ensureDoc, width, get list() { return list; }, get fallback() { return fallback; } };
})();

/* Text layout: paragraphs, wrapping, alignment (justified included), first-line indents, space
   after paragraphs, and text that continues from one box into the next. In text that continues,
   a line with just --- (a break) moves the rest on to the next box, and so do empty lines when
   the text's first box says so (emptyLines: 'break', set by Place text and Format story). */
const Layout = (() => {
  let cache = new Map();
  const invalidate = () => (cache = new Map());

  function tokens(doc, text, ctx) {
    return text
      .replace(/\{page\}/g, ctx && ctx.page != null ? String(ctx.page) : '#')
      .replace(/\{pages\}/g, String(doc.pageStart + doc.pages.length - 1))
      .replace(/\{title\}/g, doc.name || '');
  }

  const BREAK = /^\s*-{3,}\s*$/;
  const isBreak = (line) => BREAK.test(line);
  // For text whose empty lines start a new page (its first box has emptyLines: 'break'): each run
  // of empty lines becomes a break. Empty lines next to a --- add nothing to it (two --- in a row
  // still leave a page empty), and empty lines before the text are never a break.
  function emptyLinesBreak(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    while (i < lines.length) {
      if (lines[i].trim() && !isBreak(lines[i])) {
        out.push(lines[i++]);
        continue;
      }
      let breaks = 0;
      for (; i < lines.length && (!lines[i].trim() || isBreak(lines[i])); i++) if (isBreak(lines[i])) breaks++;
      for (let k = 0; k < Math.max(1, breaks); k++) out.push('---');
    }
    return out;
  }

  // Lays out a whole chain and returns the result for one box: { lines, overflow, font, size, ... }.
  function box(doc, it, ctx) {
    const chain = it.next || isPointedTo(doc, it.id) ? Model.chainOf(doc, it.id) : [{ it }];
    const key = chain.map((c) => c.it.id).join('>') + '@' + (ctx && ctx.page);
    let res = cache.get(key);
    if (!res) {
      res = layoutChain(doc, chain.map((c) => c.it), ctx);
      cache.set(key, res);
    }
    return res.get(it.id) || { lines: [], overflow: false };
  }
  function isPointedTo(doc, id) {
    for (const s of Model.allSurfaces(doc)) for (const x of Model.surfaceItems(doc, s)) if (x.next === id) return true;
    return false;
  }

  function layoutChain(doc, boxes, ctx) {
    const head = boxes[0];
    const st = Model.styleOf(doc, head);
    const f = Fonts.get(st.font);
    const out = new Map();
    for (const b of boxes) out.set(b.id, { lines: [], overflow: false, font: f, style: st, size: st.size * MM_PER_PT });
    if (!f) return out;
    const size = st.size * MM_PER_PT;
    const lead = (st.leading || st.size * 1.2) * MM_PER_PT;
    const asc = (f.ascent / f.upm) * size;
    const desc = (-f.descent / f.upm) * size;
    const tr = st.tracking || 0;
    const W = (t) => Fonts.width(f, t, size, tr);
    const spaceW = W(' ');
    const text = tokens(doc, head.text || '', ctx);
    let paras = text.split(/\r?\n/);
    // Breaks only count when the text continues into another box. Blank lines either side of a
    // break are dropped, so a new box never starts (or a full one spills) with empty lines.
    const chained = boxes.length > 1;
    if (chained && head.emptyLines === 'break') paras = emptyLinesBreak(paras);
    if (chained && paras.some(isBreak)) {
      const drop = new Set();
      paras.forEach((p, i) => {
        if (!isBreak(p)) return;
        for (let j = i - 1; j >= 0 && !paras[j].trim(); j--) drop.add(j);
        for (let j = i + 1; j < paras.length && !paras[j].trim(); j++) drop.add(j);
      });
      paras = paras.filter((_, i) => !drop.has(i));
    }

    let bi = 0;
    let cur = boxes[0];
    let baseline = asc;
    let done = false;
    let fresh = false; // just after a break: no first-line indent
    // Moves to the next box when this line doesn't fit; false when there's nowhere left.
    const room = () => {
      while (!(baseline + desc <= cur.h + 0.05)) {
        if (bi + 1 >= boxes.length) {
          out.get(cur.id).overflow = true;
          done = true;
          return false;
        }
        bi++;
        cur = boxes[bi];
        baseline = asc;
      }
      return true;
    };

    for (let pi = 0; pi < paras.length && !done; pi++) {
      if (chained && isBreak(paras[pi])) {
        // Nothing after it: nothing to move on.
        if (!paras.slice(pi + 1).some((p) => p.trim())) break;
        if (bi + 1 >= boxes.length) {
          out.get(cur.id).overflow = true;
          done = true;
          break;
        }
        bi++;
        cur = boxes[bi];
        baseline = asc;
        fresh = true;
        continue;
      }
      const words = paras[pi].split(/ +/).filter((w, i, a) => w !== '' || a.length === 1);
      const indent = pi > 0 && !fresh && st.indent ? st.indent : 0;
      fresh = false;
      let line = [];
      let lineW = 0;
      let first = true;
      const flush = (last) => {
        if (!room()) return false;
        const ind = first ? indent : 0;
        const avail = cur.w - ind;
        const ws = line.map((t) => ({ t, w: W(t) }));
        const L = { y: baseline, x: ind, w: lineW, text: line.join(' '), words: null, justified: false };
        if (st.align === 'justify' && !last && ws.length > 1) {
          const gap = (avail - ws.reduce((a, b) => a + b.w, 0)) / (ws.length - 1);
          let x = ind;
          L.words = ws.map((w) => {
            const o = { t: w.t, x };
            x += w.w + gap;
            return o;
          });
          L.justified = true;
          L.w = avail;
        } else {
          const shift = st.align === 'center' ? (avail - lineW) / 2 : st.align === 'right' ? avail - lineW : 0;
          L.x = ind + shift;
        }
        out.get(cur.id).lines.push(L);
        baseline += lead;
        line = [];
        lineW = 0;
        first = false;
        return true;
      };
      for (let wi = 0; wi < words.length && !done; wi++) {
        let w = words[wi];
        const ww = W(w);
        const avail = () => cur.w - (first ? indent : 0);
        if (line.length && lineW + spaceW + ww <= avail() + 0.001) {
          line.push(w);
          lineW += spaceW + ww;
          continue;
        }
        if (line.length && !flush(false)) break;
        if (ww <= avail() + 0.001 || !w) {
          line = [w];
          lineW = ww;
          continue;
        }
        // A word longer than the line: break it letter by letter.
        let part = '';
        for (const ch of [...w]) {
          if (part && W(part + ch) > avail()) {
            line = [part];
            lineW = W(part);
            if (!flush(false)) break;
            part = '';
          }
          part += ch;
        }
        line = [part];
        lineW = W(part);
      }
      if (!done && (line.length || words.length === 0)) flush(true);
      if (!done) baseline += (st.spaceAfter || 0) * MM_PER_PT;
    }

    // Vertical alignment, for a box on its own.
    if (boxes.length === 1 && st.valign && st.valign !== 'top') {
      const r = out.get(head.id);
      if (!r.overflow && r.lines.length) {
        const bottom = r.lines[r.lines.length - 1].y + desc;
        const dy = st.valign === 'middle' ? (head.h - bottom) / 2 : head.h - bottom;
        for (const l of r.lines) l.y += dy;
      }
    }
    for (const r of out.values()) Object.assign(r, { asc, desc, lead });
    out.end = bi; // the box the text ends in
    return out;
  }

  // How many boxes of w × h mm a text needs in a style, trying up to n boxes:
  // { used, overflow } (overflow: it needs more than n).
  function measure(doc, text, style, w, h, n) {
    const boxes = Array.from({ length: Math.max(2, n) }, (_, i) => ({ id: 'measure' + i, w, h, text: i ? '' : text, style }));
    const out = layoutChain(doc, boxes, null);
    return { used: Math.min(n, out.end + 1), overflow: [...out.values()].some((r) => r.overflow) };
  }

  return { box, invalidate, tokens, measure, isBreak, emptyLinesBreak };
})();
