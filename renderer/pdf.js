/* Print PDF: everything in CMYK, photos converted with the printing profile and stored as CMYK
   JPEGs, fonts embedded, bleed, crop marks, TrimBox/BleedBox, and the PDF/X-4 output intent and
   metadata. Pages are drawn in millimetres with the y axis pointing down, like the editor. */
const Pdf = (() => {
  const P = () => PDFLib;
  const KAPPA = 0.5522847498;
  const REG = [1, 1, 1, 1]; // registration colour for crop marks

  async function build(doc, opts, onProgress = () => {}) {
    try {
      return await buildOnce(doc, opts, onProgress, true);
    } catch (e) {
      console.warn('PDF with font subsets failed, trying whole fonts', e);
      return await buildOnce(doc, opts, onProgress, false);
    }
  }

  async function buildOnce(doc, opts, onProgress, subset) {
    const { PDFDocument, PDFName, PDFString, PDFHexString, PDFOperator, PDFOperatorNames } = P();
    const op = P();
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.registerFontkit(fontkit);
    const ctx = pdf.context;
    const fonts = new Map();
    const images = new Map();
    const gstates = new Map();
    const crop = !!opts.cropMarks;
    const surfaces = opts.surfaces;

    async function fontFor(path) {
      const f = Fonts.get(path);
      if (!f) return null;
      if (!fonts.has(f.path)) fonts.set(f.path, { f, pf: await pdf.embedFont(f.bytes, { subset }) });
      return fonts.get(f.path);
    }

    for (let si = 0; si < surfaces.length; si++) {
      const s = surfaces[si];
      onProgress(si / surfaces.length, s);
      await new Promise((r) => setTimeout(r, 0));
      const sz = Model.surfaceSize(doc, s);
      const b = opts.bleed ? sz.bleed : 0;
      const sd = Model.surfaceSide(doc, s);
      // Bleed on each side; book interiors can leave it off the spine edge.
      const bl = { t: b, b: b, l: b, r: b };
      if (opts.noSpineBleed && sd === 'left') bl.r = 0;
      if (opts.noSpineBleed && sd === 'right') bl.l = 0;
      const slug = crop ? Math.max(b, 3) + 10 : 0;
      const ext = { t: crop ? slug : bl.t, b: crop ? slug : bl.b, l: crop ? slug : bl.l, r: crop ? slug : bl.r };
      const k = 72 / 25.4;
      const W = (sz.w + ext.l + ext.r) * k;
      const H = (sz.h + ext.t + ext.b) * k;
      const page = pdf.addPage([W, H]);
      const node = page.node;
      // Boxes, in points from the bottom-left.
      page.setTrimBox(ext.l * k, ext.b * k, sz.w * k, sz.h * k);
      page.setBleedBox((ext.l - bl.l) * k, (ext.b - bl.b) * k, (sz.w + bl.l + bl.r) * k, (sz.h + bl.t + bl.b) * k);
      const ops = [];
      const push = (...o) => ops.push(...o);
      const cmyk = (c) => [c.c / 100, c.m / 100, c.y / 100, c.k / 100];
      const fillC = (c) => op.setFillingCmykColor(...cmyk(c));
      const strokeC = (c) => op.setStrokingCmykColor(...cmyk(c));
      // mm, y down, origin at the trim's top-left.
      push(op.pushGraphicsState(), op.concatTransformationMatrix(k, 0, 0, -k, ext.l * k, H - ext.t * k));
      // Nothing prints outside the bleed.
      push(op.pushGraphicsState(), op.rectangle(-bl.l, -bl.t, sz.w + bl.l + bl.r, sz.h + bl.t + bl.b), op.clip(), op.endPath());
      // A cover page is a window onto the cover sheet: shift the sheet so its part sits on the page.
      const org = Model.surfaceOrigin(doc, s);
      if (org) push(op.concatTransformationMatrix(1, 0, 0, 1, -org, 0));
      const pc = Render.ctxFor(doc, s);
      for (const { it } of Render.itemsOf(doc, s)) {
        if (it.hidden) continue;
        await drawItem(it, pc);
      }
      push(op.popGraphicsState());
      if (crop) cropMarks(sz, bl);
      push(op.popGraphicsState());
      page.pushOperators(...ops);

      function gs(alpha) {
        const a = Math.round(alpha * 1000) / 1000;
        if (!gstates.has(a)) gstates.set(a, ctx.register(ctx.obj({ Type: 'ExtGState', ca: a, CA: a })));
        return node.newExtGState('GS', gstates.get(a));
      }

      // Blend modes (multiply and so on) for a photo; PDF/X-4 allows them.
      function blendGs(mode) {
        if (!gstates.has('bm:' + mode)) gstates.set('bm:' + mode, ctx.register(ctx.obj({ Type: 'ExtGState', BM: PhotoEdit.PDF_BLEND[mode] })));
        return node.newExtGState('GS', gstates.get('bm:' + mode));
      }
      // A drop shadow: the frame's shape, softened, in the shadow's CMYK colour through a soft mask.
      function drawShadow(it, sh) {
        const m = PhotoEdit.shadowMask(it, sh);
        const col = Model.resolveColor(doc, sh.colour) || { c: 0, m: 0, y: 0, k: 100 };
        const smask = ctx.register(ctx.flateStream(m.grey, { Type: 'XObject', Subtype: 'Image', Width: m.pw, Height: m.ph, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
        const ink = new Uint8Array([col.c, col.m, col.y, col.k].map((v) => Math.round(v * 2.55)));
        const base = ctx.register(ctx.stream(ink, { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, SMask: smask }));
        push(op.pushGraphicsState());
        const alpha = (it.opacity ?? 1) * (sh.opacity / 100);
        if (alpha < 1) push(op.setGraphicsState(gs(alpha)));
        const key = node.newXObject('Sh', base);
        push(op.concatTransformationMatrix(m.w, 0, 0, -m.h, m.x, m.y + m.h), op.drawObject(key), op.popGraphicsState());
      }

      function rectPath(x, y, w, h, r) {
        r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
        if (!r) return [op.rectangle(x, y, w, h)];
        const c = r * (1 - KAPPA);
        return [
          op.moveTo(x + r, y),
          op.lineTo(x + w - r, y),
          op.appendBezierCurve(x + w - c, y, x + w, y + c, x + w, y + r),
          op.lineTo(x + w, y + h - r),
          op.appendBezierCurve(x + w, y + h - c, x + w - c, y + h, x + w - r, y + h),
          op.lineTo(x + r, y + h),
          op.appendBezierCurve(x + c, y + h, x, y + h - c, x, y + h - r),
          op.lineTo(x, y + r),
          op.appendBezierCurve(x, y + c, x + c, y, x + r, y),
          op.closePath(),
        ];
      }
      function ellipsePath(w, h) {
        const rx = w / 2, ry = h / 2, ox = rx * KAPPA, oy = ry * KAPPA;
        return [
          op.moveTo(0, ry),
          op.appendBezierCurve(0, ry - oy, rx - ox, 0, rx, 0),
          op.appendBezierCurve(rx + ox, 0, w, ry - oy, w, ry),
          op.appendBezierCurve(w, ry + oy, rx + ox, h, rx, h),
          op.appendBezierCurve(rx - ox, h, 0, ry + oy, 0, ry),
          op.closePath(),
        ];
      }

      async function drawItem(it, pc) {
        push(op.pushGraphicsState());
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        push(op.concatTransformationMatrix(1, 0, 0, 1, cx, cy));
        if (it.rot) {
          const a = (it.rot * Math.PI) / 180;
          push(op.concatTransformationMatrix(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0));
        }
        push(op.concatTransformationMatrix(1, 0, 0, 1, -it.w / 2, -it.h / 2));
        if ((it.opacity ?? 1) < 1) push(op.setGraphicsState(gs(it.opacity)));
        const fill = Model.resolveColor(doc, it.fill);
        const stroke = Model.resolveColor(doc, it.stroke);
        const sw = it.strokeW || 0;
        if (it.type === 'rect' || it.type === 'ellipse') {
          const path = () => (it.type === 'rect' ? rectPath(0, 0, it.w, it.h, it.radius) : ellipsePath(it.w, it.h));
          if (fill) push(fillC(fill), ...path(), op.fill());
          if (stroke && sw) push(strokeC(stroke), op.setLineWidth(sw), ...path(), op.stroke());
        } else if (it.type === 'line') {
          if (stroke && sw) push(strokeC(stroke), op.setLineWidth(sw), op.setLineCap(0), op.moveTo(0, it.h / 2), op.lineTo(it.w, it.h / 2), op.stroke());
        } else if (it.type === 'image') {
          const img = it.asset ? await imageFor(it) : null;
          const pfx = PhotoFX.frameEffects(it.effects);
          if (img && pfx.shadow) drawShadow(it, pfx.shadow);
          if (img) {
            push(op.pushGraphicsState(), op.rectangle(0, 0, it.w, it.h), op.clip(), op.endPath());
            if (pfx.blend && PhotoEdit.PDF_BLEND[pfx.blend]) push(op.setGraphicsState(blendGs(pfx.blend)));
            const key = node.newXObject('Im', img.ref);
            push(op.concatTransformationMatrix(img.w, 0, 0, -img.h, img.x, img.y + img.h), op.drawObject(key), op.popGraphicsState());
          }
          if (stroke && sw) push(strokeC(stroke), op.setLineWidth(sw), op.rectangle(0, 0, it.w, it.h), op.stroke());
        } else if (it.type === 'text') {
          const L = Layout.box(doc, it, pc);
          const st = L.style || Model.styleOf(doc, it);
          if (L.lines.length && L.font) {
            const ent = await fontFor(L.font.path);
            if (ent) {
              const fkey = node.newFontDictionary(ent.pf.name, ent.pf.ref);
              const col = Model.resolveColor(doc, st.color) || { c: 0, m: 0, y: 0, k: 100 };
              push(op.beginText(), fillC(col), op.setFontAndSize(fkey, L.size));
              if (st.tracking) push(op.setCharacterSpacing((st.tracking / 1000) * L.size));
              for (const l of L.lines) {
                const runs = l.justified ? l.words.map((w) => ({ t: w.t, x: w.x })) : [{ t: l.text, x: l.x }];
                for (const r of runs) {
                  if (!r.t) continue;
                  push(op.setTextMatrix(1, 0, 0, -1, r.x, l.y), showKerned(ent, r.t));
                }
              }
              push(op.endText());
            }
          }
        }
        push(op.popGraphicsState());
      }

      // TJ with the font's kerning, so spacing matches the screen.
      function showKerned(ent, text) {
        const hex = ent.pf.encodeText(text);
        const codes = hex.value.match(/.{4}/g) || [];
        let run;
        try {
          run = ent.f.fk.layout(text);
        } catch {
          run = null;
        }
        if (!run || run.glyphs.length !== codes.length) return PDFOperator.of(PDFOperatorNames.ShowText, [hex]);
        const parts = [];
        let curHex = '';
        for (let i = 0; i < codes.length; i++) {
          curHex += codes[i];
          const kern = run.positions[i].xAdvance - run.glyphs[i].advanceWidth;
          if (kern && i < codes.length - 1) {
            parts.push(PDFHexString.of(curHex), ctx.obj(Math.round((-kern / ent.f.upm) * 1000 * 100) / 100));
            curHex = '';
          }
        }
        if (curHex) parts.push(PDFHexString.of(curHex));
        return PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [ctx.obj(parts)]);
      }

      function cropMarks(sz, bl) {
        const off = Math.max(bl.t, bl.b, bl.l, bl.r, 3) + 1;
        const len = 6;
        const lw = 0.25 / k;
        push(op.pushGraphicsState(), op.setStrokingCmykColor(...REG), op.setLineWidth(lw));
        for (const x of [0, sz.w])
          for (const y of [0, sz.h]) {
            const dx = x === 0 ? -1 : 1;
            const dy = y === 0 ? -1 : 1;
            push(op.moveTo(x + dx * off, y), op.lineTo(x + dx * (off + len), y), op.stroke());
            push(op.moveTo(x, y + dy * off), op.lineTo(x, y + dy * (off + len)), op.stroke());
          }
        if (s.kind === 'cover' && !Model.isCoverPage(s)) {
          // Spine fold marks, top and bottom.
          const c = Model.cover(doc);
          for (const x of c.spineX) {
            push(op.moveTo(x, -off), op.lineTo(x, -off - len), op.stroke());
            push(op.moveTo(x, sz.h + off), op.lineTo(x, sz.h + off + len), op.stroke());
          }
        }
        push(op.popGraphicsState());
      }
    }

    /* ----- photos: crop to what shows, resample, convert to CMYK, compress ----- */
    async function imageFor(it) {
      const a = Assets.get(it.asset) || (await Assets.load(doc, it.asset));
      if (!a) return null;
      const dm = PhotoEdit.dims(it, a); // after any turn of the photo
      const fx = PhotoFX.frameEffects(it.effects);
      const iw = dm.w * it.s, ih = dm.h * it.s;
      const x0 = Math.max(0, it.ox), y0 = Math.max(0, it.oy);
      const x1 = Math.min(it.w, it.ox + iw), y1 = Math.min(it.h, it.oy + ih);
      if (x1 <= x0 || y1 <= y0) return null;
      const sx = (x0 - it.ox) / it.s, sy = (y0 - it.oy) / it.s;
      const sw = (x1 - x0) / it.s, sh = (y1 - y0) / it.s;
      const ppi = 25.4 / it.s;
      const target = opts.maxPpi && ppi > opts.maxPpi ? opts.targetPpi || 300 : ppi;
      const pw = Math.max(1, Math.round(((x1 - x0) / 25.4) * target));
      const ph = Math.max(1, Math.round(((y1 - y0) / 25.4) * target));
      const key = [it.asset, sx.toFixed(1), sy.toFixed(1), sw.toFixed(1), sh.toFixed(1), pw, ph, JSON.stringify(PhotoFX.active(it.effects))].join('|');
      if (!images.has(key)) {
        const c = document.createElement('canvas');
        c.width = pw;
        c.height = ph;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        // The photo's effects, worked out at the size it's printed (renderer/photoedit.js).
        const v = PhotoFX.hasPixelWork(it.effects) ? PhotoEdit.view(doc, it, { scale: Math.min(1, pw / sw) }) : a;
        const f = (v.img.naturalWidth || v.img.width) / dm.w;
        g.drawImage(v.img, sx * f, sy * f, sw * f, sh * f, 0, 0, pw, ph);
        if (fx.fade) PhotoEdit.fadeCropped(g, pw, ph, it, x0, y0, x1, y1, fx.fade.width);
        const px = g.getImageData(0, 0, pw, ph).data;
        const { cmyk, alpha } = Color.imageToCmyk(px, pw, ph);
        const jpg = CmykJpeg.encode(cmyk, pw, ph, opts.quality || 92);
        const dict = { Type: 'XObject', Subtype: 'Image', Width: pw, Height: ph, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'DCTDecode', Decode: [1, 0, 1, 0, 1, 0, 1, 0] };
        if (alpha) dict.SMask = ctx.register(ctx.flateStream(alpha, { Type: 'XObject', Subtype: 'Image', Width: pw, Height: ph, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
        images.set(key, ctx.register(ctx.stream(jpg, dict)));
      }
      return { ref: images.get(key), x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /* ----- PDF/X-4 ----- */
    const now = new Date();
    const title = opts.title || doc.name || 'Untitled';
    pdf.setTitle(title);
    pdf.setCreator('Endpaper');
    pdf.setProducer('Endpaper with pdf-lib');
    pdf.setCreationDate(now);
    pdf.setModificationDate(now);
    const info = pdf.getInfoDict();
    info.set(PDFName.of('Trapped'), PDFName.of('False'));
    const idHex = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
    ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(idHex), PDFHexString.of(idHex)]);
    if (opts.pdfx && Color.profileBytes) {
      const name = Color.profileName || 'CMYK';
      const fogra = /fogra\s*39/i.test(name) ? 'FOGRA39' : /fogra\s*51/i.test(name) ? 'FOGRA51' : /gracol/i.test(name) ? 'CGATS TR 006' : /swop/i.test(name) ? 'CGATS TR 001' : name;
      const icc = ctx.register(ctx.flateStream(Color.profileBytes, { N: 4 }));
      const oi = ctx.register(
        ctx.obj({
          Type: 'OutputIntent',
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of(fogra),
          OutputCondition: PDFString.of(name),
          Info: PDFString.of(name),
          RegistryName: PDFString.of('http://www.color.org'),
          DestOutputProfile: icc,
        })
      );
      pdf.catalog.set(PDFName.of('OutputIntents'), ctx.obj([oi]));
      info.set(PDFName.of('GTS_PDFXVersion'), PDFString.of('PDF/X-4'));
      const meta = ctx.stream(new TextEncoder().encode(xmp(title, now, idHex)), { Type: 'Metadata', Subtype: 'XML' });
      pdf.catalog.set(PDFName.of('Metadata'), ctx.register(meta));
    }
    onProgress(1);
    return pdf.save({ useObjectStreams: false });
  }

  function xmp(title, d, id) {
    const iso = d.toISOString().replace(/\.\d+Z$/, 'Z');
    const x = (s) => esc(s);
    return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${x(title)}</rdf:li></rdf:Alt></dc:title>
   <xmp:CreatorTool>Endpaper</xmp:CreatorTool>
   <xmp:CreateDate>${iso}</xmp:CreateDate>
   <xmp:ModifyDate>${iso}</xmp:ModifyDate>
   <xmp:MetadataDate>${iso}</xmp:MetadataDate>
   <pdf:Producer>Endpaper with pdf-lib</pdf:Producer>
   <pdf:Trapped>False</pdf:Trapped>
   <xmpMM:DocumentID>uuid:${id}</xmpMM:DocumentID>
   <xmpMM:InstanceID>uuid:${id}</xmpMM:InstanceID>
   <xmpMM:VersionID>1</xmpMM:VersionID>
   <xmpMM:RenditionClass>default</xmpMM:RenditionClass>
   <pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  }

  return { build };
})();
