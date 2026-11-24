/* Place text (Insert, Place text…): paste a long text and Endpaper puts a text box filling the
   margins on each page in a range, linked so the text flows from one page to the next. A line
   with just --- moves the rest on to the next page. If the text needs more pages than the range,
   it asks whether to add pages or stop at the last one. */
const PlaceText = (() => {
  const MAX_PAGES = 2000;

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

  // How many pages the text needs from a page, in a style. more: it needs more than MAX_PAGES.
  function pagesNeeded(doc, text, style, fromIdx) {
    if (!text.trim()) return { pages: 0, more: false };
    const f = frame(doc, fromIdx);
    let n = 8;
    for (;;) {
      const r = Layout.measure(doc, text, style, f.w, f.h, n);
      if (!r.overflow) return { pages: r.used, more: false };
      if (n >= MAX_PAGES) return { pages: MAX_PAGES, more: true };
      n = Math.min(MAX_PAGES, n * 4);
    }
  }

  // Puts the text on pages fromIdx onwards: count boxes, adding `add` pages after toIdx first.
  function place(doc, { text, style, fromIdx, toIdx, count, add }) {
    let ids = [];
    App.change('Place text', () => {
      const master = doc.pages[toIdx].master;
      for (let k = 0; k < add; k++) doc.pages.splice(toIdx + 1 + k, 0, Model.newPage(doc, master));
      const boxes = [];
      for (let i = 0; i < count; i++) {
        const idx = fromIdx + i;
        const f = frame(doc, idx);
        const it = Model.newItem('text', f.x, f.y, f.w, f.h, doc);
        Model.applyStyle(doc, it, style);
        if (i === 0) it.text = text;
        doc.pages[idx].items.push(it);
        boxes.push(it);
      }
      boxes.forEach((b, i) => (b.next = boxes[i + 1] ? boxes[i + 1].id : null));
      ids = boxes.map((b) => b.id);
    }, { thumbs: 'all' });
    App.goTo({ kind: 'page', idx: fromIdx });
    App.select([ids[0]]);
    Editor.fit();
    return ids;
  }

  // Too long for the range: add pages, stop at the last page, or go back. 'add' | 'stop' | null.
  function tooLong(doc, need, fromIdx, toIdx) {
    const range = toIdx - fromIdx + 1;
    const extra = need.pages - range;
    const last = Model.pageNumber(doc, toIdx);
    return new Promise((resolve) => {
      const m = openModal({
        title: `The text needs ${need.more ? 'more than ' : ''}${need.pages} pages`,
        body: `<p class="muted">You chose ${range} page${range === 1 ? '' : 's'}. Add ${extra} more after page ${last}, or stop at page ${last} and leave the rest waiting in its last box. Check will list it, and Edit story shows all of it.</p>
          <div class="modal-actions"><button class="btn btn-ghost" data-a="back">Back</button><button class="btn btn-ghost" data-a="stop">Stop at page ${last}</button><button class="btn btn-accent" data-a="add">Add ${extra} page${extra === 1 ? '' : 's'}</button></div>`,
        onClose: (v) => resolve(v || null),
      });
      m.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (b) m.close(b.dataset.a === 'back' ? null : b.dataset.a);
      });
    });
  }

  function open() {
    const doc = App.S.doc;
    if (!doc) return;
    const first = Model.pageNumber(doc, 0);
    const lastNo = Model.pageNumber(doc, doc.pages.length - 1);
    const start = App.S.surface.kind === 'page' ? Model.pageNumber(doc, App.S.surface.idx) : first;
    const styles = doc.styles;
    const defStyle = styles.find((s) => s.id === 'st-body') || styles[0];
    // What an empty line means: a gap on the same page, or a new page. Remembered.
    let emptyLines = App.S.settings.placeEmptyLines === 'break' ? 'break' : 'gap';
    const m = openModal({
      title: 'Place text',
      cls: 'place-text',
      body: `<p class="muted">Paste your text. Endpaper puts a text box inside the margins of each page and the text flows from one page to the next. A line with just --- starts a new page, and empty lines can too.</p>
        <textarea class="story-text pt-text" spellcheck="true" placeholder="Paste or type your text here" autofocus></textarea>
        <div class="pt-row">
          <label class="field"><span>From page</span><input class="input" type="number" data-pt="from" min="${first}" max="${lastNo}" value="${start}"></label>
          <label class="field"><span>to page</span><input class="input" type="number" data-pt="to" min="${first}" max="${lastNo}" value="${lastNo}"></label>
          <label class="field"><span>Text style</span><select class="input" data-pt="style">${styles.map((s) => `<option value="${esc(s.id)}" ${s === defStyle ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        </div>
        <div class="field pt-empty"><span>Empty lines</span><div class="seg" data-pt-seg="empty">${[['gap', 'Leave a gap'], ['break', 'Start a new page']].map(([v, l]) => `<button data-v="${v}" class="${v === emptyLines ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="modal-actions"><span class="muted pt-info"></span><button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-accent" data-a="place" disabled>Place text</button></div>`,
    });
    const el = m.el;
    const ta = $('.pt-text', el);
    const get = (k) => $(`[data-pt="${k}"]`, el);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
    // The range as page indexes, from no later than to.
    const range = () => {
      const from = clamp(get('from').value, first, lastNo) - first;
      const to = Math.max(from, clamp(get('to').value, first, lastNo) - first);
      return { fromIdx: from, toIdx: to };
    };
    const style = () => styles.find((s) => s.id === get('style').value) || defStyle;
    let need = { pages: 0, more: false };

    const info = $('.pt-info', el);
    const placeBtn = $('[data-a="place"]', el);
    const update = async () => {
      const st = style();
      if (Fonts.exists(st.font) && !Fonts.isReady(st.font)) await Fonts.load(st.font);
      const text = clean(ta.value, { emptyLines });
      const { fromIdx, toIdx } = range();
      need =pagesNeeded(doc, text, st, fromIdx);
      placeBtn.disabled = !need.pages;
      info.classList.remove('warn');
      if (!need.pages) return (info.textContent = '');
      const room = toIdx - fromIdx + 1;
      const p0 = Model.pageNumber(doc, fromIdx);
      if (need.pages <= room) {
        info.textContent = need.pages === 1 ? `Fits on page ${p0}.` : `Fills pages ${p0} to ${p0 + need.pages - 1} (${need.pages} pages).`;
      } else {
        info.textContent = `Needs ${need.more ? 'more than ' : 'about '}${need.pages} pages. You chose ${room}.`;
        info.classList.add('warn');
      }
    };
    const updateSoon = debounce(update, 200);
    ta.addEventListener('input', updateSoon);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.ctrlKey) (e.preventDefault(), go());
    });
    for (const k of ['from', 'to', 'style']) get(k).addEventListener('change', update);
    for (const k of ['from', 'to']) get(k).addEventListener('input', updateSoon);

    async function go() {
      await update();
      if (!need.pages) return;
      const text = clean(ta.value, { emptyLines });
      const { fromIdx, toIdx } = range();
      const room = toIdx - fromIdx + 1;
      let count = Math.min(need.pages, room);
      let add = 0;
      if (need.pages > room) {
        const choice = await tooLong(doc, need, fromIdx, toIdx);
        if (!choice) return ta.focus();
        if (choice === 'add') {
          add = need.pages - room;
          count = need.pages;
        }
      }
      m.close();
      place(doc, { text, style: style(), fromIdx, toIdx, count, add });
      const p0 = Model.pageNumber(doc, fromIdx);
      toast(count === 1 ? `Placed on page ${p0}.` : `Placed on pages ${p0} to ${p0 + count - 1}${add ? `, with ${add} new page${add === 1 ? '' : 's'}` : ''}.`, { action: 'Undo', onAction: () => App.history.doUndo() });
    }
    el.addEventListener('click', (e) => {
      const seg = e.target.closest('[data-pt-seg="empty"] [data-v]');
      if (seg && seg.dataset.v !== emptyLines) {
        emptyLines = seg.dataset.v;
        $$('[data-pt-seg="empty"] [data-v]', el).forEach((x) => x.classList.toggle('on', x === seg));
        ep.settings.set({ placeEmptyLines: emptyLines }).then((s) => (App.S.settings = s));
        update();
        return;
      }
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'cancel') m.close();
      if (b.dataset.a === 'place') go();
    });
  }

  return { open, clean, pagesNeeded, place, frame };
})();
