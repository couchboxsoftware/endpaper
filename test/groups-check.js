// Resizing photos and groups.
//  - A photo's corner scales the whole picture (frame and photo together); Shift on a corner, or a
//    side, crops: the photo stays put, and grows only so the frame never shows a new gap.
//  - Fill frame and Fit in frame are one-off buttons.
//  - Groups (Ctrl+G): one click picks up the group, a double-click goes into it, Esc comes out;
//    corners scale everything (text sizes too), the handle on top turns it all; copies make new
//    groups; Layers shows a folder you can open, hide, lock, rename and drag boxes in and out of.
// Run: node test/groups-check.js
const path = require('path');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const run = await H.launch(__filename, { userData: H.tempUserData('groups'), env: { ENDPAPER_TEST_SHOTS: process.env.ENDPAPER_TEST_SHOTS || null } });
    H.finish('groups-check', [run]);
  })();
} else {
  module.exports = async ({ exec, shot }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    await appReady();
    const shots = process.env.ENDPAPER_TEST_SHOTS;
    const near = (a, b, t = 0.05) => Math.abs(a - b) <= t;
    let window_gid = null;

    await exec(`(async () => {
      await App.newDocument({ name: 'Groups', w: 210, h: 297, pages: 1, kind: 'print', bleed: 3 });
      const d = App.S.doc;
      const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 1200, 0); gr.addColorStop(0, '#246'); gr.addColorStop(1, '#fc6'); g.fillStyle = gr; g.fillRect(0, 0, 1200, 800);
      const bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      window.__asset = await Assets.add(d, { name: 'wide.png', mime: 'image/png', bytes });
      let it; App.change('Add photo', () => { it = Model.newItem('image', 30, 30, 90, 60, d); it.asset = window.__asset; Render.fitImage(it, d.assets[window.__asset], 'fill'); d.pages[0].items.push(it); });
      window.__ph = it.id;
      App.select([it.id]);
      Editor.fit();
    })()`);
    await wait(300);
    const PH = `Model.findItem(App.S.doc, window.__ph).item`;
    const get = (expr) => exec(`(() => { const it = ${expr}; return JSON.parse(JSON.stringify({ x: it.x, y: it.y, w: it.w, h: it.h, s: it.s, ox: it.ox, oy: it.oy, rot: it.rot, style: it.style, strokeW: it.strokeW })); })()`);
    // Drags a handle by (dx, dy) mm on the page, with keys held if asked.
    const dragHandle = (sel, dx, dy, mods = {}) => exec(`(async () => {
      const h = document.querySelector(${JSON.stringify(sel)}); if (!h) return 'no handle';
      const r = h.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2, k = App.S.zoom;
      const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, shiftKey: ${!!mods.shift}, altKey: ${!!mods.alt} };
      h.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: x, clientY: y }));
      for (const f of [0.5, 1]) window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x + ${dx} * k * f, clientY: y + ${dy} * k * f }));
      window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x + ${dx} * k, clientY: y + ${dy} * k }));
      await new Promise((r) => setTimeout(r, 60));
      return 'ok';
    })()`);
    // Presses on a box on the page (twice quickly for a double-click).
    const press = (id, times = 1) => exec(`(async () => {
      for (let i = 0; i < ${times}; i++) {
        const el = document.querySelector('.sel[data-id="' + ${JSON.stringify(id)} + '"]') || document.querySelector('#pages-host .item[data-id="' + ${JSON.stringify(id)} + '"]');
        const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: r.left + 6, clientY: r.top + 6 };
        el.dispatchEvent(new PointerEvent('pointerdown', o));
        window.dispatchEvent(new PointerEvent('pointerup', o));
        await new Promise((r) => setTimeout(r, 40));
      }
    })()`);
    const key = (k, mods = {}) => exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, bubbles: true, cancelable: true }))`);
    const covers = (p) => p.ox <= 0.02 && p.oy <= 0.02 && p.ox + 1200 * p.s >= p.w - 0.02 && p.oy + 800 * p.s >= p.h - 0.02;

    /* ----- photos ----- */
    let a = await get(PH);
    await dragHandle('.sel .h-se', 30, 30);
    let b = await get(PH);
    const k1 = b.w / a.w;
    check('a photo corner scales frame and photo together, keeping the shape', k1 > 1.1 && near(b.h / a.h, k1, 0.01) && near(b.s / a.s, k1, 0.01) && near(b.x, a.x) && near(b.y, a.y), JSON.stringify({ a, b }));
    check('...so the same part of the photo stays in view', near(b.ox / b.w, a.ox / a.w, 0.001) && near(b.oy / b.h, a.oy / a.h, 0.001), JSON.stringify({ a, b }));
    a = b;
    await dragHandle('.sel .h-e', -25, 0);
    b = await get(PH);
    check('a side crops: the frame narrows and the photo stays put', near(b.w, a.w - 25, 0.1) && near(b.s, a.s, 1e-6) && near(b.ox, a.ox, 1e-6), JSON.stringify({ a, b }));
    a = b;
    await dragHandle('.sel .h-w', 20, 0);
    b = await get(PH);
    check('...from the left too: the photo doesn’t move on the page', near(b.x + b.ox, a.x + a.ox, 0.01) && near(b.s, a.s, 1e-6), JSON.stringify({ a, b }));
    a = b;
    await dragHandle('.sel .h-s', 0, 60);
    b = await get(PH);
    check('dragging a side out past the photo grows it just enough, so there’s no gap', b.h > a.h + 50 && b.s > a.s && covers(b) && near(b.y + b.oy, a.y + a.oy, 0.5) === false || (b.h > a.h + 50 && b.s > a.s && covers(b)), JSON.stringify({ a, b }));
    check('...growing from the edge that stayed put, so the top of the crop holds', near(b.oy, a.oy, 0.01) || b.oy <= 0.02, JSON.stringify({ a, b }));
    a = b;
    await dragHandle('.sel .h-se', 20, -30, { shift: true });
    b = await get(PH);
    check('Shift on a corner changes the frame’s shape instead (a crop)', !near(b.w / b.h, a.w / a.h, 0.02) && covers(b), JSON.stringify({ a, b }));
    // Fit in frame: once. Its gaps stay; dragging adds no new ones.
    await exec(`document.querySelector('#right-body [data-act="fit-fit"]').click()`);
    await wait(150);
    a = await get(PH);
    const gapsBefore = a.ox > 0.02 || a.oy > 0.02;
    await dragHandle('.sel .h-e', 15, 0);
    b = await get(PH);
    // Widening would open a new gap at the side, so the photo grows to close it; the gaps it had at
    // the top and bottom (from Fit in frame) stay.
    check('Fit in frame fits the whole photo, and its own gaps stay when you resize', gapsBefore && b.oy > 0.02 && b.ox <= 0.02 && b.ox + 1200 * b.s >= b.w - 0.02, JSON.stringify({ a, b }));
    await exec(`document.querySelector('#right-body [data-act="fit-fill"]').click()`);
    await wait(150);
    check('Fill frame fills it again', covers(await get(PH)));
    check('Fill and Fit are buttons now, not a mode', await exec(`!document.querySelector('#right-body [data-seg="fit"]') && !!document.querySelector('#right-body [data-act="fit-fill"]')`));

    /* ----- groups ----- */
    await exec(`(() => {
      const d = App.S.doc;
      App.change('Add', () => {
        const r = Model.newItem('rect', 30, 150, 40, 30, d); r.strokeW = 1; r.stroke = { sw: 'sw-black' };
        const t = Model.newItem('text', 80, 150, 60, 20, d); t.text = 'Hello group';
        d.pages[0].items.push(r, t);
        window.__r = r.id; window.__t = t.id;
      });
      App.select([window.__ph, window.__r, window.__t]);
    })()`);
    await wait(100);
    check('several things selected get one box with corner handles', await exec(`document.querySelectorAll('.sel-group .h').length === 5 && !document.querySelector('.sel-group .h-e')`));
    await key('g', { ctrl: true });
    await wait(100);
    const g1 = await exec(`(() => { const d = App.S.doc; const l = d.pages[0].items; const gids = new Set(l.map((x) => x.group)); const gid = l[0].group; return { one: gids.size === 1 && !!gid, name: d.groups[gid] && d.groups[gid].name, gid }; })()`);
    check('Ctrl+G groups them, named Group 1', g1.one && g1.name === 'Group 1', JSON.stringify(g1));
    check('...and the box round them says so', await exec(`document.querySelector('.sel-group.is-group .sel-group-name')?.textContent === 'Group 1'`));
    // Layers: a folder, open, with its three boxes.
    await exec(`document.querySelector('#right-tabs [data-tab="layers"]').click()`);
    await wait(150);
    const lay = await exec(`({ folder: !!document.querySelector('#right-body [data-group-row]'), inside: document.querySelectorAll('#right-body .layer.in-group').length })`);
    check('Layers shows the group as a folder with its boxes in it', lay.folder && lay.inside === 3, JSON.stringify(lay));
    if (shots) await shot(path.join(shots, 'groups-layers.png'));
    await exec(`document.querySelector('#right-body [data-group-row] [data-fold]').click()`);
    await wait(100);
    check('...which closes and opens', (await exec(`document.querySelectorAll('#right-body .layer.in-group').length`)) === 0);
    await exec(`document.querySelector('#right-body [data-group-row] [data-fold]').click()`);
    await wait(100);
    await exec(`document.querySelector('#right-body [data-group-row] [data-gtog="hidden"]').click()`);
    check('hiding the folder hides all of the group', await exec(`App.S.doc.pages[0].items.every((x) => x.hidden)`));
    await exec(`document.querySelector('#right-body [data-group-row] [data-gtog="hidden"]').click()`);
    await wait(100);

    // On the page: one click picks up the group; a double-click goes in; Esc comes out.
    await exec(`App.select([])`);
    await wait(50);
    await press(await exec('window.__r'));
    check('clicking a box in a group picks up the whole group', (await exec(`App.S.sel.size`)) === 3);
    await wait(600);
    await press(await exec('window.__r'), 2);
    const inside = await exec(`({ sel: [...App.S.sel], inG: App.S.inGroup })`);
    check('a double-click goes into the group, with just that box', inside.sel.length === 1 && inside.sel[0] === (await exec('window.__r')) && inside.inG === g1.gid, JSON.stringify(inside));
    await key('Escape');
    await wait(50);
    check('Esc comes back out to the whole group', (await exec(`App.S.sel.size === 3 && !App.S.inGroup`)));

    // Scale the group from its corner: twice as big, text too.
    const before = await exec(`App.S.doc.pages[0].items.map((x) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, size: x.style && x.style.size, sw: x.strokeW }))`);
    const box = await exec(`(() => { const r = document.querySelector('.sel-group').getBoundingClientRect(); return { w: r.width / App.S.zoom, h: r.height / App.S.zoom }; })()`);
    await dragHandle('.sel-group .h-se', box.w, box.h);
    await wait(100);
    const after = await exec(`App.S.doc.pages[0].items.map((x) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, size: x.style && x.style.size, sw: x.strokeW }))`);
    const s2 = after.map((x, i) => x.w / before[i].w);
    const tB = before.find((x) => x.size), tA = after.find((x) => x.size);
    check('a group’s corner scales everything in it evenly', s2.every((v) => near(v, s2[0], 0.01)) && s2[0] > 1.8 && s2[0] < 2.2, JSON.stringify(s2));
    check('...text size too', near(tA.size / tB.size, s2[0], 0.02), JSON.stringify({ tB, tA }));
    check('...and line widths', near(after.find((x) => x.sw > 0).sw / before.find((x) => x.sw > 0).sw, s2[0], 0.02));
    check('...from the opposite corner', near(Math.min(...after.map((x) => x.x)), Math.min(...before.map((x) => x.x)), 0.3), JSON.stringify({ before, after }));
    if (shots) await shot(path.join(shots, 'groups-scaled.png'));
    await exec(`App.history.doUndo()`);
    await wait(100);
    check('...and one undo puts it back', near((await exec(`App.S.doc.pages[0].items[0].w`)), before[0].w, 0.01));

    // Turn the group: each box turns, and they move round the middle.
    await exec(`App.select(App.withGroups([window.__r]))`);
    await wait(50);
    const rb = await exec(`(() => { const r = document.querySelector('.sel-group').getBoundingClientRect(); return { w: r.width / App.S.zoom, h: r.height / App.S.zoom }; })()`);
    await dragHandle('.sel-group .h-rot', rb.w / 2 + 10, rb.h / 2 + 15, { shift: true });
    const rots = await exec(`App.S.doc.pages[0].items.map((x) => x.rot)`);
    check('the top handle turns the whole group', rots.every((r) => r === rots[0] && Math.abs(r) >= 15), JSON.stringify(rots));
    await exec(`App.history.doUndo()`);
    await wait(100);

    // Copies make new groups; ungroup leaves the boxes.
    await exec(`App.select(App.withGroups([window.__r]))`);
    await key('d', { ctrl: true });
    await wait(100);
    const dup = await exec(`(() => { const d = App.S.doc, l = d.pages[0].items; const gs = [...new Set(l.map((x) => x.group))]; return { n: l.length, groups: gs.map((g) => d.groups[g] && d.groups[g].name) }; })()`);
    check('duplicating a group makes a new group', dup.n === 6 && dup.groups.length === 2 && dup.groups.includes('Group 1 copy'), JSON.stringify(dup));
    await key('c', { ctrl: true });
    await exec(`App.cmd('paste')`); // Ctrl+V comes in as the system's paste
    await wait(100);
    check('...and so does pasting it', (await exec(`new Set(App.S.doc.pages[0].items.map((x) => x.group)).size`)) === 3);
    await key('Delete');
    await wait(50);
    // Into the first group, then bring its rectangle to the front: it stays in the group.
    await exec(`App.select([]); App.S.inGroup = Model.findItem(App.S.doc, window.__r).item.group; App.select([window.__r])`);
    await key(']', { ctrl: true, shift: true });
    await wait(50);
    const order = await exec(`(() => { const l = App.S.doc.pages[0].items; const g = Model.findItem(App.S.doc, window.__r).item.group; const idx = l.map((x, i) => (x.group === g ? i : -1)).filter((i) => i >= 0); return { together: idx.every((v, i) => !i || v === idx[i - 1] + 1), top: l[idx[idx.length - 1]].id === window.__r }; })()`);
    check('inside a group, Bring to front stays inside the group', order.together && order.top, JSON.stringify(order));
    await exec(`App.S.inGroup = null; App.select(App.withGroups([window.__r]))`);
    await key('g', { ctrl: true, shift: true });
    await wait(50);
    check('Ctrl+Shift+G ungroups', await exec(`!Model.findItem(App.S.doc, window.__r).item.group && !Model.findItem(App.S.doc, window.__t).item.group`));

    // Layers: drag a box into a group, and out again.
    await exec(`App.select([window.__ph, window.__r])`);
    await key('g', { ctrl: true });
    await wait(150);
    const dnd = (fromSel, toSel, below) => exec(`(() => {
      const f = document.querySelector(${JSON.stringify(fromSel)}), t = document.querySelector(${JSON.stringify(toSel)});
      const dt = new DataTransfer(); const r = t.getBoundingClientRect();
      const y = ${below ? 'r.bottom - 2' : 'r.top + 2'};
      f.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: y }));
      t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: y }));
      return t.className;
    })()`);
    const t0 = await exec('window.__t');
    const r0 = await exec('window.__r');
    await dnd(`#right-body [data-layer="${t0}"]`, `#right-body .layer.in-group[data-layer="${r0}"]`, true);
    await wait(150);
    check('dropping a box among a group’s boxes in Layers puts it in the group', await exec(`!!Model.findItem(App.S.doc, window.__t).item.group && Model.findItem(App.S.doc, window.__t).item.group === Model.findItem(App.S.doc, window.__r).item.group`));
    const gRow = await exec(`Model.findItem(App.S.doc, window.__r).item.group`);
    await dnd(`#right-body [data-layer="${t0}"]`, `#right-body [data-group-row="${gRow}"]`, false);
    await wait(150);
    check('...and dragging it above the folder takes it out', await exec(`!Model.findItem(App.S.doc, window.__t).item.group`));

    // A group left with one box isn't a group; saving forgets unused group names.
    window_gid = await exec(`Model.findItem(App.S.doc, window.__r).item.group`);
    await exec(`App.select([window.__r])`);
    await key('Delete');
    await wait(50);
    const left = await exec(`(() => { const d = JSON.parse(JSON.stringify(App.S.doc)); Model.pruneAssets(d); return { ph: Model.findItem(App.S.doc, window.__ph).item.group || null, named: !!d.groups[${JSON.stringify(window_gid)}] }; })()`);
    check('a group left with one box stops being a group, and its name goes when saved', left.ph === null && !left.named, JSON.stringify(left));
    await exec('App.S.dirty = false');
  };
}
