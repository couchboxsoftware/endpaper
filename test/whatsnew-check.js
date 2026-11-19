// What's new: every CHANGELOG.md entry follows the template at the top of the file; Settings,
// App shows the versions with New, Improved and Fixed in their colours and "You have this" on
// the installed one; and the What's new card shows once after an update (not again, and not on a
// brand-new install).
// Run: node test/whatsnew-check.js
const path = require('path');
const fs = require('fs');
const H = require('./helper');

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const GROUP_ORDER = ['New', 'Improved', 'Fixed'];
const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

// Everything in CHANGELOG.md that breaks the template. [] when it's all right.
function problems(text) {
  const out = [];
  if (!/^<!--[\s\S]*## 1\.2\.3 · 15 Nov 2026[\s\S]*-->/.test(text)) out.push('the template comment is missing from the top');
  const body = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  const parts = body.split(/^(?=## )/m).filter((p) => p.trim());
  let prev = null;
  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    const m = lines[0].match(new RegExp(`^## (\\d+\\.\\d+\\.\\d+) · (\\d{1,2}) (${MONTHS}) (\\d{4})$`));
    if (!m) {
      out.push(`bad heading: "${lines[0]}"`);
      continue;
    }
    const v = m[1];
    if (prev && cmp(prev, v) <= 0) out.push(`${v} isn't older than ${prev} above it`);
    prev = v;
    const rest = lines.slice(1).filter((l) => l.trim());
    const headline = rest[0] || '';
    if (!headline || /^[#-]/.test(headline)) out.push(`${v}: no headline sentence`);
    else if (!/\.$/.test(headline)) out.push(`${v}: the headline should end with a full stop`);
    let last = -1;
    let group = null;
    let count = 0;
    for (const l of rest.slice(1)) {
      const g = l.match(/^### (.+)$/);
      if (g) {
        if (group && !count) out.push(`${v}: ${group} has no items`);
        const i = GROUP_ORDER.indexOf(g[1]);
        if (i < 0) out.push(`${v}: "${g[1]}" isn't New, Improved or Fixed`);
        else if (i <= last) out.push(`${v}: ${g[1]} is out of order (New, Improved, Fixed)`);
        last = i;
        group = g[1];
        count = 0;
      } else if (/^- \S/.test(l)) {
        if (!group) out.push(`${v}: an item before any group`);
        count++;
        if (/`/.test(l) || /\b[\w-]+\.(js|json|md|html|css|yml|cmd|ps1)\b/i.test(l)) out.push(`${v}: code or a file name in "${l.slice(2, 50)}…"`);
      } else out.push(`${v}: a line that isn't part of the template: "${l.slice(0, 60)}"`);
    }
    if (group && !count) out.push(`${v}: ${group} has no items`);
    if (last < 0) out.push(`${v}: no New, Improved or Fixed group`);
  }
  return out;
}

if (require.main === module) {
  (async () => {
    const { check, tally } = H.runnerCheck();
    const text = fs.readFileSync(path.join(H.ROOT, 'CHANGELOG.md'), 'utf8');
    const found = problems(text);
    check('every CHANGELOG entry follows the template', found.length === 0, found.join(' | '));
    // Plant two mistakes in the real entries (after the template comment) and make sure both are caught.
    const cut = text.indexOf('-->') + 3;
    const bad = problems(text.slice(0, cut) + text.slice(cut).replace(/^(## \d+\.\d+\.\d+ · .+\r?\n)(.+?)\.(\r?\n)/m, '$1$2$3').replace(/### Fixed/, '### Repaired'));
    check('...and the check catches mistakes (a headline without a full stop, an unknown group)', bad.length >= 2, bad.join(' | '));
    const current = require('../package.json').version;
    const versions = [...text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/^## (\S+) · /gm)].map((m) => m[1]);
    check(`it has an entry for this version (${current})`, versions.includes(current));
    const previous = versions[versions.indexOf(current) + 1] || '0.0.0';

    // Just updated from the version before: the card shows, once.
    const updated = H.tempUserData('whatsnew', { lastSeenVersion: previous });
    const r1 = await H.launch(__filename, { userData: updated, env: { ENDPAPER_CHECK: 'updated', ENDPAPER_PREVIOUS: previous }, label: '[after an update]' });
    const r2 = await H.launch(__filename, { userData: updated, env: { ENDPAPER_CHECK: 'again' }, label: '[opened again]' });
    // A brand-new install: no card.
    const r3 = await H.launch(__filename, { userData: H.tempUserData('whatsnew-new'), env: { ENDPAPER_CHECK: 'fresh' }, label: '[new install]' });
    H.finish('whatsnew-check', [r1, r2, r3], tally);
  })();
} else {
  module.exports = async ({ exec }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    const { app } = require('electron');
    await appReady();
    const phase = process.env.ENDPAPER_CHECK;
    const current = require('../package.json').version;
    const saved = () => JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    const colour = (sel) => exec(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el).color : null; })()`);

    if (phase !== 'updated') {
      await wait(1500);
      check(phase === 'fresh' ? 'no What\'s new card on a brand-new install' : 'the card doesn\'t show a second time', !(await exec(`!!document.getElementById('wn-card')`)));
      if (phase === 'fresh') check('...and it won\'t show later either', saved().lastSeenVersion === current);
      return;
    }

    check(`after updating from ${process.env.ENDPAPER_PREVIOUS}: the "What's new in ${current}" card`, await waitFor(() => exec(`!!document.getElementById('wn-card') && document.getElementById('wn-card').textContent.includes("What's new in ${current}")`), 8000));
    check('...in the bottom-left corner', await exec(`(() => { const r = document.getElementById('wn-card').getBoundingClientRect(); return r.left < innerWidth / 3 && r.bottom > innerHeight * 2 / 3; })()`));
    const cardTitles = await exec(`[...document.querySelectorAll('#wn-card .wn-grp')].map(g => g.textContent + ':' + getComputedStyle(g).color + ':' + getComputedStyle(g).textTransform)`);
    check('...with coloured, capitalised group titles', cardTitles.length > 0 && cardTitles.every((t) => /uppercase$/.test(t)), cardTitles.join(', '));
    await exec(`document.querySelector('#wn-card [data-wn="all"]').click()`);
    check('See all versions opens Settings, App at What\'s new', await waitFor(() => exec(`!document.getElementById('wn-card') && !!document.querySelector('#settings-whatsnew .wn-ver') && document.querySelector('[data-stabs] .on').dataset.t === 'app'`), 5000));
    check('...the newest three, with "You have this" on this one', await exec(`(() => { const v = [...document.querySelectorAll('#settings-whatsnew .wn-ver')]; const tagged = v.filter(x => x.querySelector('.wn-you')); return v.length === 3 && tagged.length === 1 && tagged[0].querySelector('.wn-num').textContent === '${current}' && tagged[0].querySelector('.wn-you').textContent === 'You have this'; })()`));
    await exec(`document.querySelector('#settings-whatsnew [data-wn="more"]').click()`);
    await wait(200);
    const all = (fs.readFileSync(path.join(H.ROOT, 'CHANGELOG.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').match(/^## /gm) || []).length;
    check('Show older versions lists them all', (await exec(`document.querySelectorAll('#settings-whatsnew .wn-ver').length`)) === all);
    // The colours are the family's: New green, Improved blue, Fixed amber, in that order.
    const want = { new: 'rgb(127, 210, 154)', imp: 'rgb(140, 184, 240)', fix: 'rgb(240, 180, 106)' };
    for (const [cls, rgb] of Object.entries(want)) {
      const got = await colour(`#settings-whatsnew .wn-grp.${cls}`);
      check(`${{ new: 'New', imp: 'Improved', fix: 'Fixed' }[cls]} is ${rgb}`, got === rgb, String(got));
    }
    const order = await exec(`[...document.querySelectorAll('#settings-whatsnew .wn-ver')].every(v => { const g = [...v.querySelectorAll('.wn-grp')].map(x => ['new', 'imp', 'fix'].findIndex(c => x.classList.contains(c))); return g.every((x, i) => i === 0 || x > g[i - 1]); })`);
    check('...always in the order New, Improved, Fixed', order);
    check('closing the card counts as seen', saved().lastSeenVersion === current);
  };
}
module.exports.problems = problems;
