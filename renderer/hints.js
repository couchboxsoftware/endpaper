/* Hint pop-ups: short tips shown the first time you do something that needs explaining.
   Every hint is listed here, so they can all be found and reset in Settings, Hints. A hint you
   tick "Don't show this again" on is remembered in settings (hintsOff: { id: when }).

   Adding a hint: give it an id, a title and the text below, then call Hints.show('id'). */
const Hints = (() => {
  const LIST = {
    'master-override': {
      title: 'Edit a master item on this page',
      text: "This box comes from the page's master, so it's locked here. To change it on this page only, hold Ctrl and Shift and click it. Other pages keep the master's version.",
      where: 'Double-clicking something from a master on a page',
    },
    // Shown as its own window (renderer/inkdesktop.js), but turned off and on like any hint.
    'try-inkdesktop': {
      title: 'Try Inkdesktop',
      text: "Before a PDF opens after export, Endpaper suggests Inkdesktop, our PDF app, while it isn't installed.",
      where: "Opening a PDF after export, when Inkdesktop isn't installed",
    },
  };

  const off = () => (App.S.settings && App.S.settings.hintsOff) || {};
  const isOff = (id) => !!off()[id];
  async function save(hintsOff) {
    App.S.settings = await ep.settings.set({ hintsOff });
  }

  // Shows a hint unless it's been turned off. Resolves when it's closed.
  function show(id) {
    const h = LIST[id];
    if (!h || isOff(id) || document.querySelector('.modal.hint-pop')) return Promise.resolve();
    return new Promise((resolve) => {
      const m = openModal({
        title: h.title,
        cls: 'hint-pop',
        body: `<p>${esc(h.text)}</p>
          <div class="modal-actions hint-actions"><label class="switch"><input type="checkbox" data-hint-off><span>Don't show this again</span></label><button class="btn btn-accent" data-a="ok">OK</button></div>`,
        onClose: async () => {
          if (m.el.querySelector('[data-hint-off]').checked) await save({ ...off(), [id]: Date.now() });
          resolve();
        },
      });
      m.el.querySelector('[data-a="ok"]').addEventListener('click', () => m.close());
      setTimeout(() => m.el.querySelector('[data-a="ok"]').focus(), 0);
    });
  }

  async function reset(id) {
    const next = { ...off() };
    delete next[id];
    await save(next);
  }
  const resetAll = () => save({});
  const turnOff = (id) => save({ ...off(), [id]: Date.now() });

  /* ---------- Settings, Hints ---------- */
  function settingsHtml() {
    const ids = Object.keys(LIST);
    const hidden = ids.filter(isOff).length;
    return `<h5>Hints</h5>
      <p class="hint">Tips that pop up the first time you do something. Ones you've turned off can be shown again here.</p>
      <div class="hint-list">${ids
        .map((id) => {
          const h = LIST[id];
          const when = off()[id];
          return `<div class="hint-row"><div><b>${esc(h.title)}</b><span class="muted">${esc(h.where)}</span></div>
            ${when ? `<span class="muted">Turned off ${typeof when === 'number' ? timeAgo(when) : ''}</span><button class="btn btn-sm" data-hint-reset="${id}">Show again</button>` : '<span class="muted">Showing</span><span></span>'}</div>`;
        })
        .join('')}</div>
      <div class="btn-row"><button class="btn btn-sm" data-hints-reset-all ${hidden ? '' : 'disabled'}>Show all hints again</button></div>`;
  }

  return { LIST, show, isOff, turnOff, reset, resetAll, settingsHtml };
})();
