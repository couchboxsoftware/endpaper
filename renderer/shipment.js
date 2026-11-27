/* Shipment preparation (File, Shipment preparation): the paper and binding a book is printed on,
   and what one finished copy comes to: its size, thickness and weight. The same paper sets the
   spine on the cover, so the two always agree. Postage comes later.

   The paper fields are shared with New book's More options (Shipment.paperFields). */
const Shipment = (() => {
  const available = (doc) => !!doc && (doc.facing || doc.cover.enabled);
  const g = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} kg` : `${Math.round(n)} g`);
  const mm = (n, dp = 1) => `${Number(n.toFixed(dp))}`;

  // The paper and binding fields. p: the settings to show; cover: whether the book has a cover.
  function paperFields(p, { cover = true, override = true } = {}) {
    const opts = (list, v) => list.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
    return `${cover ? `<div class="field field-wide"><span>Binding</span><div class="seg" data-pf-seg="binding"><button data-v="paperback" class="${p.binding !== 'hardback' ? 'on' : ''}">Paperback</button><button data-v="hardback" class="${p.binding === 'hardback' ? 'on' : ''}">Hardback</button></div></div>` : ''}
      <div class="pf-row"><span class="pf-label">Pages</span><label class="field"><input class="input" data-pf="pagesGsm" value="${p.pagesGsm}"><em>gsm</em></label>
        <select class="input" data-pf="pagesFinish" aria-label="Page finish">${opts(Model.FINISHES, p.pagesFinish)}</select>
        <select class="input" data-pf="pagesShade" aria-label="Page shade">${opts(Model.SHADES, p.pagesShade)}</select></div>
      ${cover ? `<div class="pf-row"><span class="pf-label">Cover</span><label class="field"><input class="input" data-pf="coverGsm" value="${p.coverGsm}"><em>gsm</em></label>
        <select class="input" data-pf="coverFinish" aria-label="Cover finish">${opts(Model.FINISHES, p.coverFinish)}</select><span></span></div>` : ''}
      ${cover ? `<div class="pf-row" data-pf-board ${p.binding === 'hardback' ? '' : 'hidden'}><span class="pf-label">Boards</span><label class="field"><input class="input" data-pf="boardMm" value="${p.boardMm}"><em>mm</em></label><span class="muted pf-note">thick (2 mm is usual)</span></div>` : ''}
      ${override ? `<div class="pf-row"><span class="pf-label">Printer's thickness</span><label class="field"><input class="input" data-pf="caliper" value="${p.caliper > 0 ? p.caliper : ''}" placeholder="${mm(Model.estimatePerPage(p), 4)}"><em>mm</em></label><span class="muted pf-note">a page. Leave empty to use the estimate.</span></div>` : ''}`;
  }
  // Reads a paper field change into p. Returns true if something changed.
  function readField(p, el) {
    const k = el.dataset.pf;
    if (!k) return false;
    if (k === 'pagesFinish' || k === 'pagesShade' || k === 'coverFinish') p[k] = el.value;
    else if (k === 'caliper') {
      const v = parseFloat(String(el.value).replace(',', '.'));
      p.caliper = v > 0 ? clamp(v, 0.01, 2) : null;
    } else {
      const v = parseFloat(String(el.value).replace(',', '.'));
      if (!(v > 0)) return false;
      p[k] = k === 'boardMm' ? clamp(v, 0.5, 6) : clamp(Math.round(v), 30, 800);
    }
    return true;
  }
  // A Binding button click. Returns true if it changed.
  function readSeg(p, btn, root) {
    const seg = btn.closest('[data-pf-seg]');
    if (!seg) return false;
    p[seg.dataset.pfSeg] = btn.dataset.v;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    const board = root.querySelector('[data-pf-board]');
    if (board) board.hidden = p.binding !== 'hardback';
    return true;
  }

  // What one finished copy comes to.
  function resultsHtml(doc) {
    const s = Model.bookSpecs(doc);
    const c = doc.cover.enabled ? Model.cover(doc) : null;
    const hard = doc.cover.enabled && doc.print.binding === 'hardback';
    return `<div class="sp-figures">
      <div class="sp-fig"><span>Pages</span><b>${s.pages} pages · ${s.sheets} sheets</b>${s.added ? `<em>Includes ${s.added} blank page at the end, to make an even number.</em>` : ''}</div>
      ${c ? `<div class="sp-fig"><span>Spine</span><b>${mm(c.spine, 2)} mm</b><em>On the cover${doc.cover.spineExtra ? `, with ${doc.cover.spineExtra} mm extra` : ''}.</em></div>` : ''}
      <div class="sp-fig"><span>Finished size</span><b>${mm(s.size.w)} × ${mm(s.size.h)} × ${mm(s.size.t)} mm</b><em>${hard ? 'The case stands 3 mm past the pages at the top, bottom and outer edge.' : 'Width × height × thickness.'}</em></div>
      <div class="sp-fig sp-weight"><span>Weight</span><b>about ${g(s.total)}</b><em>per copy</em></div>
      <table class="sp-parts">${s.parts.map(([n, w]) => `<tr><td>${esc(n)}</td><td>${g(w)}</td></tr>`).join('')}</table>
    </div>
    <p class="hint">${s.estimated ? `Worked out from the papers' weight and finish (${mm(s.perPage, 4)} mm a page). Your printer's figures are more exact: type their thickness in on the left.` : `Uses your printer's thickness, ${mm(s.perPage, 4)} mm a page. The weight is still an estimate from the papers' gsm.`}</p>`;
  }

  function open() {
    const doc = App.S.doc;
    if (!available(doc)) return;
    const m = openModal({
      title: 'Shipment preparation',
      wide: true,
      cls: 'shipment',
      body: `<div class="sp">
        <div class="sp-col"><h5>Paper and binding</h5>${paperFields(doc.print, { cover: doc.cover.enabled })}
          <h5 class="sp-isbn-h">ISBN</h5>
          <div class="field field-wide"><span>ISBN</span><input class="input" data-isbn value="${esc(doc.print.isbn || '')}" placeholder="978-…" spellcheck="false"></div>
          <p class="hint sp-isbn-msg"></p></div>
        <div class="sp-col sp-out"><h5>One copy</h5><div class="sp-results">${resultsHtml(doc)}</div></div>
      </div>
      <div class="modal-actions"><button class="btn btn-accent" data-a="done">Done</button></div>`,
    });
    const el = m.el;
    const refresh = () => {
      el.querySelector('.sp-results').innerHTML = resultsHtml(App.S.doc);
      const cal = el.querySelector('[data-pf="caliper"]');
      if (cal) cal.placeholder = mm(Model.estimatePerPage(App.S.doc.print), 4);
    };
    // Each change is one undo step, and the cover's spine follows straight away.
    const apply = (fn) => {
      App.change('Paper and binding', () => fn(App.S.doc.print), { thumbs: 'all' });
      refresh();
    };
    // The book's ISBN, for its barcode (Insert, Barcode). Checked as you type; kept when it's right.
    const isbnMsg = () => {
      const v = el.querySelector('[data-isbn]').value;
      const p = Barcode.parse(v);
      const msg = el.querySelector('.sp-isbn-msg');
      msg.classList.toggle('bad', !!v.trim() && !p.ok);
      msg.textContent = !v.trim() ? 'For the barcode on the back cover (Insert, Barcode).' : p.ok ? `Checked: ${p.isbn ? 'ISBN ' + p.line : 'EAN ' + p.ean}. Barcodes on the cover use it.` : p.error;
      return p;
    };
    isbnMsg();
    el.querySelector('[data-isbn]').addEventListener('input', isbnMsg);
    el.addEventListener('change', (e) => {
      if (e.target.dataset.isbn !== undefined) {
        const v = e.target.value.trim();
        const p = isbnMsg();
        if (!v || p.ok) App.change('ISBN', () => (App.S.doc.print.isbn = v), { thumbs: 'all' });
        return;
      }
      if (!e.target.dataset.pf) return;
      const next = { ...App.S.doc.print };
      if (readField(next, e.target)) apply((p) => Object.assign(p, next));
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pf-seg] button');
      if (b) {
        const next = { ...App.S.doc.print };
        if (readSeg(next, b, el)) apply((p) => Object.assign(p, next));
        return;
      }
      if (e.target.closest('[data-a="done"]')) m.close();
    });
  }

  // The one line the cover's Properties shows about the paper.
  function summary(doc) {
    const p = doc.print;
    const fin = (k) => (Model.FINISHES.find(([v]) => v === k) || [, k])[1].toLowerCase();
    return `${p.binding === 'hardback' ? 'Hardback' : 'Paperback'} · ${p.pagesGsm} gsm ${fin(p.pagesFinish)}, ${p.pagesShade}${p.caliper > 0 ? ` (printer's ${p.caliper} mm a page)` : ''}`;
  }

  return { open, available, paperFields, readField, readSeg, summary, resultsHtml };
})();
