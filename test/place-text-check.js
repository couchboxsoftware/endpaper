// Place text: paste a long text, and a box inside the margins of each page in the range takes it,
// linked so it flows on. A line with just --- starts a new page. Too long for the range: add pages
// or stop at the last one. All of it undoes in one go.
// Run: node test/place-text-check.js
const path = require('path');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const run = await H.launch(__filename, { userData: H.tempUserData('place-text'), env: { ENDPAPER_TEST_SHOTS: process.env.ENDPAPER_TEST_SHOTS || null } });
    H.finish('place-text-check', [run]);
  })();
} else {
  module.exports = async ({ exec, shot }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    await appReady();
    const shots = process.env.ENDPAPER_TEST_SHOTS;

    await exec(`(async () => {
      await App.newDocument({ name: 'Story book', w: 148, h: 210, pages: 8, kind: 'book', bleed: 3 });
      App.goTo({ kind: 'page', idx: 1 });
    })()`);
    await wait(300);

    // Lines of the text box on a page (the placed one: the last box on it).
    const LINES = `(idx) => { const d = App.S.doc; const it = d.pages[idx].items[d.pages[idx].items.length - 1]; return it ? Layout.box(d, it, Render.ctxFor(d, { kind: 'page', idx })).lines.map((l) => l.text) : null; }`;
    const open = async (text) => {
      await exec(`PlaceText.open()`);
      await waitFor(() => exec(`!!document.querySelector('.place-text')`), 2000);
      await exec(`(() => { const t = document.querySelector('.place-text .pt-text'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); })()`);
      await wait(400);
    };
    const setRange = (from, to) => exec(`(() => { const q = (k) => document.querySelector('.place-text [data-pt="' + k + '"]'); q('from').value = ${from}; q('to').value = ${to}; q('to').dispatchEvent(new Event('change')); })()`);
    const info = () => exec(`document.querySelector('.place-text .pt-info').textContent`);

    // The window opens on the page you're on, to the last page, in Body.
    await open('');
    const start = await exec(`(() => { const q = (k) => document.querySelector('.place-text [data-pt="' + k + '"]'); return { from: q('from').value, to: q('to').value, style: q('style').selectedOptions[0].textContent, place: document.querySelector('.place-text [data-a="place"]').disabled }; })()`);
    check('Place text starts on the page you are on, to the last page, in Body', start.from === '2' && start.to === '8' && start.style === 'Body', JSON.stringify(start));
    check('...and Place text waits for some text', start.place === true);
    await exec(`document.querySelector('.place-text [data-a="cancel"]').click()`);

    // A picture book: three short pages marked with ---, blank lines around them dropped.
    await open('Once upon a time there was a queen who loved to read.\n\n---\n\nShe read in the bath.\n---\nShe read on the bus.\n\n');
    check('the window says which pages it fills', /pages 2 to 4/.test(await info()), await info());
    if (shots) await shot(path.join(shots, 'place-text-window.png'));
    await exec(`document.querySelector('.place-text [data-a="place"]').click()`);
    await wait(400);
    const placed = await exec(`(() => {
      const d = App.S.doc;
      const boxes = [1, 2, 3].map((i) => d.pages[i].items[d.pages[i].items.length - 1]);
      const m = (i) => Model.margins(d, Model.side(d, i));
      return {
        n: boxes.filter((b) => b && b.type === 'text').length,
        page5: d.pages[4].items.length,
        linked: boxes[0].next === boxes[1].id && boxes[1].next === boxes[2].id && !boxes[2].next,
        text: !!boxes[0].text && !boxes[1].text,
        style: boxes.every((b) => b.styleId === 'st-body'),
        left: boxes[0].x === m(1).left && boxes[1].x === m(2).left && boxes[0].x !== boxes[1].x,
        size: boxes[0].w === d.w - d.margins.inside - d.margins.outside && boxes[0].h === d.h - d.margins.top - d.margins.bottom,
        sel: [...App.S.sel][0] === boxes[0].id, on: App.S.surface.idx,
      };
    })()`);
    check('a text box goes on each page the text needs, and no further', placed.n === 3 && placed.page5 === 0, JSON.stringify(placed));
    check('...linked one to the next, with the text in the first', placed.linked && placed.text, JSON.stringify(placed));
    check('...in the chosen text style', placed.style);
    check('...filling the margins, which swap sides on facing pages', placed.left && placed.size, JSON.stringify(placed));
    check('...and you land on the first page with its box selected', placed.sel && placed.on === 1, JSON.stringify(placed));
    const pages = await exec(`[1, 2, 3].map(${LINES})`);
    check('--- starts a new page', pages[0].join(' ').startsWith('Once upon a time') && pages[1][0] === 'She read in the bath.' && pages[2][0] === 'She read on the bus.', JSON.stringify(pages));
    check('...with no blank lines left over around it', pages[1].length === 1 && pages[2].length === 1 && !pages[0].includes(''), JSON.stringify(pages));
    if (shots) await shot(path.join(shots, 'place-text-page.png'));

    // One Ctrl+Z takes it all away.
    await exec(`App.history.doUndo()`);
    await wait(200);
    check('one undo removes every placed box', await exec(`App.S.doc.pages.every((p) => !p.items.length)`));

    // Too long for the range: ask, then add pages after the range.
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}. ` + 'The quick brown fox jumps over the lazy dog and keeps on running far away. '.repeat(4)).join('\n');
    await open(long);
    await setRange(3, 4);
    await wait(300);
    check('the window warns when the text needs more pages than you chose', /Needs about \d+ pages\. You chose 2\./.test(await info()), await info());
    const needed = await exec(`PlaceText.pagesNeeded(App.S.doc, PlaceText.clean(${JSON.stringify(long)}), App.S.doc.styles[0], 2).pages`);
    await exec(`document.querySelector('.place-text [data-a="place"]').click()`);
    check('...and asks whether to add pages or stop', await waitFor(() => exec(`/Add \\d+ pages/.test(document.querySelector('.modal-overlay:last-child [data-a="add"]')?.textContent || '')`), 2000));
    if (shots) (await wait(400), await shot(path.join(shots, 'place-text-ask.png')));
    await exec(`document.querySelector('.modal-overlay:last-child [data-a="add"]').click()`);
    await wait(500);
    const added = await exec(`(() => { const d = App.S.doc; const chain = Model.chainOf(d, d.pages[2].items[0].id); const last = chain[chain.length - 1]; return { pages: d.pages.length, chain: chain.length, firstOn: chain[0].s.idx, lastOn: last.s.idx, overflow: Layout.box(d, last.it, null).overflow, after: d.pages[2 + chain.length].items.length }; })()`);
    check('Add pages puts new pages after the range and fills them', added.pages === 8 + needed - 2 && added.chain === needed && added.firstOn === 2 && added.lastOn === 2 + needed - 1 && !added.overflow, JSON.stringify({ added, needed }));
    check('...and the pages that were after the range move along, untouched', added.after === 0, JSON.stringify(added));
    await exec(`App.history.doUndo()`);
    await wait(200);
    check('...and undo takes the new pages away too', await exec(`App.S.doc.pages.length === 8 && App.S.doc.pages.every((p) => !p.items.length)`));

    // Or stop at the last page: the rest waits in the last box.
    await open(long);
    await setRange(3, 4);
    await wait(300);
    await exec(`document.querySelector('.place-text [data-a="place"]').click()`);
    await waitFor(() => exec(`!!document.querySelector('.modal-overlay:last-child [data-a="stop"]')`), 2000);
    await exec(`document.querySelector('.modal-overlay:last-child [data-a="stop"]').click()`);
    await wait(400);
    const stopped = await exec(`(() => { const d = App.S.doc; const b = d.pages[3].items[0]; return { pages: d.pages.length, overflow: b && Layout.box(d, b, null).overflow, warned: Preflight.run(d).length > 0 }; })()`);
    check('Stop keeps your range and leaves the rest waiting, which Check lists', stopped.pages === 8 && stopped.overflow && stopped.warned, JSON.stringify(stopped));

    // In a box on its own, --- is just text.
    const lone = await exec(`(() => {
      const d = App.S.doc; let it;
      App.change('Add', () => { it = Model.newItem('text', 20, 20, 100, 60, d); it.text = 'a\\n---\\nb'; d.pages[7].items.push(it); });
      return Layout.box(d, it, null).lines.map((l) => l.text);
    })()`);
    check('in a box that does not continue, --- stays as text', JSON.stringify(lone) === '["a","---","b"]', JSON.stringify(lone));

    // A break in the last box with more after it: the rest waits.
    const lastBreak = await exec(`(() => { const r = Layout.measure(App.S.doc, 'a\\n---\\nb\\n---\\nc', App.S.doc.styles[0], 100, 100, 2); return r; })()`);
    check('a break with no box left over marks the text as not fitting', lastBreak.overflow === true && lastBreak.used === 2, JSON.stringify(lastBreak));

    // Empty lines: a gap on the same page (to start with), or a new page.
    const chat = 'hello my name is sab\n\nhi nice to meet you.\nmy name is Joanna,\n\nlovely to meet you.';
    await exec(`App.history.doUndo(); App.history.doUndo(); App.goTo({ kind: 'page', idx: 0 })`);
    await open(chat);
    await setRange(1, 8);
    await wait(300);
    check('Empty lines leave a gap to start with', await exec(`document.querySelector('.place-text [data-pt-seg="empty"] .on').dataset.v === 'gap'`));
    check('...so the chat fits on one page', /Fits on page 1/.test(await info()), await info());
    await exec(`document.querySelector('.place-text [data-pt-seg="empty"] [data-v="break"]').click()`);
    await wait(300);
    check('Start a new page makes each part its own page', /pages 1 to 3/.test(await info()), await info());
    if (shots) await shot(path.join(shots, 'place-text-empty-lines.png'));
    await exec(`document.querySelector('.place-text [data-a="place"]').click()`);
    await wait(400);
    const chatPages = await exec(`[0, 1, 2, 3].map(${LINES})`);
    check('...placed that way', JSON.stringify(chatPages.slice(0, 3)) === JSON.stringify([['hello my name is sab'], ['hi nice to meet you.', 'my name is Joanna,'], ['lovely to meet you.']]) && !chatPages[3], JSON.stringify(chatPages));
    await exec(`PlaceText.open()`);
    await waitFor(() => exec(`!!document.querySelector('.place-text')`), 2000);
    check('...and the choice is remembered next time', await exec(`document.querySelector('.place-text [data-pt-seg="empty"] .on').dataset.v === 'break'`));
    await exec(`document.querySelector('.place-text [data-a="cancel"]').click()`);
    const cleaned = await exec(`[
      PlaceText.clean('a\\n\\n\\n---\\n\\nb', { emptyLines: 'break' }),
      PlaceText.clean('a\\n---\\n---\\nb', { emptyLines: 'break' }),
      PlaceText.clean('\\n\\na\\n\\nb\\n\\n', { emptyLines: 'break' }),
      PlaceText.clean('a\\n\\nb', { emptyLines: 'gap' }),
    ]`);
    check('empty lines next to a --- make one new page, not several', cleaned[0] === 'a\n---\nb', JSON.stringify(cleaned));
    check('...two --- in a row still leave a page empty', cleaned[1] === 'a\n---\n---\nb', JSON.stringify(cleaned));
    check('...empty lines at the start or end are ignored', cleaned[2] === 'a\n---\nb', JSON.stringify(cleaned));
    check('...and Leave a gap keeps them as they are', cleaned[3] === 'a\n\nb', JSON.stringify(cleaned));
    await exec('App.S.dirty = false');
  };
}
