/* In-app updates: the "Update available" banner, the Updates section in Settings (App), and
   saving the open design before an update installs. The main process (src/main/updater.js)
   does the checking and downloading. */
const Updates = (() => {
  let st = { status: 'off' };
  let dismissed = null; // version the user said "Later" to (until next launch)
  const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

  function banner() {
    let el = document.getElementById('update-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'update-banner';
      el.hidden = true;
      document.body.appendChild(el);
      el.addEventListener('click', onClick);
    }
    return el;
  }

  function render() {
    const el = banner();
    const show = (st.status === 'available' && st.version !== dismissed) || ['downloading', 'saving', 'waiting', 'ready'].includes(st.status) || (st.status === 'error' && st.version);
    el.hidden = !show;
    if (!show) return;
    const name = App.S.doc ? App.S.doc.name : '';
    let body;
    if (st.status === 'available') {
      body = `<div class="ub-title"><span class="ub-icon">${arrow}</span>Update available: Endpaper ${esc(st.version)}</div>
        ${st.notes ? `<div class="ub-notes">${esc(st.notes)}</div>` : ''}
        <div class="ub-actions"><button class="btn btn-sm btn-accent" data-ub="now">Update now</button><button class="btn btn-sm btn-ghost" data-ub="later">Later</button><button class="btn btn-sm btn-ghost" data-ub="notes">All release notes</button></div>
        ${App.S.dirty ? `<div class="ub-small">You'll be asked to save “${esc(name)}” first. It opens again after the update.</div>` : App.S.filePath ? `<div class="ub-small">“${esc(name)}” opens again after the update.</div>` : ''}`;
    } else if (st.status === 'downloading') {
      body = `<div class="ub-title"><span class="ub-icon">${arrow}</span>Downloading Endpaper ${esc(st.version)}…</div>
        <div class="ub-progress"><div class="ub-bar"><i style="width:${st.percent || 0}%"></i></div><span>${st.percent || 0}%</span></div>
        <div class="ub-small">Keep working. You'll be asked to save before it restarts.</div>`;
    } else if (st.status === 'saving') {
      body = `<div class="ub-title"><span class="ub-icon">${arrow}</span>Getting ready to update…</div>`;
    } else if (st.status === 'waiting') {
      body = `<div class="ub-title"><span class="ub-icon">${arrow}</span>Endpaper ${esc(st.version)} is ready</div>
        <div class="ub-small">Save “${esc(name)}” to finish updating. It opens again where you were.</div>
        <div class="ub-actions"><button class="btn btn-sm btn-accent" data-ub="install">Save and update</button></div>`;
    } else if (st.status === 'ready') {
      body = `<div class="ub-title"><span class="ub-icon">${arrow}</span>Restarting to update…</div>
        <div class="ub-progress"><div class="ub-bar"><i style="width:100%"></i></div><span>100%</span></div>`;
    } else {
      body = `<div class="ub-title"><span class="ub-icon ub-err">!</span>The update didn't download</div>
        <div class="ub-small" title="${esc(st.error || '')}">Check your internet connection and try again.</div>
        <div class="ub-actions"><button class="btn btn-sm btn-accent" data-ub="now">Try again</button><button class="btn btn-sm btn-ghost" data-ub="later">Later</button></div>`;
    }
    el.innerHTML = body;
    renderSettings();
  }

  async function onClick(e) {
    const b = e.target.closest('[data-ub]');
    if (!b) return;
    const a = b.dataset.ub;
    if (a === 'later') {
      dismissed = st.version;
      if (st.status === 'error') st.status = 'available';
      return render();
    }
    if (a === 'notes') return ep.update.releases();
    if (a === 'now') return set(await ep.update.download());
    if (a === 'install') return set(await ep.update.install());
  }
  const set = (s) => {
    if (s) st = s;
    render();
  };

  // Asked by the main process once the update has downloaded.
  async function prepare() {
    const S = App.S;
    if (!S.doc) return { ok: true, files: [] };
    if (Text.active) Text.finish();
    if (S.dirty) {
      const yes = await ask(`Save “${S.doc.name}” before updating?`, {
        detail: "It has changes that aren't saved. Endpaper saves it, updates, then opens it again on the page you're on.",
        ok: 'Save and update',
        cancel: 'Not now',
      });
      if (!yes) return { ok: false };
      if (!(await App.save())) return { ok: false };
    }
    return { ok: true, files: S.filePath ? [{ path: S.filePath, surface: { ...S.surface } }] : [] };
  }

  /* ---------- Settings, App: Updates ---------- */
  const settingsHtml = () => {
    const line =
      st.status === 'off'
        ? 'Updates are checked in the installed app (not when running from the source folder).'
        : st.status === 'checking'
          ? 'Checking…'
          : st.status === 'latest'
            ? `You have the latest version.${st.lastChecked ? ` Checked ${timeAgo(st.lastChecked)}.` : ''}`
            : st.status === 'available'
              ? `Endpaper ${esc(st.version)} is available.`
              : st.status === 'downloading'
                ? `Downloading ${esc(st.version)}… ${st.percent || 0}%`
                : st.status === 'waiting'
                  ? `${esc(st.version)} is ready. Save your design to finish.`
                  : st.error
                    ? `Couldn't check: ${esc(st.error)}`
                    : 'Endpaper checks for updates when it starts and every few hours.';
    return `<h5>Updates</h5><p class="up-line">${line}</p>
      <div class="btn-row">${st.status === 'available' ? '<button class="btn btn-sm btn-accent" data-up="now">Update now</button>' : `<button class="btn btn-sm" data-up="check" ${st.status === 'off' ? 'disabled' : ''}>Check for updates</button>`}<button class="btn btn-sm btn-ghost" data-up="notes">Release notes on GitHub</button></div>
      <p class="hint">Updates never install while your design has unsaved changes. Endpaper asks you to save, then reopens it after the update.</p>`;
  };
  function renderSettings() {
    const host = document.querySelector('.up-section');
    if (host) host.innerHTML = settingsHtml();
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('.up-section [data-up]');
    if (!b) return;
    if (b.dataset.up === 'check') {
      st = { ...st, status: 'checking' };
      renderSettings();
      set(await ep.update.check());
    }
    if (b.dataset.up === 'now') set(await ep.update.download());
    if (b.dataset.up === 'notes') ep.update.releases();
  });

  async function init() {
    ep.on('update', (s) => set(s));
    ep.on('update:prepare', async () => {
      let r;
      try {
        r = await prepare();
      } catch (e) {
        console.error(e);
        r = { ok: false };
      }
      ep.update.prepared(r);
    });
    set(await ep.update.state());
  }

  return { init, settingsHtml, get state() { return st; } };
})();
