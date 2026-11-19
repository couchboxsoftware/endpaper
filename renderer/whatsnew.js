/* What's new: every version and what it brought (from CHANGELOG.md), in Settings, App, and a
   card in the bottom-left corner once after an update. New, Improved and Fixed always show as
   coloured titles (green, blue, amber), the same in every Couchbox Software app.
   Ported from Couchbox's renderer/whatsnew.js. */
const WhatsNew = (() => {
  let entries = null;
  let showAll = false;
  const GROUPS = [['New', 'new'], ['Improved', 'imp'], ['Fixed', 'fix']];
  const CARD_ITEMS = 4; // in the card, like Couchbox; the rest are in Settings, App

  async function load() {
    if (!entries) entries = await ep.changelog.get();
    return entries;
  }
  const itemsOf = (e, name) => (e.groups.find((g) => g.name === name) || { items: [] }).items;

  // The groups as coloured titles with their lists. max caps how many items show in all (the card
  // keeps to a few, then says how many more there are).
  function groupsHTML(e, max = Infinity) {
    let left = max;
    let hidden = 0;
    const html = GROUPS.filter(([g]) => itemsOf(e, g).length)
      .map(([g, cls]) => {
        const items = itemsOf(e, g);
        const shown = items.slice(0, Math.max(0, left));
        left -= shown.length;
        hidden += items.length - shown.length;
        return shown.length ? `<div class="wn-grp ${cls}">${g}</div><ul>${shown.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
      })
      .join('');
    return html + (hidden ? `<div class="wn-card-more">and ${hidden} more</div>` : '');
  }

  function entryHTML(e) {
    return `<div class="wn-ver"><div class="wn-head"><span class="wn-num">${esc(e.version)}</span><span class="wn-date">${esc(e.date)}</span>${e.version === App.S.version ? '<span class="wn-you">You have this</span>' : ''}</div>
      <div class="wn-line">${esc(e.headline)}</div>${groupsHTML(e)}</div>`;
  }

  // Settings, App: the newest three, then the rest on request.
  async function renderSettings() {
    const box = document.getElementById('settings-whatsnew');
    if (!box) return;
    const all = await load();
    const list = showAll ? all : all.slice(0, 3);
    const older = all.slice(3);
    box.innerHTML =
      list.map(entryHTML).join('') +
      (older.length ? `<button class="btn btn-sm btn-ghost wn-more" data-wn="more">${showAll ? 'Show fewer' : `Show older versions (${older[0].version} to ${older[older.length - 1].version})`}</button>` : '');
  }

  // After an update: a card with that version's headline and what it brought, once.
  async function maybeShowCard(version) {
    if (!version || document.getElementById('wn-card')) return;
    const e = (await load()).find((x) => x.version === version);
    if (!e) return seen();
    const el = document.createElement('div');
    el.id = 'wn-card';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `What's new in ${e.version}`);
    el.innerHTML = `<div class="wn-card-title">What's new in ${esc(e.version)}</div>
      <div class="wn-card-head">${esc(e.headline)}</div>
      <div class="wn-card-body">${groupsHTML(e, CARD_ITEMS)}</div>
      <div class="wn-card-btns"><button class="btn btn-sm btn-accent" data-wn="all">See all versions</button><button class="btn btn-sm btn-ghost" data-wn="ok">Got it</button></div>`;
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-wn]');
      if (b) act(b.dataset.wn);
    });
    document.body.appendChild(el);
  }

  function seen() {
    ep.changelog.seen();
  }
  function closeCard() {
    const card = document.getElementById('wn-card');
    if (!card) return;
    card.remove();
    seen();
  }

  // Settings, App, scrolled to What's new.
  async function openInSettings() {
    await App.openSettings('app');
    setTimeout(() => document.getElementById('settings-whatsnew')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
  }

  function act(a) {
    if (a === 'more') {
      showAll = !showAll;
      renderSettings();
    } else if (a === 'ok') closeCard();
    else if (a === 'all') {
      closeCard();
      openInSettings();
    } else return false;
    return true;
  }

  return { renderSettings, maybeShowCard, openInSettings, act, GROUPS };
})();
