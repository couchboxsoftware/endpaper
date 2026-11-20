/* After export: opening what was exported, in Inkdesktop (Couchbox Software's PDF app) when it's
   installed, or in Windows' default app. While Inkdesktop isn't installed, Endpaper asks first
   whether you'd like to try it: Endpaper's "Exported" message on the left, Inkdesktop's own
   panel on the right, in its colours with its pen nib. "Don't ask again" turns that off; it's
   listed in Settings, Hints like any hint, so it can come back. The main process does the
   finding and opening (src/main/inkdesktop.js). */
const Inkdesktop = (() => {
  // Inkdesktop's mark and colours, copied from its renderer/brand.js (the pen nib: two halves and
  // the breather hole with its slit), so its panel looks like Inkdesktop, not like Endpaper.
  const BLUE = '#2F6BE8';
  const NIB = [
    'M24 41C21 36 14 30 13 25C12.3 21.5 14.5 18.5 18 16.5V10H24',
    'M24 41C27 36 34 30 35 25C35.7 21.5 33.5 18.5 30 16.5V10H24',
    'M24 29.5V38M24 21.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5',
  ];
  const tile = (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><rect x="1" y="1" width="46" height="46" rx="11" fill="#141414"/>` +
    `<g transform="translate(24 25.5) scale(0.86) translate(-24 -25.5)" fill="none" stroke="${BLUE}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">${NIB.map((d) => `<path d="${d}"/>`).join('')}</g></svg>`;

  let found; // Inkdesktop's exe, null when it isn't installed, undefined until asked
  async function find(fresh = false) {
    if (fresh || found === undefined) found = await ep.inkdesktop.find();
    return found;
  }
  const fileName = (p) => p.split(/[\\/]/).pop();

  // files: what was just exported. format: 'pdf', 'png' or 'jpg'. folder: where images went.
  async function afterExport({ files, format, folder }) {
    if (format !== 'pdf') {
      // Pictures: always the folder, never a window per picture.
      ep.file.showFolder(folder || files[0]);
      return;
    }
    if (await find()) {
      // Inkdesktop opens one PDF at a time: the first (a book's inside pages), plus the folder
      // so a second one (the cover) is one click away.
      await ep.inkdesktop.open(files[0]);
      if (files.length > 1) ep.file.showFolder(files[0]);
      toast(`Exported ${files.length === 1 ? fileName(files[0]) : files.length + ' PDFs'} and opened ${fileName(files[0])} in Inkdesktop.`, { ms: 6000 });
      return;
    }
    if (Hints.isOff('try-inkdesktop')) return openInViewer(files);
    offer(files);
  }
  function openInViewer(files) {
    for (const f of files) ep.file.openDefault(f);
  }

  // The window: Endpaper's "Exported" on the left, Inkdesktop's offer on the right.
  function offer(files) {

    const m = openModal({
      title: 'Exported',
      cls: 'ink-offer',
      body: `<div class="io-grid">
        <section class="io-done">
          <h3>Exported</h3>
          <ul class="io-files">${files.map((f) => `<li title="${esc(f)}">${esc(fileName(f))}</li>`).join('')}</ul>
          <div class="io-actions"><button class="btn btn-sm" data-io="viewer" autofocus>Open in my PDF viewer</button><button class="btn btn-sm btn-ghost" data-io="folder">Show in folder</button></div>
        </section>
        <section class="io-ink" aria-label="Inkdesktop">
          <div class="io-brand">${tile(36)}<span class="io-word">ink<b>desktop</b></span></div>
          <h4>Do you want to try Inkdesktop?</h4>
          <p>Our PDF app, from the makers of Endpaper. Check your proof, then fill in, sign, mark up, arrange or shrink it. Free, and it all stays on your computer.</p>
          <div class="io-actions"><button class="io-get" data-io="get">Get Inkdesktop</button></div>
          <label class="io-off"><input type="checkbox" data-io-off> Don't ask again</label>
        </section>
      </div>`,
      onClose: () => {
        if (m.el.querySelector('[data-io-off]').checked) Hints.turnOff('try-inkdesktop');
      },
    });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-io]');
      if (!b) return;
      const a = b.dataset.io;
      if (a === 'folder') return ep.file.showFolder(files[0]);

      if (a === 'get') ep.inkdesktop.get();
      openInViewer(files);
      m.close();
    });
  }

  return { find, afterExport };
})();
