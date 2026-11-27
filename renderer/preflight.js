/* Preflight: the checks a printer makes, before you send the file. Each problem says what's
   wrong, where, and links to the thing so you can fix it. */
const Preflight = (() => {
  const where = (doc, s) => Model.surfaceName(doc, s);

  function run(doc, surfaces = Model.printedSurfaces(doc)) {
    const out = [];
    const add = (level, text, s, it) => out.push({ level, text, surface: s, itemId: it ? it.id : null, where: where(doc, s) });
    const seenMaster = new Set();
    for (const s of surfaces) {
      const sz = Model.surfaceSize(doc, s);
      const sd = Model.surfaceSide(doc, s);
      const m = s.kind === 'cover' ? { top: 6, bottom: 6, left: 6, right: 6 } : Model.margins(doc, sd);
      // A cover page shows part of the cover sheet: check the boxes on it, measured from its own edge.
      const org = Model.surfaceOrigin(doc, s);
      const items = Model.surfaceItems(doc, s).filter((it) => Model.onSurface(doc, s, it));
      if (s.kind === 'master') {
        const k = s.id + s.side;
        if (seenMaster.has(k)) continue;
        seenMaster.add(k);
      }
      if (s.kind === 'page' && !items.length && !Model.masterItems(doc, s.idx).length) add('info', 'This page is empty.', s);
      for (const orig of items) {
        if (orig.hidden) continue;
        const it = org ? { ...orig, x: orig.x - org } : orig;
        const name = `“${Model.itemLabel(orig)}”`;
        if (it.type === 'image') {
          if (!it.asset || !doc.assets[it.asset]) add('error', `${name} has no photo in it.`, s, it);
          else {
            const ppi = Math.round(Render.ppi(it));
            if (ppi < 200) add('error', `${name} is ${ppi} ppi and will print blurry. Make it smaller or use a bigger photo (300 ppi is best).`, s, it);
            else if (ppi < 280) add('warn', `${name} is ${ppi} ppi. 300 ppi is best for print.`, s, it);
            // Your own textures, at the size they're laid over the photo.
            for (const e of PhotoFX.active(orig.effects).filter((x) => x.type === 'texture')) {
              const tp = Textures.ppi(doc, orig, e);
              if (tp != null && tp < 150) add('warn', `${name}'s texture “${Textures.nameOf(doc, e.p.tex)}” is ${Math.round(tp)} ppi at this size and may print soft. Make it smaller in the effect, or use a bigger texture.`, s, it);
            }
          }
        }
        if (it.type === 'text') {
          const st = Model.styleOf(doc, it);
          if (!Fonts.exists(st.font)) add('error', `${name} uses a font that isn't on this computer, so ${Fonts.fallback?.name || 'another font'} is used instead.`, s, it);
          const L = Layout.box(doc, orig, Render.ctxFor(doc, s));
          if (L.overflow) add('error', `${name} has more text than fits. Make the box bigger or continue it in another box.`, s, it);
          const c = Model.resolveColor(doc, st.color);
          if (c && c.k >= 90 && c.c + c.m + c.y > 0 && st.size < 14) add('warn', `${name} is small text in rich black. Use 100% black (K only) so it prints sharp.`, s, it);
          if (c && Model.ink(c) > 300) add('warn', `${name} uses ${Model.ink(c)}% ink. Most printers ask for 300% or less.`, s, it);
          if (!it.rot && s.kind !== 'master') {
            const out_ = it.x < m.left - 0.05 || it.y < m.top - 0.05 || it.x + it.w > sz.w - m.right + 0.05 || it.y + it.h > sz.h - m.bottom + 0.05;
            const onPage = it.x < sz.w && it.y < sz.h && it.x + it.w > 0 && it.y + it.h > 0;
            if (out_ && onPage && (it.text || '').trim()) add('warn', `${name} goes outside the safe area, so it could be trimmed off.`, s, it);
          }
        }
        if (it.type === 'rect' || it.type === 'ellipse') {
          const f = Model.resolveColor(doc, it.fill);
          if (f && Model.ink(f) > 300) add('warn', `${name} uses ${Model.ink(f)}% ink. Most printers ask for 300% or less.`, s, it);
        }
        // Things that touch the edge should run into the bleed, or a white sliver can show.
        if ((it.type === 'image' || it.type === 'rect') && !it.rot && sz.bleed > 0) {
          const near = 1.0;
          const b = sz.bleed - 0.05;
          const spineSide = s.kind === 'page' && doc.facing ? (sd === 'left' ? 'right' : 'left') : null;
          const sides = [
            ['left', it.x, () => it.x > -b && it.x < near],
            ['top', it.y, () => it.y > -b && it.y < near],
            ['right', sz.w - (it.x + it.w), () => it.x + it.w < sz.w + b && it.x + it.w > sz.w - near],
            ['bottom', sz.h - (it.y + it.h), () => it.y + it.h < sz.h + b && it.y + it.h > sz.h - near],
          ];
          const bad = sides.filter(([sideName, , test]) => sideName !== spineSide && test()).map((x) => x[0]);
          if (bad.length) add('warn', `${name} stops at the ${bad.join(' and ')} edge. Stretch it ${sz.bleed} mm past the edge into the bleed.`, s, it);
        }
      }
      // Text that will print as a picture, because of picture effects on it or its group
      // (renderer/itemfx.js). It stays editable in Endpaper.
      for (const e of ItemFX.entities(doc, items)) {
        if (!ItemFX.rastersText(e)) continue;
        const fx = ItemFX.pictureEffects(e.effects).map((x) => PhotoFX.TYPES[x.type].name).join(', ');
        const what = e.kind === 'group' ? `The text in the group “${e.name}”` : `“${e.name}”`;
        add('warn', `${what} will print as a picture (600 ppi), because of ${fx}. It's still text in Endpaper.`, s, e.items.find((x) => x.type === 'text') || e.items[0]);
      }
    }
    if (doc.facing && doc.pages.length % 2) add('info', `The book has ${doc.pages.length} pages. Printers need an even number, so a blank page will be added at the end.`, { kind: 'page', idx: doc.pages.length - 1 });
    if (doc.cover.enabled) {
      const c = Model.cover(doc);
      if (Model.isSingle(doc)) {
        // Single pages leave the spine (and anything only on it) out of view and out of the PDF.
        const pages = Model.coverSurfaces(doc);
        for (const [list, inside] of [[doc.cover.items, false], [doc.cover.inside.enabled ? doc.cover.inside.items : [], true]])
          for (const it of list)
            if (!it.hidden && !pages.some((p) => Model.isInside(p) === inside && Model.onSurface(doc, p, it, { trim: true })))
              add('warn', `“${Model.itemLabel(it)}” is on the spine, so it's hidden while the cover is single pages and won't print. Switch the cover back to a spread to see it.`, Model.coverSurfaceFor(doc, { kind: 'cover', ...(inside ? { side: 'inside' } : {}) }));
      } else if (c.spine < 6) {
        const spineText = doc.cover.items.some((it) => it.type === 'text' && it.x < c.spineX[1] && it.x + it.w > c.spineX[0] && (it.text || '').trim());
        if (spineText) add('warn', `The spine is only ${c.spine.toFixed(1)} mm wide. Most printers don't allow text on spines under 6 mm.`, { kind: 'cover' });
      }
      if (doc.cover.inside.enabled) {
        const inside = { kind: 'cover', side: 'inside' };
        // The spine and the strip either side of it are glued to the pages, so nothing prints there.
        for (const it of doc.cover.inside.items) {
          if (it.hidden) continue;
          if (it.x < c.glue[1] && it.x + it.w > c.glue[0]) add('warn', `“${Model.itemLabel(it)}” is in the glue area down the middle of the inside cover. Keep the spine and ${((c.glue[1] - c.glue[0] - c.spine) / 2).toFixed(0)} mm either side of it clear.`, inside, it);
        }
        add('info', "Not every printer prints the inside of a cover (Amazon KDP doesn't). Check with yours before you design it.", inside);
      }
    }
    const order = { error: 0, warn: 1, info: 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  return { run };
})();
