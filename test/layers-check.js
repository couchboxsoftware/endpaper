// Layers: in the right panel, next to Properties. Lists the page's boxes top first, selects them,
// hides and locks them, and shows the master's boxes underneath.
// Run: node test/layers-check.js
const path = require('path');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const run = await H.launch(__filename, { userData: H.tempUserData('layers'), env: { ENDPAPER_TEST_SHOTS: process.env.ENDPAPER_TEST_SHOTS || null } });
    H.finish('layers-check', [run]);
  })();
} else {
  module.exports = async ({ exec, shot }) => {
    const { check, appReady, wait } = H.inApp({ exec });
    await appReady();

    await exec(`(async () => {
      await App.newDocument({ name: 'Layers', w: 148, h: 210, pages: 2, kind: 'print', bleed: 3 });
      const d = App.S.doc;
      App.change('Boxes', () => {
        const a = Model.newItem('rect', 20, 20, 40, 30, d); a.name = 'Back box';
        const b = Model.newItem('ellipse', 40, 40, 40, 30, d); b.name = 'Front circle';
        d.pages[0].items.push(a, b);
        const m = Model.newItem('rect', 10, 180, 30, 10, d); m.name = 'Footer bar';
        d.masters[0].right.push(m); d.masters[0].left.push(JSON.parse(JSON.stringify(m)));
        window.__a = a.id; window.__b = b.id;
      });
    })()`);
    await wait(300);

    check('Layers is a tab on the right, after Properties', await exec(`[...document.querySelectorAll('#right-tabs [data-tab]')].map((b) => b.dataset.tab).slice(0, 2).join(',') === 'props,layers'`));
    check('...and no longer on the left', await exec(`!document.querySelector('#left-tabs [data-tab="layers"]')`));
    await exec(`document.querySelector('#right-tabs [data-tab="layers"]').click()`);
    await wait(150);
    const names = await exec(`[...document.querySelectorAll('#right-body .layer[data-layer] .lname')].map((x) => x.textContent).join(',')`);
    check("it lists the page's boxes, top first", names === 'Front circle,Back box', names);
    check("...and the master's boxes underneath", /Footer bar/.test(await exec(`document.querySelector('#right-body .layers').textContent`)));
    await exec(`document.querySelector('#right-body [data-layer="' + window.__a + '"] .lname').click()`);
    await wait(150);
    check('clicking a row selects the box', await exec(`App.S.sel.has(window.__a) && App.S.sel.size === 1`));
    check('...and Layers stays open', await exec(`App.S.rightTab === 'layers' && !!document.querySelector('#right-body .layer.on')`));
    await exec(`document.querySelector('#right-body [data-layer="' + window.__a + '"] [data-tog="hidden"]').click()`);
    await wait(150);
    check('the eye hides it', await exec(`Model.findItem(App.S.doc, window.__a).item.hidden === true`));
    await exec(`document.querySelector('#right-body [data-layer="' + window.__a + '"] [data-tog="hidden"]').click()`);
    await wait(150);
    check('...and shows it again', await exec(`!Model.findItem(App.S.doc, window.__a).item.hidden`));
    // Selecting on the page updates the list.
    await exec(`App.select([window.__b])`);
    await wait(150);
    check('selecting on the page highlights its row', await exec(`document.querySelector('#right-body .layer.on')?.dataset.layer === window.__b`));
    // Drag the back box to the top.
    await exec(`(() => {
      const rows = document.querySelectorAll('#right-body .layer[data-layer]');
      const dt = new DataTransfer();
      rows[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: rows[0].getBoundingClientRect().top + 1 }));
      rows[0].classList.add('drop-above');
      rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    await wait(200);
    const order = await exec(`App.S.doc.pages[0].items.map((x) => x.name).join(',')`);
    check('dragging a row reorders the boxes', order === 'Front circle,Back box', order);
    check('the left panel shows Pages', await exec(`!!document.querySelector('#left-body .spreads')`));
    if (process.env.ENDPAPER_TEST_SHOTS) await shot(path.join(process.env.ENDPAPER_TEST_SHOTS, 'layers-right.png'));
    await exec('App.S.dirty = false');
  };
}
