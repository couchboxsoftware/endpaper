// Shipment preparation: the paper and binding set the spine and the size and weight of a copy.
// New book's More options sets them from the start; File, Shipment preparation changes them (with
// the printer's own thickness winning); the cover's Properties sums them up in one line; older
// files keep exactly the spine they had.
// Run: node test/shipment-check.js
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const run = await H.launch(__filename, { userData: H.tempUserData('shipment') });
    H.finish('shipment-check', [run]);
  })();
} else {
  module.exports = async ({ exec }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    await appReady();
    const key = (k, mods = {}) => exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, altKey: ${!!mods.alt}, ctrlKey: ${!!mods.ctrl}, bubbles: true, cancelable: true }))`);
    const near = (a, b, d = 0.01) => Math.abs(a - b) <= d;

    // A poster has no shipment preparation.
    await exec(`App.newDocument({ name: 'Poster', w: 210, h: 297, pages: 1, kind: 'print', bleed: 3 })`);
    await wait(400);
    check('a single-page design has no shipment preparation', (await exec('Shipment.available(App.S.doc)')) === false);

    // New book from File, with More options: 120 pages, 100 gsm silk pages, 250 gsm gloss cover, hardback.
    await key('f', { alt: true });
    await wait(150);
    await key('b');
    check('File, New book opens the dialog', await waitFor(() => exec(`!!document.querySelector('.modal .nd-more')`), 3000));
    await exec(`(() => {
      const m = document.querySelector('.modal');
      const set = (sel, v) => { const el = m.querySelector(sel); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
      m.querySelector('.nd-more').open = true;
      set('[data-n="pages"]', '120');
      set('[data-pf="pagesGsm"]', '100');
      set('[data-pf="pagesFinish"]', 'silk');
      set('[data-pf="coverGsm"]', '250');
      set('[data-pf="coverFinish"]', 'gloss');
      m.querySelector('[data-pf-seg="binding"] [data-v="hardback"]').click();
    })()`);
    await wait(150);
    const spineLine = await exec(`document.querySelector('.modal .nd-spine').textContent`);
    check('More options shows the spine it gives', /Spine about 5\.4 mm for 120 pages/.test(spineLine), spineLine);
    await exec(`document.querySelector('.modal [data-a="yes"]').click()`);
    check('the book is made', await waitFor(() => exec(`App.S.doc && App.S.doc.name === 'My book' && App.S.doc.pages.length === 120`), 5000));
    const print = await exec('JSON.stringify(App.S.doc.print)');
    const p = JSON.parse(print);
    check('it keeps the paper and binding from More options', p.binding === 'hardback' && p.pagesGsm === 100 && p.pagesFinish === 'silk' && p.coverGsm === 250 && p.coverFinish === 'gloss', print);
    const spine = await exec('Model.cover(App.S.doc).spine');
    check('the cover spine comes from that paper: 120 × 100 gsm silk', near(spine, 5.4), spine);

    // The window: one copy's size and weight.
    await exec('Shipment.open()');
    await wait(300);
    const text = await exec(`document.querySelector('.modal.shipment .sp-results').innerText.replace(/\\n+/g, ' | ')`);
    check('Shipment preparation shows pages and sheets', /120 pages · 60 sheets/.test(text), text);
    // Pages: 60 sheets × 0.129 × 0.198 m × 100 g/m² = 153 g. Hardback case: 132 × 204 mm.
    check('...the weight of the pages', /Pages \| 153 g/.test(text) || /Pages\s+153 g/.test(text), text);
    check('...a hardback case 3 mm past the pages', /132 × 204 × /.test(text), text);
    check('...boards and endpapers in the weight', /Boards/.test(text) && /Endpapers/.test(text), text);
    const total = await exec('Model.bookSpecs(App.S.doc).total');
    check('...and a total that adds up', /about \d+ g/.test(text) && total > 153 && total < 600, `${total} g`);

    // The printer's thickness wins, and the spine follows.
    await exec(`(() => { const el = document.querySelector('.modal.shipment [data-pf="caliper"]'); el.value = '0.06'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(200);
    check("typing the printer's thickness changes the spine to 120 × 0.06 mm", near(await exec('Model.cover(App.S.doc).spine'), 7.2), await exec('Model.cover(App.S.doc).spine'));
    check('...and the window says it uses it', /Uses your printer's thickness, 0\.06 mm a page/.test(await exec(`document.querySelector('.modal.shipment').innerText`)));
    await exec(`document.querySelector('.modal.shipment [data-a="done"]').click()`);
    await wait(200);
    await exec('App.history.doUndo()');
    await wait(200);
    check('undo puts the estimate back', near(await exec('Model.cover(App.S.doc).spine'), 5.4), await exec('Model.cover(App.S.doc).spine'));

    // Paperback is lighter and the same size as the pages.
    await exec(`App.change('Paper and binding', () => { App.S.doc.print.binding = 'paperback'; })`);
    const pb = await exec('JSON.stringify(Model.bookSpecs(App.S.doc))');
    const s = JSON.parse(pb);
    check('a paperback is the size of its pages, with no boards', s.size.w === 129 && s.size.h === 198 && !s.parts.some(([n]) => n === 'Boards'), pb);
    check('...and lighter than the hardback', s.total < total, `${s.total} < ${total}`);

    // The cover's Properties: one line about the paper, and Change… opens the window.
    await exec(`App.goTo({ kind: 'cover' })`);
    await wait(300);
    const line = await exec(`document.querySelector('#right-body .paper-line span').textContent`);
    check("the cover's Properties sums up the paper in one line", line === 'Paperback · 100 gsm silk, white', line);
    check('...without the old paper list or per-page box', await exec(`!document.querySelector('[data-paper]') && !document.querySelector('[data-f="c.perPage"]')`));
    await exec(`document.querySelector('#right-body [data-act="shipment"]').click()`);
    check('...and Change… opens Shipment preparation', await waitFor(() => exec(`!!document.querySelector('.modal.shipment')`), 2000));
    await exec(`document.querySelector('.modal.shipment [data-a="done"]').click()`);

    // An older file: the paper was picked from a list for the spine only. Same spine as before.
    await exec(`(async () => {
      const d = JSON.parse(JSON.stringify(App.S.doc));
      delete d.print; d.cover.paper = 'kdp-white'; d.cover.perPage = 0.0572; d.cover.spineExtra = 0;
      await App.loadDoc(d, null);
    })()`);
    await wait(400);
    const old = JSON.parse(await exec('JSON.stringify({ spine: Model.cover(App.S.doc).spine, print: App.S.doc.print, paper: App.S.doc.cover.paper })'));
    check('an older file keeps exactly the spine it had', near(old.spine, 120 * 0.0572, 0.0001), old.spine);
    check('...by carrying its old figure over as the printer’s thickness', old.print.caliper === 0.0572 && old.print.pagesGsm === 90 && old.paper === undefined, JSON.stringify(old.print));
    await exec('App.S.dirty = false');
  };
}
