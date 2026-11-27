/* ISBN barcodes: the EAN-13 a book's back cover carries, with "ISBN 978-…" above, the digits
   under it in OCR-B, and an optional 5-digit price code (EAN-5) beside it.

   Everything is worked out as shapes in mm (bars as rectangles, letters as outlines from the
   OCR-B font, renderer/fonts/OCRB.ttf), so the page, thumbnails, PNG and the print PDF all draw
   the same thing, and the PDF gets real vector bars in 100% black.

   A barcode box is { type: 'barcode', w, h, …, own: false, isbn: '', price: false,
   priceCode: '90000' }. own false: it shows the book's ISBN (doc.print.isbn, set in File,
   Shipment preparation). Its size is its scale: 100% is the standard 0.33 mm bar module. */
const Barcode = (() => {
  const X = 0.33; // one module (the thinnest bar) at 100%, in mm
  const BAR_H = 22.85; // bar height at 100%
  const MIN = 0.8, MAX = 2; // the scales scanners are made for

  /* ---------- numbers ---------- */
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const Rc = L.map((c) => [...c].map((b) => (b === '1' ? '0' : '1')).join(''));
  const G = Rc.map((c) => [...c].reverse().join(''));
  const FIRST = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const FIVE = ['GGLLL', 'GLGLL', 'GLLGL', 'GLLLG', 'LGGLL', 'LLGGL', 'LLLGG', 'LGLGL', 'LGLLG', 'LLGLG'];
  const eanCheck = (d12) => (10 - ([...d12].reduce((a, ch, i) => a + Number(ch) * (i % 2 ? 3 : 1), 0) % 10)) % 10;

  /* An ISBN (10 or 13 digits, dashes and spaces allowed) or any EAN-13. Returns { ok, ean
     (13 digits), isbn (it starts 978 or 979), line (how to write it above the bars), error }. */
  function parse(raw) {
    const typed = String(raw || '').trim().replace(/^isbn(-1[03])?:?\s*/i, '');
    const d = typed.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (!d) return { ok: false, error: 'Type the ISBN: 13 digits (or 10 for an older one).' };
    if (d.length === 10) {
      if (!/^\d{9}[\dX]$/.test(d)) return { ok: false, error: "That isn't an ISBN: only the last character can be X." };
      const sum = [...d].reduce((a, ch, i) => a + (ch === 'X' ? 10 : Number(ch)) * (10 - i), 0);
      if (sum % 11) return { ok: false, error: `The last digit doesn't match, so it's mistyped somewhere. Check it against the ISBN you were given.` };
      const ean = '978' + d.slice(0, 9) + eanCheck('978' + d.slice(0, 9));
      // Keep the way it was split up, as a 13-digit ISBN.
      const line = /-/.test(typed) ? '978-' + typed.replace(/\s+/g, '').slice(0, -1) + ean[12] : null;
      return { ok: true, ean, isbn: true, line: line || ean };
    }
    if (d.length !== 13 || /X/.test(d)) return { ok: false, error: `An ISBN has 13 digits (or 10 for an older one); this has ${d.replace(/X/g, '').length}.` };
    if (eanCheck(d.slice(0, 12)) !== Number(d[12])) return { ok: false, error: `The last digit should be ${eanCheck(d.slice(0, 12))}, so it's mistyped somewhere. Check it against the ISBN you were given.` };
    const isbn = /^97[89]/.test(d);
    const line = /-/.test(typed) && typed.replace(/[^0-9]/g, '') === d ? typed.replace(/\s+/g, '') : d;
    return { ok: true, ean: d, isbn, line };
  }
  // The 5-digit price code: 5 digits, like 51299 ($12.99) or 90000 (no price).
  const priceOk = (p) => /^\d{5}$/.test(String(p || ''));

  // Which modules are dark, left to right (1 dark, 0 light).
  function ean13Bits(ean) {
    const par = FIRST[Number(ean[0])];
    let s = '101';
    for (let i = 1; i <= 6; i++) s += (par[i - 1] === 'L' ? L : G)[Number(ean[i])];
    s += '01010';
    for (let i = 7; i <= 12; i++) s += Rc[Number(ean[i])];
    return s + '101';
  }
  function ean5Bits(p) {
    const d = [...p].map(Number);
    const chk = (3 * (d[0] + d[2] + d[4]) + 9 * (d[1] + d[3])) % 10;
    let s = '1011';
    d.forEach((n, i) => (s += (i ? '01' : '') + (FIVE[chk][i] === 'L' ? L : G)[n]));
    return s;
  }

  /* ---------- the OCR-B font ---------- */
  let font = null;
  let loading = null;
  function load() {
    if (font) return Promise.resolve(font);
    if (!loading)
      loading = fetch('fonts/OCRB.ttf')
        .then((r) => r.arrayBuffer())
        .then((b) => (font = fontkit.create(new Uint8Array(b))))
        .catch((e) => {
          console.warn('OCR-B failed to load', e);
          return null;
        });
    return loading;
  }
  const ready = () => !!font;
  // Letters as outlines in mm: text from x, sitting on baseline y, size mm tall per em.
  // centre: x is the middle of the text instead of its start.
  function textPaths(text, x, y, size, { centre = false } = {}) {
    if (!font) return [];
    const run = font.layout(text);
    const f = size / font.unitsPerEm;
    let pen = 0;
    const width = run.positions.reduce((a, p) => a + p.xAdvance, 0) * f;
    const x0 = centre ? x - width / 2 : x;
    const out = [];
    run.glyphs.forEach((g, i) => {
      const cmds = [];
      for (const c of g.path.commands) {
        const a = c.args;
        const P = (j) => [x0 + pen + a[j] * f, y - a[j + 1] * f];
        if (c.command === 'moveTo') cmds.push(['M', ...P(0)]);
        else if (c.command === 'lineTo') cmds.push(['L', ...P(0)]);
        else if (c.command === 'quadraticCurveTo') cmds.push(['Q', ...P(0), ...P(2)]);
        else if (c.command === 'bezierCurveTo') cmds.push(['C', ...P(0), ...P(2), ...P(4)]);
        else if (c.command === 'closePath') cmds.push(['Z']);
      }
      out.push(cmds);
      pen += run.positions[i].xAdvance * f;
    });
    return out;
  }
  // The font's digit height per mm of size, so the numbers come out the standard height.
  const digitHeight = () => (font ? font.glyphsForString('8')[0].bbox.maxY / font.unitsPerEm : 0.7);

  /* ---------- layout ---------- */
  // The ISBN a barcode shows (the book's, or its own).
  const isbnOf = (doc, it) => (it.own ? it.isbn : doc.print && doc.print.isbn) || '';
  // Size at 100%: with the price code it's wider.
  function base(it) {
    const w = (11 + 95 + (it.price ? 9 + 47 + 5 : 7)) * X;
    const h = 3.6 + BAR_H + 0.5 + 2.75 + 0.8;
    return { w, h };
  }
  const scaleOf = (it) => it.w / base(it).w;
  /* The shapes, in mm from the box's top-left: { bars: [{ x, y, w, h }], text: [outline
     commands], ok, error }. With a mistyped ISBN there are no bars, just the reason. */
  function shapes(doc, it) {
    const p = parse(isbnOf(doc, it));
    const S = scaleOf(it);
    const out = { bars: [], text: [], ok: p.ok, error: p.error || null, S };
    if (!p.ok) return out;
    const top = 3.6; // room for the ISBN line
    const dh = 2.75; // digit height
    const size = dh / digitHeight();
    const x0 = 11 * X;
    const addBars = (bits, x, y, hgt, longAt) => {
      for (let i = 0; i < bits.length; ) {
        if (bits[i] !== '1') {
          i++;
          continue;
        }
        let j = i;
        while (j < bits.length && bits[j] === '1') j++;
        const long = longAt && longAt(i);
        out.bars.push({ x: x + i * X, y, w: (j - i) * X, h: hgt + (long ? 5 * X : 0) });
        i = j;
      }
    };
    // Guard bars (start, centre, end) run a little longer than the rest.
    const guard = (i) => i < 3 || (i >= 45 && i < 50) || i >= 92;
    addBars(ean13Bits(p.ean), x0, top, BAR_H, guard);
    // The digits: the first in the margin, then six under each half.
    const base_ = top + BAR_H + 0.5 + dh;
    out.text.push(...textPaths(p.ean[0], x0 - 5 * X, base_, size, { centre: true })); // clear of the long start bars
    for (let i = 0; i < 6; i++) out.text.push(...textPaths(p.ean[1 + i], x0 + (3 + 7 * i + 3.5) * X, base_, size, { centre: true }));
    for (let i = 0; i < 6; i++) out.text.push(...textPaths(p.ean[7 + i], x0 + (50 + 7 * i + 3.5) * X, base_, size, { centre: true }));
    // "ISBN 978-…" above, across the bars.
    if (p.isbn) out.text.push(...textPaths('ISBN ' + p.line, x0 + 47.5 * X, top - 0.7, size * 0.82, { centre: true }));
    // The price code: its own short bars, digits above them.
    if (it.price && priceOk(it.priceCode)) {
      const ax = x0 + (95 + 9) * X;
      const ay = top + dh + 0.6;
      addBars(ean5Bits(String(it.priceCode)), ax, ay, top + BAR_H + 5 * X - ay, null);
      out.text.push(...textPaths(String(it.priceCode), ax + 23.5 * X, ay - 0.5, size, { centre: true }));
    }
    // Everything in the box's own size.
    if (S !== 1) {
      for (const b of out.bars) (b.x *= S), (b.y *= S), (b.w *= S), (b.h *= S);
      out.text = out.text.map((cmds) => cmds.map(([k, ...n]) => [k, ...n.map((v) => v * S)]));
    }
    return out;
  }

  /* ---------- drawing ---------- */
  // An SVG for the page: k pixels per mm.
  function svg(doc, it, k) {
    const s = shapes(doc, it);
    const W = it.w * k, H = it.h * k;
    if (!s.ok) return `<div class="barcode-bad"><span>${esc(s.error)}</span></div>`;
    const r = (v) => Math.round(v * k * 100) / 100;
    const bars = s.bars.map((b) => `M${r(b.x)} ${r(b.y)}h${r(b.w)}v${r(b.h)}h${-r(b.w)}z`).join('');
    const text = s.text.map((cmds) => cmds.map(([c, ...n]) => c + n.map(r).join(' ')).join('')).join('');
    return `<svg class="shape" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><path d="${bars}${text}" fill="#000"/></svg>`;
  }
  // Onto a canvas, k pixels per mm, from the box's top-left.
  function draw(ctx, doc, it, k) {
    const s = shapes(doc, it);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, it.w * k, it.h * k);
    if (!s.ok) return;
    ctx.fillStyle = '#000';
    for (const b of s.bars) ctx.fillRect(b.x * k, b.y * k, b.w * k, b.h * k);
    const p = new Path2D();
    for (const cmds of s.text)
      for (const [c, ...n] of cmds) {
        const v = n.map((x) => x * k);
        if (c === 'M') p.moveTo(...v);
        else if (c === 'L') p.lineTo(...v);
        else if (c === 'Q') p.quadraticCurveTo(...v);
        else if (c === 'C') p.bezierCurveTo(...v);
        else p.closePath();
      }
    ctx.fill(p);
  }

  return { parse, priceOk, shapes, svg, draw, load, ready, base, scaleOf, isbnOf, MIN, MAX };
})();
