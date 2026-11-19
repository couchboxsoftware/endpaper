/* The menu bar along the top of the window (File, Edit, View…), drawn in the title bar like
   most Windows apps. It works with the mouse and the keyboard: Alt+F opens File, Alt on its own
   highlights the bar, the arrow keys move, Enter chooses, Esc closes. Shortcuts shown on the
   right are handled by app.js; the menu only shows them.

   Menu.init(provider): provider() returns the menus, built fresh each time one opens so
   disabled and ticked items are always current:
     [{ title: '&File', items: [{ label: '&Save', key: 'Ctrl+S', run, disabled, checked, items }, '-'] }]
   An "&" marks the letter used with Alt. "items" makes a submenu (an array, or a function
   returning one, which may be async). */
const Menu = (() => {
  let provider = () => [];
  let bar, titles, menus = [];
  let open = -1; // index of the open menu, -1 for none
  let focusBar = -1; // Alt pressed on its own: this title is highlighted, nothing open
  let stack = []; // open dropdowns: [{ el, items, hi }]
  let altDown = false;
  let altUsed = false;

  const plain = (s) => s.replace(/&(.)/g, '$1');
  const mnemonic = (s) => (/&(.)/.exec(s) || [])[1]?.toLowerCase();
  const withKey = (s) => esc(s).replace(/&amp;(.)/, '<u>$1</u>');

  function init(p) {
    provider = p;
    bar = document.getElementById('menubar');
    bar.innerHTML = `<div class="mb-brand">${BRAND.icon}</div><nav class="mb-titles" role="menubar"></nav><div class="mb-title-text"></div><span class="mb-test" title="Running from the source folder, with its own settings">Test version</span><div class="mb-controls-space"></div>`;
    titles = bar.querySelector('.mb-titles');
    paintTitles();
    titles.addEventListener('pointerdown', (e) => {
      const t = e.target.closest('[data-m]');
      if (!t) return;
      e.preventDefault();
      const i = +t.dataset.m;
      if (open === i) close();
      else openMenu(i);
    });
    // With a menu open, moving the mouse along the bar opens the menu under it. Only real
    // movement counts, so a mouse resting on a title doesn't fight the keyboard.
    let lastXY = '';
    titles.addEventListener('pointermove', (e) => {
      const xy = e.clientX + ',' + e.clientY;
      if (xy === lastXY) return;
      lastXY = xy;
      const t = e.target.closest('[data-m]');
      if (t && open >= 0 && +t.dataset.m !== open) openMenu(+t.dataset.m);
    });
    document.addEventListener('pointerdown', (e) => {
      if (open < 0 && focusBar < 0) return;
      if (!e.target.closest('#menubar') && !e.target.closest('.mb-drop')) close();
    }, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', () => {
      altDown = false;
      document.body.classList.remove('alt-keys');
      close();
    });
    window.addEventListener('resize', () => open >= 0 && close());
    // The window's title (design name and whether it's saved) sits in the middle of the bar.
    const showTitle = () => (bar.querySelector('.mb-title-text').textContent = document.title);
    new MutationObserver(showTitle).observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true });
    showTitle();
  }

  // The titles are built once; after that only their highlight changes.
  function paintTitles() {
    menus = provider();
    const key = menus.map((m) => m.title).join('|');
    if (titles.dataset.key !== key) {
      titles.dataset.key = key;
      titles.innerHTML = menus.map((m, i) => `<button class="mb-t" data-m="${i}" role="menuitem" tabindex="-1">${withKey(m.title)}</button>`).join('');
    }
    titles.querySelectorAll('[data-m]').forEach((b) => {
      const i = +b.dataset.m;
      b.classList.toggle('open', open === i);
      b.classList.toggle('focus', focusBar === i);
      b.setAttribute('aria-expanded', open === i ? 'true' : 'false');
    });
  }

  /* ---------- opening and closing ---------- */
  function openMenu(i) {
    closeDrops();
    focusBar = -1;
    open = i;
    paintTitles();
    const t = titles.querySelector(`[data-m="${i}"]`);
    const r = t.getBoundingClientRect();
    drop(menus[i].items, r.left, r.bottom);
  }
  function close() {
    closeDrops();
    open = -1;
    focusBar = -1;
    document.body.classList.remove('alt-keys');
    if (titles) paintTitles();
  }
  function closeDrops(from = 0) {
    for (const d of stack.splice(from)) d.el.remove();
  }

  async function drop(items, x, y, parentRow) {
    if (typeof items === 'function') items = await items();
    items = items || [];
    const el = document.createElement('div');
    el.className = 'mb-drop';
    el.setAttribute('role', 'menu');
    el.innerHTML = items.length
      ? items
          .map((it, i) =>
            it === '-'
              ? '<hr>'
              : `<button data-i="${i}" role="menuitem" ${it.disabled ? 'disabled aria-disabled="true"' : ''}>
                  <i class="mb-check">${it.checked ? '✓' : ''}</i><span>${withKey(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}${it.items ? '<b class="mb-arrow">›</b>' : ''}</button>`
          )
          .join('')
      : '<div class="mb-empty">Nothing here yet</div>';
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    if (parentRow) {
      const pr = parentRow.getBoundingClientRect();
      x = pr.right + r.width > innerWidth - 4 ? pr.left - r.width + 2 : pr.right - 2;
      y = Math.min(pr.top - 5, innerHeight - r.height - 6);
    }
    el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    el.style.top = Math.max(4, y) + 'px';
    const level = { el, items, hi: -1 };
    stack.push(level);
    el.addEventListener('pointerover', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const lv = stack.indexOf(level);
      highlight(level, +b.dataset.i);
      closeDrops(lv + 1);
      const it = items[+b.dataset.i];
      if (it.items && !it.disabled) drop(it.items, 0, 0, b);
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) choose(level, +b.dataset.i);
    });
    return level;
  }

  function highlight(level, i) {
    level.hi = i;
    level.el.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('hi', +b.dataset.i === i));
    level.el.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  async function choose(level, i) {
    const it = level.items[i];
    if (!it || it === '-' || it.disabled) return;
    if (it.items) {
      closeDrops(stack.indexOf(level) + 1);
      const row = level.el.querySelector(`[data-i="${i}"]`);
      const sub = await drop(it.items, 0, 0, row);
      move(sub, 1);
      return;
    }
    close();
    try {
      await it.run();
    } catch (e) {
      console.error(e);
    }
  }
  // Next or previous item that can be chosen.
  function move(level, dir) {
    const n = level.items.length;
    if (!n) return;
    let i = level.hi;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      const it = level.items[i];
      if (it !== '-' && !it.disabled) return highlight(level, i);
    }
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if (e.key === 'Alt') {
      altDown = true;
      altUsed = false;
      document.body.classList.add('alt-keys');
      return;
    }
    if (altDown) altUsed = true;
    // Alt+letter opens that menu (unless a dialog is open).
    if (e.altKey && !e.ctrlKey && e.key.length === 1 && !document.querySelector('.modal-overlay')) {
      const i = menus.findIndex((m) => mnemonic(m.title) === e.key.toLowerCase());
      if (i >= 0) {
        e.preventDefault();
        e.stopPropagation();
        openMenu(i);
        const lv = stack[0];
        if (lv) move(lv, 1);
        else setTimeout(() => stack[0] && move(stack[0], 1), 0);
        return;
      }
    }
    if (open < 0 && focusBar < 0) return;
    // While the menus have the keyboard, nothing else gets it.
    e.preventDefault();
    e.stopPropagation();
    const k = e.key;
    if (focusBar >= 0) {
      if (k === 'ArrowRight' || k === 'ArrowLeft') {
        focusBar = (focusBar + (k === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length;
        return paintTitles();
      }
      if (k === 'ArrowDown' || k === 'Enter' || k === ' ') {
        const i = focusBar;
        openMenu(i);
        return setTimeout(() => stack[0] && move(stack[0], 1), 0);
      }
      if (k === 'Escape') return close();
      const i = menus.findIndex((m) => mnemonic(m.title) === k.toLowerCase());
      if (i >= 0) {
        openMenu(i);
        return setTimeout(() => stack[0] && move(stack[0], 1), 0);
      }
      return;
    }
    const level = stack[stack.length - 1];
    if (!level) return;
    if (k === 'ArrowDown') return move(level, 1);
    if (k === 'ArrowUp') return move(level, -1);
    if (k === 'Enter' || k === ' ') return choose(level, level.hi);
    if (k === 'ArrowRight') {
      const it = level.items[level.hi];
      if (it && it.items && !it.disabled) return choose(level, level.hi);
      return openMenu((open + 1) % menus.length), setTimeout(() => stack[0] && move(stack[0], 1), 0);
    }
    if (k === 'ArrowLeft') {
      if (stack.length > 1) return closeDrops(stack.length - 1);
      return openMenu((open - 1 + menus.length) % menus.length), setTimeout(() => stack[0] && move(stack[0], 1), 0);
    }
    if (k === 'Escape') {
      if (stack.length > 1) return closeDrops(stack.length - 1);
      const i = open;
      close();
      focusBar = i;
      return paintTitles();
    }
    if (k.length === 1) {
      const i = level.items.findIndex((it) => it !== '-' && !it.disabled && (mnemonic(it.label) || plain(it.label)[0].toLowerCase()) === k.toLowerCase());
      if (i >= 0) choose(level, i);
    }
  }
  function onKeyUp(e) {
    if (e.key !== 'Alt') return;
    const tapped = altDown && !altUsed;
    altDown = false;
    if (!tapped) {
      if (open < 0 && focusBar < 0) document.body.classList.remove('alt-keys');
      return;
    }
    // Alt pressed and let go on its own: highlight the bar, the Windows way. Again to leave it.
    e.preventDefault();
    if (open >= 0 || focusBar >= 0) return close();
    if (document.querySelector('.modal-overlay')) return document.body.classList.remove('alt-keys');
    focusBar = 0;
    paintTitles();
  }

  return { init, close, refresh: () => titles && paintTitles() };
})();
