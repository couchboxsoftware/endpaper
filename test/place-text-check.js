// Place text and Format story: a panel beside the pages. Paste a long text and it appears live
// in a box inside the margins of each page, linked so it flows on; change the look and the pages
// follow, adding pages when it needs more (and taking them away again). A line with just ---
// starts a new page, and empty lines can too. Cancel puts everything back; Done is one undo step.
// Format story changes the look of placed text later, with buttons to add or remove pages.
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
      App.S.dirty = false;
    })()`);
    await wait(300);

    const Q = (sel) => `document.querySelector('.pt-panel ${sel}')`;
    const type = async (text) => {
      await exec(`(() => { const t = ${Q('.pt-text')}; t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); })()`);
      await wait(600);
    };
    const setPt = async (k, v) => {
      await exec(`(() => { const e = ${Q(`[data-pt="${k}"]`)}; if (e.type === 'checkbox') e.checked = ${JSON.stringify(v)}; else e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await wait(300);
    };
    const setLk = async (k, v) => {
      await exec(`(() => { const e = ${Q(`[data-lk="${k}"]`)}; e.value = ${JSON.stringify(String(v))}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await wait(300);
    };
    const click = async (sel) => {
      await exec(`${Q(sel)}.click()`);
      await wait(300);
    };
    const info = () => exec(`${Q('.pt-info')}.textContent`);
    const open = async () => {
      await exec(`PlaceText.open()`);
      await waitFor(() => exec(`!!document.querySelector('.pt-panel')`), 2000);
      await wait(200);
    };
    // Lines of the last box on a page.
    const LINES = `(idx) => { const d = App.S.doc; const it = d.pages[idx] && d.pages[idx].items[d.pages[idx].items.length - 1]; return it ? Layout.box(d, it, Render.ctxFor(d, { kind: 'page', idx })).lines.map((l) => l.text) : null; }`;
    const state = () => exec(`(() => { const d = App.S.doc; return { pages: d.pages.length, items: d.pages.map((p) => p.items.length), undo: App.history.undo.length, dirty: App.S.dirty }; })()`);

    // The panel opens beside the pages, on the page you're on, and waits for text.
    const undo0 = (await state()).undo;
    await open();
    const start = await exec(`(() => ({ docked: !!document.querySelector('#right .pt-panel'), from: ${Q('[data-pt="from"]')}.value, to: ${Q('[data-pt="to"]')}.value, style: ${Q('[data-lk="style"]')}.selectedOptions[0].textContent, done: ${Q('[data-a="done"]')}.disabled, add: ${Q('[data-pt="add"]')}.checked }))()`);
    check('Place text opens as a panel beside the pages', start.docked, JSON.stringify(start));
    check('...on the page you are on, to the last page, in Body', start.from === '2' && start.to === '8' && start.style === 'Body', JSON.stringify(start));
    check('...with Add pages ticked, and Done waiting for some text', start.add && start.done, JSON.stringify(start));

    // Live: a picture book appears on the pages as you type.
    await type('Once upon a time there was a queen who loved to read.\n\n---\n\nShe read in the bath.\n---\nShe read on the bus.\n\n');
    let s = await state();
    check('the text appears on the pages straight away', s.items.join('') === '01110000', JSON.stringify(s));
    check('...and the panel says where', /Fills pages 2 to 4\./.test(await info()), await info());
    const pages = await exec(`[1, 2, 3].map(${LINES})`);
    check('--- starts a new page, with no blank lines left over', pages[1][0] === 'She read in the bath.' && pages[2].length === 1 && !pages[0].includes(''), JSON.stringify(pages));
    check('...and the box fills the margins', await exec(`(() => { const d = App.S.doc; const b = d.pages[2].items[0]; const m = Model.margins(d, Model.side(d, 2)); return b.x === m.left && b.y === m.top && b.w === d.w - m.left - m.right; })()`));

    // The rest of Endpaper waits: shortcuts do nothing, and Alt doesn't open the menus.
    await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }))`);
    await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', altKey: true, bubbles: true, cancelable: true }))`);
    await wait(100);
    check('while the panel is open, shortcuts and menus wait', await exec(`App.S.tool !== 'rect' && !document.querySelector('.mb-drop')`));

    // Cancel puts everything back as it was.
    if (shots) await shot(path.join(shots, 'place-text-panel.png'));
    await click('.pt-foot [data-a="cancel"]');
    s = await state();
    check('Cancel takes it all away, with nothing to undo and nothing to save', s.items.every((n) => n === 0) && s.undo === undo0 && !s.dirty && !(await exec(`!!document.querySelector('.pt-panel')`)), JSON.stringify(s));

    // A long text, pages 3 to 4: it needs more, so pages are added after page 4.
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}. ` + 'The quick brown fox jumps over the lazy dog and keeps on running far away. '.repeat(4)).join('\n');
    await open();
    await setPt('from', 3);
    await setPt('to', 4);
    await type(long);
    s = await state();
    const need = await exec(`PlaceText.pagesNeeded(App.S.doc, PlaceText.clean(${JSON.stringify(long)}), Model.styleOf(App.S.doc, App.S.doc.pages[2].items[0]), 2).pages`);
    check('text that needs more pages adds them after your range', s.pages === 8 + need - 2 && /with \d+ new pages/.test(await info()), JSON.stringify({ s, need, info: await info() }));
    const added0 = s.pages;
    // Bigger text: more pages. Smaller: the added pages go again.
    await setLk('size', 16);
    const bigger = (await state()).pages;
    check('making the text bigger adds pages as you go', bigger > added0, JSON.stringify({ added0, bigger }));
    check('...and keeps the leading in step', await exec(`(() => { const st = App.S.doc.pages[2].items[0].style; return Math.abs(st.leading / st.size - 15 / 11) < 0.02; })()`));
    await setLk('size', 7);
    const smaller = (await state()).pages;
    check('making it smaller takes the added pages away again', smaller < added0, JSON.stringify({ added0, smaller }));
    if (shots) await shot(path.join(shots, 'place-text-live.png'));
    // Untick Add pages: the rest waits in page 4's box.
    await setLk('size', 11);
    await setPt('add', false);
    s = await state();
    check('without Add pages, your range is kept and the rest waits', s.pages === 8 && /the rest waits/.test(await info()) && (await exec(`Layout.box(App.S.doc, App.S.doc.pages[3].items[0], null).overflow`)), JSON.stringify({ s, info: await info() }));
    await setPt('add', true);
    // Look: alignment and font.
    await click('[data-lk-seg="align"] [data-v="center"]');
    check('the look goes to every box', await exec(`App.S.doc.pages.flatMap((p) => p.items).every((b) => b.style.align === 'center' && b.style.size === 11)`));
    // Done: one step to undo, and you land on the first page with its box selected.
    const before = (await state()).undo;
    await click('.pt-foot [data-a="done"]');
    s = await state();
    check('Done keeps it as one step to undo', s.undo === before + 1 && (await exec(`App.history.undo[App.history.undo.length - 1].label`)) === 'Place text', JSON.stringify(s));
    check('...and selects the first box, on its page', await exec(`App.S.surface.idx === 2 && [...App.S.sel][0] === App.S.doc.pages[2].items[0].id`));
    const placedPages = s.pages;

    // Properties: a change on any box of linked text goes to all of it.
    const prop = await exec(`(async () => {
      const d = App.S.doc;
      const chain = Model.chainOf(d, d.pages[2].items[0].id);
      const third = chain[2].it;
      App.goTo({ kind: 'page', idx: chain[2].s.idx });
      App.select([third.id]);
      await new Promise((r) => setTimeout(r, 200));
      const hint = document.querySelector('#right-body .hint').textContent;
      const inp = document.querySelector('#right-body [data-f="s.size"]');
      inp.value = '12'; inp.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return { all: Model.chainOf(d, chain[0].it.id).every((c) => c.it.style.size === 12), hint, button: !!document.querySelector('#right-body [data-act="format-story"]') };
    })()`);
    check('Properties changes all of a linked text, from any of its boxes', prop.all, JSON.stringify(prop));
    check('...and says so, with Format story… there', /linked boxes/.test(prop.hint) && prop.button, JSON.stringify(prop));

    // Format story: bigger text doesn't add pages by itself; a button does.
    await exec(`PlaceText.format(App.S.doc.pages[2].items[0])`);
    await waitFor(() => exec(`!!document.querySelector('.pt-panel')`), 2000);
    await wait(200);
    check('Format story opens with the text in its box', await exec(`${Q('.pt-text')}.value === App.S.doc.pages[2].items[0].text && /Format story/.test(${Q('h3')}.textContent)`));
    // Editing the words there changes the pages as you type; Cancel puts them back.
    const words0 = await exec(`App.S.doc.pages[2].items[0].text`);
    await type('Brand new opening line.\n---\n' + words0);
    const edited = await exec(`[2, 3].map(${LINES})`);
    check('...and changing the words there changes the pages as you go', edited[0][0] === 'Brand new opening line.' && edited[0].length === 1 && /^Paragraph 1\./.test(edited[1][0]), JSON.stringify(edited));
    await click('.pt-foot [data-a="cancel"]');
    check('...and Cancel puts the words back', (await exec(`App.S.doc.pages[2].items[0].text`)) === words0);
    await exec(`PlaceText.format(App.S.doc.pages[2].items[0])`);
    await waitFor(() => exec(`!!document.querySelector('.pt-panel')`), 2000);
    await wait(200);
    await setLk('size', 16);
    check('bigger text in Format story keeps the pages as they are', (await state()).pages === placedPages && /more text than fits/.test(await info()), await info());
    if (shots) await shot(path.join(shots, 'format-story.png'));
    await click('[data-a="fit-add"]');
    const grown = (await state()).pages;
    check('...until Add pages adds what it needs, after its last page', grown > placedPages && /fits its/.test(await info()), JSON.stringify({ grown, info: await info() }));
    await setLk('size', 9);
    check('smaller text offers to remove the empty pages at the end', await exec(`/Remove \\d+ empty pages?/.test(${Q('[data-a="fit-remove"]')}?.textContent || '')`), await info());
    await click('[data-a="fit-remove"]');
    const shrunk = (await state()).pages;
    check('...and removes them', shrunk < grown && /fits its/.test(await info()), JSON.stringify({ grown, shrunk, info: await info() }));

    // Save the look as a text style, and update it.
    await click('[data-a="save-style"]');
    await waitFor(() => exec(`!!document.querySelector('.modal-overlay input')`), 2000);
    await exec(`(() => { const i = document.querySelector('.modal-overlay input'); i.value = 'Story text'; document.querySelector('.modal-overlay [data-a="yes"]').click(); })()`);
    await wait(300);
    const saved = await exec(`(() => { const d = App.S.doc; const st = d.styles.find((x) => x.name === 'Story text'); return { st: !!st, size: st && st.size, picked: ${Q('[data-lk="style"]')}.selectedOptions[0].textContent, boxes: Model.chainOf(d, d.pages[2].items[0].id).every((c) => c.it.styleId === (st && st.id)) }; })()`);
    check('Save as new style makes a text style from the look, and uses it', saved.st && saved.size === 9 && saved.picked === 'Story text' && saved.boxes, JSON.stringify(saved));
    await setLk('tracking', 20);
    check('...changing the look offers to update that style', await exec(`/Update “Story text”/.test(${Q('[data-a="update-style"]')}?.textContent || '')`));
    await click('[data-a="update-style"]');
    check('...which updates it', await exec(`App.S.doc.styles.find((x) => x.name === 'Story text').tracking === 20`));
    const u0 = (await state()).undo;
    await click('.pt-foot [data-a="done"]');
    check('Format story is one step to undo too', (await state()).undo === u0 + 1 && (await exec(`App.history.undo[App.history.undo.length - 1].label`)) === 'Format story');

    // One undo takes Format story away; another takes the placed text and its pages away.
    await exec(`App.history.doUndo()`); // format story
    await exec(`App.history.doUndo()`); // properties size
    await exec(`App.history.doUndo()`); // place text
    await wait(300);
    s = await state();
    check('undoing Place text takes its pages away too', s.pages === 8 && s.items.every((n) => n === 0), JSON.stringify(s));

    // Empty lines: a gap on the same page, or a new page.
    const chat = 'hello my name is sab\n\nhi nice to meet you.\nmy name is Joanna,\n\nlovely to meet you.';
    await exec(`App.goTo({ kind: 'page', idx: 0 })`);
    await open();
    await type(chat);
    check('Empty lines leave a gap to start with: the chat fits on one page', /Fills page 1\./.test(await info()), await info());
    await click('[data-pt-seg="empty"] [data-v="break"]');
    check('Start a new page makes each part its own page', /Fills pages 1 to 3\./.test(await info()), await info());
    const chatPages = await exec(`[0, 1, 2].map(${LINES})`);
    check('...placed that way', JSON.stringify(chatPages) === JSON.stringify([['hello my name is sab'], ['hi nice to meet you.', 'my name is Joanna,'], ['lovely to meet you.']]), JSON.stringify(chatPages));
    await click('.pt-foot [data-a="done"]');
    const kept = await exec(`(() => { const h = App.S.doc.pages[0].items[0]; return { text: h.text, rule: h.emptyLines }; })()`);
    check('the story keeps your empty lines as you typed them, and the rule with them', kept.text === chat && kept.rule === 'break', JSON.stringify(kept));
    // Format story: the same rule, and the text with its empty lines.
    await exec(`PlaceText.format(App.S.doc.pages[0].items[0])`);
    await waitFor(() => exec(`!!document.querySelector('.pt-panel')`), 2000);
    await wait(200);
    check('Format story opens with the story’s own Empty lines rule', await exec(`${Q('[data-pt-seg="empty"] .on')}.dataset.v === 'break' && ${Q('.pt-text')}.value === ${JSON.stringify(chat)}`));
    await type(chat + '\n\nsee you soon');
    check('...so an empty line typed there starts a new page, offering to add it', /Add 1 page$/.test(await exec(`${Q('[data-a="fit-add"]')}?.textContent || ''`)), await info());
    await click('[data-a="fit-add"]');
    check('...which holds the new part', JSON.stringify(await exec(`[3].map(${LINES})`)) === '[["see you soon"]]' && /fits its 4 boxes/.test(await info()), JSON.stringify({ p4: await exec(`[3].map(${LINES})`), info: await info() }));
    await click('[data-pt-seg="empty"] [data-v="gap"]');
    check('...and switching to Leave a gap puts it all back on one page', (await exec(`[0].map(${LINES})`))[0].length === 8 && (await exec(`App.S.doc.pages[0].items[0].emptyLines`)) == null, JSON.stringify(await exec(`[0].map(${LINES})`)));
    await click('[data-pt-seg="empty"] [data-v="break"]');
    await click('.pt-foot [data-a="cancel"]');
    check('...and Cancel keeps the story as it was', (await exec(`App.S.doc.pages[0].items[0].text`)) === chat && (await exec(`App.S.doc.pages[0].items[0].emptyLines`)) === 'break');
    // A story placed before the rule was kept: --- and no empty lines means Start a new page.
    await exec(`(() => { const h = App.S.doc.pages[0].items[0]; h.text = 'one\\n---\\ntwo\\n---\\nthree'; delete h.emptyLines; Layout.invalidate(); })()`);
    await exec(`PlaceText.format(App.S.doc.pages[0].items[0])`);
    await waitFor(() => exec(`!!document.querySelector('.pt-panel')`), 2000);
    await wait(200);
    check('a story placed in an earlier version keeps its rule too', await exec(`${Q('[data-pt-seg="empty"] .on')}.dataset.v === 'break'`));
    await type('one\n\ntwo\n---\nthree');
    check('...so empty lines start new pages there as well', JSON.stringify(await exec(`[0, 1, 2].map(${LINES})`)) === '[["one"],["two"],["three"]]', JSON.stringify(await exec(`[0, 1, 2].map(${LINES})`)));
    await click('.pt-foot [data-a="cancel"]');
    await exec(`App.history.doUndo()`);
    await wait(200);
    await open();
    check('...and the choice is remembered next time', await exec(`${Q('[data-pt-seg="empty"] .on')}.dataset.v === 'break'`));
    await click('.pt-foot [data-a="cancel"]');

    // The text tidying and the break itself.
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
    const lone = await exec(`(() => {
      const d = App.S.doc; let it;
      App.change('Add', () => { it = Model.newItem('text', 20, 20, 100, 60, d); it.text = 'a\\n---\\nb'; d.pages[7].items.push(it); });
      return Layout.box(d, it, null).lines.map((l) => l.text);
    })()`);
    check('in a box that does not continue, --- stays as text', JSON.stringify(lone) === '["a","---","b"]', JSON.stringify(lone));
    const lastBreak = await exec(`Layout.measure(App.S.doc, 'a\\n---\\nb\\n---\\nc', App.S.doc.styles[0], 100, 100, 2)`);
    check('a break with no box left over marks the text as not fitting', lastBreak.overflow === true && lastBreak.used === 2, JSON.stringify(lastBreak));

    // The right-hand panel: drag its edge to resize it, remembered; double-click puts it back.
    const drag = (dx) => exec(`(() => {
      const h = document.querySelector('#right .right-resize'); const r = h.getBoundingClientRect(); const x = r.left + 3, y = r.top + 200;
      const ev = (t, cx) => h.dispatchEvent(new PointerEvent(t, { clientX: cx, clientY: y, pointerId: 1, bubbles: true }));
      ev('pointerdown', x); ev('pointermove', x + ${dx}); ev('pointerup', x + ${dx});
      return Math.round(document.querySelector('#right').getBoundingClientRect().width);
    })()`);
    const w0 = await exec(`Math.round(document.querySelector('#right').getBoundingClientRect().width)`);
    const wider = await drag(-180);
    await wait(300);
    check('dragging the right panel edge makes it wider', Math.abs(wider - (w0 + 180)) <= 2, JSON.stringify({ w0, wider }));
    check('...and it is remembered', (await exec(`App.S.settings.rightWidth`)) === wider);
    await open();
    check('...with Place text filling the wider panel', Math.abs((await exec(`Math.round(document.querySelector('.pt-panel').getBoundingClientRect().width)`)) - wider) <= 2);
    if (shots) {
      await type(chat);
      await shot(path.join(shots, 'place-text-wide.png'));
    }
    await click('.pt-foot [data-a="cancel"]');
    const narrow = await drag(2000);
    check('...it never gets too narrow', narrow >= 299 && narrow <= 301, String(narrow));
    await exec(`document.querySelector('#right .right-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await wait(300);
    check('double-clicking the edge puts it back', (await exec(`Math.round(document.querySelector('#right').getBoundingClientRect().width)`)) === 320);
    await exec('App.S.dirty = false');
  };
}
