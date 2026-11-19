// Settings: one window with tabs along the top; each tab holds its own settings; a change is
// saved straight away (to settings.json); Settings reopens on the tab used last, also after
// Endpaper is closed and opened again; and a new install opens maximised.
// Run: node test/settings-check.js
const path = require('path');
const fs = require('fs');
const H = require('./helper');

// What each tab must hold, by the controls' data attributes.
const TABS = {
  general: ['[data-sset="units"]', '[data-sn="bleed"]', '[data-sc="snap"]', '[data-sc="showGuides"]', '[data-ss="openMode"]'],
  colour: ['[data-ss="profile"]', '[data-act="add-profile"]', '[data-ss="intent"]'],
  export: ['[data-sc="cropMarks"]', '[data-sn="imageQuality"]'],
  hints: ['.hints-section .hint-row', '[data-hints-reset-all]'],
  app: ['.up-section', '#settings-whatsnew'],
};

if (require.main === module) {
  (async () => {
    const userData = H.tempUserData('settings');
    const r1 = await H.launch(__filename, { userData, env: { ENDPAPER_CHECK: 'change' }, label: '[first run]' });
    const r2 = await H.launch(__filename, { userData, env: { ENDPAPER_CHECK: 'reopen' }, label: '[opened again]' });
    H.finish('settings-check', [r1, r2]);
  })();
} else {
  module.exports = async ({ win, exec }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    const { app } = require('electron');
    await appReady();
    const saved = () => JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    const ctrlComma = async () => {
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ',', modifiers: ['control'] });
      return waitFor(() => exec(`!!document.querySelector('.modal.settings')`), 3000);
    };
    const tab = (t) => exec(`document.querySelector('.modal.settings [data-t="${t}"]').click()`);
    const shown = () => exec(`document.querySelector('.modal.settings [data-stabs] .on')?.dataset.t`);
    const closeSettings = () => exec(`document.querySelector('.modal.settings .modal-x').click()`);

    if (process.env.ENDPAPER_CHECK === 'reopen') {
      const s = saved();
      check('the changes are still there after opening again', s.units === 'cm' && s.bleed === 5 && s.snap === false && s.intent === 'perceptual' && s.imageQuality === 80, JSON.stringify({ units: s.units, bleed: s.bleed, snap: s.snap, intent: s.intent, imageQuality: s.imageQuality }));
      await ctrlComma();
      check('Settings opens on the tab used last (Export)', (await shown()) === 'export', await shown());
      check('...with the saved values in it', await exec(`document.querySelector('[data-sn="imageQuality"]').value === '80'`));
      return;
    }

    const s0 = await exec('ep.settings.get()');
    check('a new install opens maximised', s0.openMode === 'maximised', s0.openMode);
    check('Ctrl+, opens Settings', await ctrlComma());
    const tabs = await exec(`[...document.querySelectorAll('.modal.settings [data-stabs] [data-t]')].map(b => b.dataset.t)`);
    check('the tabs along the top: General, Colour, Export, Hints, App', JSON.stringify(tabs) === JSON.stringify(Object.keys(TABS)), tabs.join(', '));
    for (const [t, sels] of Object.entries(TABS)) {
      await tab(t);
      await wait(150);
      const missing = await exec(`${JSON.stringify(sels)}.filter(s => { const el = document.querySelector('.modal.settings .stab[data-tab="${t}"] ' + s); return !el; })`);
      const only = await exec(`[...document.querySelectorAll('.modal.settings .stab')].filter(s => !s.hidden).map(s => s.dataset.tab).join()`);
      check(`${t[0].toUpperCase() + t.slice(1)} holds its settings`, missing.length === 0 && only === t, missing.length ? 'missing ' + missing.join(', ') : 'showing ' + only);
    }
    check('App says who makes it, and the version', await exec(`(() => { const t = document.querySelector('.stab[data-tab="app"]').innerText; return /Made by Couchbox Software/.test(t) && t.includes(App.S.version); })()`));

    // Change something on each tab; each one is saved straight away.
    await tab('general');
    await exec(`document.querySelector('[data-sset="units"] [data-v="cm"]').click()`);
    await exec(`(() => { const el = document.querySelector('[data-sn="bleed"]'); el.value = '5'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await exec(`(() => { const el = document.querySelector('[data-sc="snap"]'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await tab('colour');
    await exec(`(() => { const el = document.querySelector('[data-ss="intent"]'); el.value = 'perceptual'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await tab('export');
    await exec(`(() => { const el = document.querySelector('[data-sn="imageQuality"]'); el.value = '80'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(400);
    const s = saved();
    check('General: units and bleed are saved', s.units === 'cm' && s.bleed === 5, `${s.units}, ${s.bleed}`);
    check('General: snapping off is saved', s.snap === false);
    check('Colour: how photos convert is saved', s.intent === 'perceptual', s.intent);
    check('Export: photo quality is saved', s.imageQuality === 80, s.imageQuality);
    check('the units change at once in the status bar', await exec(`document.querySelector('#units .on')?.dataset.v === 'cm' || App.unit() === 'cm'`));

    // Close and reopen: back on the last tab.
    await closeSettings();
    await wait(200);
    await ctrlComma();
    check('Settings reopens on the tab used last', (await shown()) === 'export', await shown());
    await closeSettings();
  };
}
