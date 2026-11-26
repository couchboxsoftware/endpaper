/* The photo effects engine: a photo and a list of effects in, the finished picture out. It knows
   nothing about Endpaper's pages or files, so it can be lifted into its own app.

   An effect is { id, type, on, strength (0-100), p: { ...settings } }. They apply in list order.
   Three kinds:
     - geometric (flip and rotate): always applied first, and can swap width and height
       (Remove background comes straight after it, before everything else)
     - pixel: change the picture's colours and detail (most of them)
     - frame: act on the frame the photo sits in (fade edges, blend mode, drop shadow); the engine
       only reports them (frameEffects) and the page drawing applies them

   Sizes that should look the same at any resolution (blur, sharpen, grain, halftone dots) are in
   mm on the page; render() is told how many source pixels make a millimetre (pxPerMm). Colours
   (duotone, overlay, shadow) are whatever the caller uses; render() turns them into RGB with
   env.color(ref) -> [r, g, b]. Texture pictures are the caller's too: render() is given
   texture(ref, pixels, seed) -> { img, tiles } (renderer/texturegen.js draws the built-in ones).
   Remove background's masks are the caller's too: mask(ref) -> a greyscale picture, white kept.

   Settings (params) are range, select, toggle, colour, curve, texture, shuffle or mask. One with
   when(p) only shows while that's true (Texture's Size only when tiling, for example). */
const PhotoFX = (() => {
  const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const range = (k, label, min, max, def, step = 1, unit = '') => ({ k, label, type: 'range', min, max, def, step, unit });

  /* ---------- building blocks ---------- */
  function applyLut(d, lut, lg = lut, lb = lut) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lg[d[i + 1]];
      d[i + 2] = lb[d[i + 2]];
    }
  }
  const lutOf = (fn) => {
    const l = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) l[v] = fn(v);
    return l;
  };
  // A picture with mirrored copies beside and below it, so tiling it shows no hard joins.
  const mirrors = new WeakMap();
  function mirrored(img) {
    if (mirrors.has(img)) return mirrors.get(img);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const c = document.createElement('canvas');
    c.width = 2 * w;
    c.height = 2 * h;
    const g = c.getContext('2d');
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      g.setTransform(sx, 0, 0, sy, sx < 0 ? 2 * w : 0, sy < 0 ? 2 * h : 0);
      g.drawImage(img, 0, 0);
    }
    mirrors.set(img, c);
    return c;
  }
  // Brightness from a 0..255 luminance curve, keeping each pixel's colour.
  function applyLumaLut(d, lut) {
    for (let i = 0; i < d.length; i += 4) {
      const L = lum(d[i], d[i + 1], d[i + 2]);
      const n = lut[L | 0];
      if (L < 1) {
        d[i] = d[i + 1] = d[i + 2] = n;
        continue;
      }
      const f = n / L;
      d[i] = clamp8(d[i] * f);
      d[i + 1] = clamp8(d[i + 1] * f);
      d[i + 2] = clamp8(d[i + 2] * f);
    }
  }
  const toLin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const toSrgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

  // Gaussian-like blur: three box blurs, each across then down. In place. See-through-ness blurs
  // too, and colours are weighted by it, so a cut-out's outline goes soft without the hidden
  // background's colours bleeding in. edges: what's past the picture's edge counts as see-through,
  // so the edges blur away; otherwise the edge pixels carry on outwards and the edges stay crisp.
  function blur(d, w, h, radius, { edges = false } = {}) {
    const sigma = Math.max(0, radius);
    if (sigma < 0.4) return;
    const boxes = boxSizes(sigma, 3);
    const n = w * h * 4;
    const tmp = new Float32Array(n);
    const src = new Float32Array(n);
    for (let i = 0; i < n; i += 4) {
      const a = d[i + 3] / 255;
      src[i] = d[i] * a;
      src[i + 1] = d[i + 1] * a;
      src[i + 2] = d[i + 2] * a;
      src[i + 3] = d[i + 3];
    }
    for (const b of boxes) {
      const r = (b - 1) / 2;
      boxH(src, tmp, w, h, r, edges);
      boxV(tmp, src, w, h, r, edges);
    }
    for (let i = 0; i < n; i += 4) {
      const A = src[i + 3];
      if (A < 0.5) {
        d[i + 3] = 0;
        continue;
      }
      const k = 255 / A;
      d[i] = src[i] * k;
      d[i + 1] = src[i + 1] * k;
      d[i + 2] = src[i + 2] * k;
      d[i + 3] = A;
    }
  }
  function boxSizes(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
  }
  // One box blur across (boxH) or down (boxV), on RGBA floats. zero: past the edge is nothing
  // (see-through); otherwise the edge pixel repeats.
  function boxH(s, t, w, h, r, zero) {
    const iarr = 1 / (r + r + 1);
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 4; c++) {
        const row = y * w * 4 + c;
        const first = zero ? 0 : s[row], last = zero ? 0 : s[row + (w - 1) * 4];
        let val = 0;
        for (let j = -r - 1; j < r; j++) val += j < 0 ? first : j >= w ? last : s[row + j * 4];
        for (let x = 0; x < w; x++) {
          const xa = x + r, xb = x - r - 1;
          val += (xa < w ? s[row + xa * 4] : last) - (xb >= 0 ? s[row + xb * 4] : first);
          t[row + x * 4] = val * iarr;
        }
      }
    }
  }
  function boxV(s, t, w, h, r, zero) {
    const iarr = 1 / (r + r + 1);
    const stride = w * 4;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const col = x * 4 + c;
        const first = zero ? 0 : s[col], last = zero ? 0 : s[col + (h - 1) * stride];
        let val = 0;
        for (let j = -r - 1; j < r; j++) val += j < 0 ? first : j >= h ? last : s[col + j * stride];
        for (let y = 0; y < h; y++) {
          const ya = y + r, yb = y - r - 1;
          val += (ya < h ? s[col + ya * stride] : last) - (yb >= 0 ? s[col + yb * stride] : first);
          t[col + y * stride] = val * iarr;
        }
      }
    }
  }
  // A smooth curve through points [[in, out], ...] (in and out 0..255), as a lookup table.
  function curveLut(points) {
    const pts = [...points].sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) return lutOf((v) => v);
    const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const dx = [], m = [];
    for (let i = 0; i < n - 1; i++) (dx[i] = xs[i + 1] - xs[i] || 1), (m[i] = (ys[i + 1] - ys[i]) / dx[i]);
    // Monotone cubic (Fritsch-Carlson), so the curve never overshoots between points.
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    t[n - 1] = m[n - 2];
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) (t[i] = 0), (t[i + 1] = 0);
      else {
        const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
        if (s > 9) (t[i] = (3 * a * m[i]) / Math.sqrt(s)), (t[i + 1] = (3 * b * m[i]) / Math.sqrt(s));
      }
    }
    return lutOf((v) => {
      if (v <= xs[0]) return ys[0];
      if (v >= xs[n - 1]) return ys[n - 1];
      let i = 0;
      while (v > xs[i + 1]) i++;
      const h = dx[i], u = (v - xs[i]) / h, u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * t[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * t[i + 1];
    });
  }
  // A repeatable 0..1 noise value for a cell, so grain looks the same on screen and in print.
  const hash = (x, y, s) => {
    let n = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };

  /* ---------- the effects ---------- */
  const TYPES = {
    /* ----- Light ----- */
    brightness_contrast: {
      name: 'Brightness and contrast', group: 'Light',
      params: [range('brightness', 'Brightness', -100, 100, 10), range('contrast', 'Contrast', -100, 100, 10)],
      run(d, w, h, p) {
        const C = p.contrast * 2.55, F = (259 * (C + 255)) / (255 * (259 - C));
        applyLut(d, lutOf((v) => F * (v + p.brightness * 1.5 - 128) + 128));
      },
    },
    exposure: {
      name: 'Exposure', group: 'Light',
      params: [range('stops', 'Exposure', -3, 3, 0.5, 0.05, ' stops')],
      run(d, w, h, p) {
        const f = Math.pow(2, p.stops);
        applyLut(d, lutOf((v) => toSrgb(Math.min(1, toLin(v) * f))));
      },
    },
    shadows_highlights: {
      name: 'Shadows and highlights', group: 'Light',
      params: [range('shadows', 'Lift shadows', 0, 100, 35, 1, '%'), range('highlights', 'Calm highlights', 0, 100, 0, 1, '%')],
      run(d, w, h, p) {
        const s = p.shadows / 100, hi = p.highlights / 100;
        applyLumaLut(d, lutOf((v) => {
          const L = v / 255;
          return 255 * (L + s * 1.3 * L * (1 - L) * (1 - L) - hi * 1.3 * L * L * (1 - L));
        }));
      },
    },
    levels: {
      name: 'Levels', group: 'Light', histogram: true,
      params: [range('black', 'Black point', 0, 254, 10), range('mid', 'Middle tones', 0.1, 4, 1, 0.01), range('white', 'White point', 1, 255, 245), range('outBlack', 'Output black', 0, 255, 0), range('outWhite', 'Output white', 0, 255, 255)],
      run(d, w, h, p) {
        const b = Math.min(p.black, p.white - 1), span = p.white - b;
        applyLut(d, lutOf((v) => {
          const x = Math.min(1, Math.max(0, (v - b) / span));
          return p.outBlack + Math.pow(x, 1 / p.mid) * (p.outWhite - p.outBlack);
        }));
      },
    },
    curves: {
      name: 'Curves', group: 'Light', histogram: true,
      params: [{ k: 'points', label: 'Curve', type: 'curve', def: [[0, 0], [64, 52], [192, 204], [255, 255]] }],
      run(d, w, h, p) {
        applyLut(d, curveLut(p.points));
      },
    },

    /* ----- Colour ----- */
    saturation_vibrance: {
      name: 'Saturation and vibrance', group: 'Colour',
      params: [range('saturation', 'Saturation', -100, 100, 15), range('vibrance', 'Vibrance', -100, 100, 15)],
      run(d, w, h, p) {
        const s = p.saturation / 100, vb = p.vibrance / 100;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const L = lum(r, g, b);
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max ? (max - min) / max : 0;
          // Vibrance pushes dull colours more than strong ones.
          const k = 1 + s + vb * (1 - sat);
          d[i] = clamp8(L + (r - L) * k);
          d[i + 1] = clamp8(L + (g - L) * k);
          d[i + 2] = clamp8(L + (b - L) * k);
        }
      },
    },
    warmth_tint: {
      name: 'Warmth and tint', group: 'Colour',
      params: [range('warmth', 'Warmth', -100, 100, 20), range('tint', 'Tint (green to magenta)', -100, 100, 0)],
      run(d, w, h, p) {
        const wm = p.warmth * 0.35, t = p.tint * 0.35;
        applyLut(d, lutOf((v) => v + wm + t * 0.4), lutOf((v) => v - t), lutOf((v) => v - wm + t * 0.4));
      },
    },
    hue: {
      name: 'Hue shift', group: 'Colour',
      params: [range('shift', 'Shift', -180, 180, 30, 1, '°')],
      run(d, w, h, p) {
        // The same colour wheel turn as CSS hue-rotate.
        const a = (p.shift * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const m = [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072];
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          d[i] = clamp8(m[0] * r + m[1] * g + m[2] * b);
          d[i + 1] = clamp8(m[3] * r + m[4] * g + m[5] * b);
          d[i + 2] = clamp8(m[6] * r + m[7] * g + m[8] * b);
        }
      },
    },
    black_white: {
      name: 'Black and white', group: 'Colour',
      params: [],
      run(d) {
        for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = lum(d[i], d[i + 1], d[i + 2]);
      },
    },
    duotone: {
      name: 'Duotone', group: 'Colour',
      params: [{ k: 'dark', label: 'Dark colour', type: 'colour', def: { c: 90, m: 70, y: 25, k: 35 } }, { k: 'light', label: 'Light colour', type: 'colour', def: { c: 0, m: 12, y: 30, k: 0 } }],
      run(d, w, h, p, env) {
        const a = env.color(p.dark), b = env.color(p.light);
        const lr = lutOf((v) => a[0] + ((b[0] - a[0]) * v) / 255), lg = lutOf((v) => a[1] + ((b[1] - a[1]) * v) / 255), lb = lutOf((v) => a[2] + ((b[2] - a[2]) * v) / 255);
        for (let i = 0; i < d.length; i += 4) {
          const L = lum(d[i], d[i + 1], d[i + 2]) | 0;
          d[i] = lr[L];
          d[i + 1] = lg[L];
          d[i + 2] = lb[L];
        }
      },
    },
    colour_overlay: {
      name: 'Colour overlay', group: 'Colour', defStrength: 40,
      params: [{ k: 'colour', label: 'Colour', type: 'colour', def: { c: 0, m: 100, y: 0, k: 0 } }, { k: 'mode', label: 'Mix', type: 'select', def: 'normal', options: [['normal', 'Wash over'], ['multiply', 'Multiply (darker)'], ['screen', 'Screen (lighter)']] }],
      run(d, w, h, p, env) {
        const [cr, cg, cb] = env.color(p.colour);
        for (let i = 0; i < d.length; i += 4) {
          if (p.mode === 'multiply') (d[i] = (d[i] * cr) / 255), (d[i + 1] = (d[i + 1] * cg) / 255), (d[i + 2] = (d[i + 2] * cb) / 255);
          else if (p.mode === 'screen') (d[i] = 255 - ((255 - d[i]) * (255 - cr)) / 255), (d[i + 1] = 255 - ((255 - d[i + 1]) * (255 - cg)) / 255), (d[i + 2] = 255 - ((255 - d[i + 2]) * (255 - cb)) / 255);
          else (d[i] = cr), (d[i + 1] = cg), (d[i + 2] = cb);
        }
      },
    },
    invert: {
      name: 'Invert', group: 'Colour',
      params: [],
      run(d) {
        for (let i = 0; i < d.length; i += 4) (d[i] = 255 - d[i]), (d[i + 1] = 255 - d[i + 1]), (d[i + 2] = 255 - d[i + 2]);
      },
    },

    /* ----- Detail and look ----- */
    sharpen: {
      name: 'Sharpen', group: 'Detail and look',
      params: [range('amount', 'Amount', 0, 300, 80, 1, '%'), range('radius', 'Radius', 0.05, 2, 0.15, 0.01, ' mm'), range('threshold', 'Ignore differences under', 0, 50, 2)],
      run(d, w, h, p, env) {
        const orig = new Uint8ClampedArray(d);
        blur(d, w, h, p.radius * env.pxPerMm);
        const a = p.amount / 100;
        for (let i = 0; i < d.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            const diff = orig[i + c] - d[i + c];
            d[i + c] = Math.abs(diff) < p.threshold ? orig[i + c] : clamp8(orig[i + c] + diff * a);
          }
          d[i + 3] = orig[i + 3]; // sharpening doesn't change what's see-through
        }
      },
    },
    // A cut-out's outline blurs too. "Blur the edges too" lets the photo's outside edges blur
    // away into the page as well.
    blur: {
      name: 'Blur', group: 'Detail and look', alpha: true, makesAlpha: (p) => !!p.edges,
      params: [range('radius', 'Radius', 0.1, 20, 1.5, 0.1, ' mm'), { k: 'edges', label: 'Blur the edges too', type: 'toggle', def: false }],
      run(d, w, h, p, env) {
        blur(d, w, h, p.radius * env.pxPerMm, { edges: !!p.edges });
      },
    },
    noise_reduction: {
      name: 'Noise reduction', group: 'Detail and look',
      params: [range('amount', 'Amount', 0, 100, 50, 1, '%')],
      run(d, w, h, p, env) {
        // Smooth where neighbouring pixels are close (noise), keep edges where they differ a lot.
        const orig = new Uint8ClampedArray(d);
        blur(d, w, h, Math.max(1, 0.08 * env.pxPerMm));
        const a = p.amount / 100;
        for (let i = 0; i < d.length; i += 4) {
          const diff = (Math.abs(orig[i] - d[i]) + Math.abs(orig[i + 1] - d[i + 1]) + Math.abs(orig[i + 2] - d[i + 2])) / 3;
          const k = a * Math.max(0, 1 - diff / 28);
          for (let c = 0; c < 3; c++) d[i + c] = orig[i + c] + (d[i + c] - orig[i + c]) * k;
          d[i + 3] = orig[i + 3]; // smoothing doesn't change what's see-through
        }
      },
    },
    vignette: {
      name: 'Vignette', group: 'Detail and look',
      params: [range('amount', 'Darker or lighter edges', -100, 100, -45), range('size', 'Size', 0, 100, 55, 1, '%'), range('softness', 'Softness', 0, 100, 60, 1, '%')],
      run(d, w, h, p) {
        const cx = w / 2, cy = h / 2, inner = 0.2 + (p.size / 100) * 0.7, soft = 0.05 + (p.softness / 100) * 0.9;
        const amt = p.amount / 100;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const dx = (x - cx) / cx, dy = (y - cy) / cy;
            const r = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
            const t = Math.min(1, Math.max(0, (r - inner * (1 - soft / 2)) / soft));
            const f = t * t * (3 - 2 * t) * amt;
            const i = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) d[i + c] = f < 0 ? d[i + c] * (1 + f) : d[i + c] + (255 - d[i + c]) * f;
          }
      },
    },
    grain: {
      name: 'Grain', group: 'Detail and look',
      params: [range('amount', 'Amount', 0, 100, 25, 1, '%'), range('size', 'Grain size', 0.03, 1, 0.12, 0.01, ' mm'), { k: 'mono', label: 'Black and white grain', type: 'toggle', def: true }],
      run(d, w, h, p, env) {
        const cell = Math.max(1, p.size * env.pxPerMm), a = p.amount * 1.1, seed = env.seed || 1;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
            const i = (y * w + x) * 4;
            if (p.mono) {
              const n = (hash(gx, gy, seed) - 0.5) * a;
              d[i] = clamp8(d[i] + n);
              d[i + 1] = clamp8(d[i + 1] + n);
              d[i + 2] = clamp8(d[i + 2] + n);
            } else for (let c = 0; c < 3; c++) d[i + c] = clamp8(d[i + c] + (hash(gx, gy, seed + c * 101) - 0.5) * a);
          }
      },
    },
    halftone: {
      name: 'Halftone', group: 'Detail and look',
      params: [range('lpi', 'Dot rows per inch', 5, 150, 35, 1, ' lpi'), range('angle', 'Angle', 0, 90, 45, 1, '°'), { k: 'mode', label: 'Dots', type: 'select', def: 'mono', options: [['mono', 'One colour (black)'], ['colour', 'Full colour']] }],
      run(d, w, h, p, env) {
        const cell = Math.max(2, (25.4 / p.lpi) * env.pxPerMm);
        const src = new Uint8ClampedArray(d);
        const sample = (x, y, c) => {
          const xi = Math.min(w - 1, Math.max(0, Math.round(x))), yi = Math.min(h - 1, Math.max(0, Math.round(y)));
          const i = (yi * w + xi) * 4;
          return c < 0 ? lum(src[i], src[i + 1], src[i + 2]) : src[i + c];
        };
        // For each screen (one, or cyan/magenta/yellow at their own angles), each pixel finds its
        // cell's centre, reads the photo there, and is inked if it's inside that cell's dot.
        const screens = p.mode === 'colour' ? [[0, p.angle + 15], [1, p.angle + 75], [2, p.angle]] : [[-1, p.angle]];
        if (p.mode !== 'colour') for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255;
        for (const [ch, ang] of screens) {
          const a = (ang * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const u = (x * ca + y * sa) / cell, v = (-x * sa + y * ca) / cell;
              const cu = Math.floor(u) + 0.5, cv = Math.floor(v) + 0.5;
              const px = (cu * ca - cv * sa) * cell, py = (cu * sa + cv * ca) * cell;
              const ink = 1 - sample(px, py, ch) / 255;
              const rad = Math.sqrt(ink) * 0.72; // dot radius in cells: full ink just covers the cell
              const dist = Math.hypot(u - cu, v - cv);
              const cover = Math.min(1, Math.max(0, (rad - dist) * cell + 0.5)); // soft 1px edge
              const i = (y * w + x) * 4;
              if (ch < 0) d[i] = d[i + 1] = d[i + 2] = 255 * (1 - cover);
              else d[i + ch] = 255 * (1 - cover);
            }
        }
      },
    },
    threshold: {
      name: 'Threshold', group: 'Detail and look',
      params: [range('level', 'Level', 1, 254, 128)],
      run(d, w, h, p) {
        for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = lum(d[i], d[i + 1], d[i + 2]) >= p.level ? 255 : 0;
      },
    },
    posterise: {
      name: 'Posterise', group: 'Detail and look',
      params: [range('levels', 'Colour levels', 2, 16, 4)],
      run(d, w, h, p) {
        const n = p.levels - 1;
        applyLut(d, lutOf((v) => Math.round((v / 255) * n) * (255 / n)));
      },
    },
    // A texture picture laid over the photo. The picture comes from env.texture(ref, pixels, seed),
    // which returns { img, tiles } or null (still loading); the caller decides what refs mean.
    texture: {
      name: 'Texture', group: 'Detail and look', defStrength: 70,
      params: [
        { k: 'tex', label: 'Texture', type: 'texture', def: { kind: 'preset', id: 'canvas' } },
        { k: 'layout', label: 'Lay out', type: 'select', def: 'tile', options: [['tile', 'Tile'], ['stretch', 'Stretch']] },
        { ...range('size', 'Size', 3, 300, 25, 1, ' mm'), when: (p) => p.layout !== 'stretch' },
        { ...range('zoom', 'Zoom', 100, 400, 100, 1, '%'), when: (p) => p.layout === 'stretch' },
        range('angle', 'Angle', -180, 180, 0, 1, '°'),
        range('moveX', 'Move across', -100, 100, 0, 0.5, ' mm'),
        range('moveY', 'Move down', -100, 100, 0, 0.5, ' mm'),
        { k: 'blend', label: 'Blend', type: 'select', def: 'multiply', options: [['multiply', 'Multiply'], ['overlay', 'Overlay'], ['soft-light', 'Soft light'], ['screen', 'Screen'], ['normal', 'Normal']] },
        range('contrast', 'Contrast', -100, 100, 0),
        range('brightness', 'Brightness', -100, 100, 0),
        { k: 'colour', label: 'Colour', type: 'select', def: 'own', options: [['own', 'Its own colours'], ['grey', 'Grey'], ['tint', 'Tint']] },
        { k: 'tint', label: 'Tint colour', type: 'colour', def: { c: 0, m: 35, y: 70, k: 25 }, when: (p) => p.colour === 'tint' },
        { k: 'invert', label: 'Invert', type: 'toggle', def: false },
        { k: 'mirror', label: 'Mirror tiles', type: 'toggle', def: false, when: (p) => p.layout !== 'stretch' },
        { k: 'seed', label: 'Variation', type: 'shuffle', def: 1, when: (p) => !p.tex || p.tex.kind === 'preset' },
      ],
      run(d, w, h, p, env) {
        const ppm = env.pxPerMm;
        const tile = Math.max(2, p.size * ppm);
        const want = p.layout === 'stretch' ? (Math.max(w, h) * p.zoom) / 100 : tile;
        const src = env.texture && env.texture(p.tex, want, p.seed);
        if (!src || !src.img) return;
        const img = src.img;
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        // Lay the texture out on a canvas the size of the photo.
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.translate(w / 2 + p.moveX * ppm, h / 2 + p.moveY * ppm);
        g.rotate((p.angle * Math.PI) / 180);
        if (p.layout === 'stretch') {
          const s = Math.max(w / iw, h / ih) * (p.zoom / 100);
          g.drawImage(img, (-iw * s) / 2, (-ih * s) / 2, iw * s, ih * s);
        } else {
          const pat = g.createPattern(p.mirror ? mirrored(img) : img, 'repeat');
          pat.setTransform(new DOMMatrix().scaleSelf(tile / iw, tile / ih));
          g.fillStyle = pat;
          const R = Math.hypot(w, h) + Math.abs(p.moveX * ppm) + Math.abs(p.moveY * ppm);
          g.fillRect(-R, -R, 2 * R, 2 * R);
        }
        const t = g.getImageData(0, 0, w, h).data;
        // The texture's own look: contrast, brightness, invert, then grey or tint.
        const C = p.contrast * 2.55, cf = (259 * (C + 255)) / (255 * (259 - C)), B = p.brightness * 1.28;
        const look = lutOf((v) => {
          const x = (v - 128) * cf + 128 + B;
          return p.invert ? 255 - clamp8(x) : x;
        });
        const tint = p.colour === 'tint' ? env.color(p.tint) : null;
        const mode = p.blend;
        const mix = (b, x) => {
          if (mode === 'multiply') return (b * x) / 255;
          if (mode === 'screen') return 255 - ((255 - b) * (255 - x)) / 255;
          if (mode === 'overlay') return b < 128 ? (2 * b * x) / 255 : 255 - (2 * (255 - b) * (255 - x)) / 255;
          if (mode === 'soft-light') {
            const bb = b / 255, xx = x / 255;
            return 255 * ((1 - 2 * xx) * bb * bb + 2 * xx * bb);
          }
          return x;
        };
        for (let i = 0; i < d.length; i += 4) {
          const a = t[i + 3] / 255;
          if (!a) continue;
          let r = t[i], gg = t[i + 1], b = t[i + 2];
          if (p.colour !== 'own') r = gg = b = lum(r, gg, b);
          r = look[r | 0];
          gg = look[gg | 0];
          b = look[b | 0];
          if (tint) {
            const L = r / 255;
            r = tint[0] + (255 - tint[0]) * L;
            gg = tint[1] + (255 - tint[1]) * L;
            b = tint[2] + (255 - tint[2]) * L;
          }
          d[i] = d[i] + (mix(d[i], r) - d[i]) * a;
          d[i + 1] = d[i + 1] + (mix(d[i + 1], gg) - d[i + 1]) * a;
          d[i + 2] = d[i + 2] + (mix(d[i + 2], b) - d[i + 2]) * a;
        }
      },
    },

    /* ----- Shape and blending ----- */
    flip_rotate: {
      name: 'Flip and rotate', group: 'Shape and blending', geometric: true,
      params: [{ k: 'flipH', label: 'Flip left to right', type: 'toggle', def: true }, { k: 'flipV', label: 'Flip top to bottom', type: 'toggle', def: false }, { k: 'rotate', label: 'Turn', type: 'select', def: '0', options: [['0', 'No turn'], ['90', '90° clockwise'], ['180', '180°'], ['270', '90° anticlockwise']] }],
    },
    fade_edges: {
      name: 'Fade edges', group: 'Shape and blending', frame: true,
      params: [range('width', 'Fade', 0.5, 40, 6, 0.5, ' mm')],
    },
    blend_mode: {
      name: 'Blend mode', group: 'Shape and blending', frame: true,
      params: [{ k: 'mode', label: 'Blend', type: 'select', def: 'multiply', options: [['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'Colour dodge'], ['color-burn', 'Colour burn'], ['hard-light', 'Hard light'], ['soft-light', 'Soft light'], ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Colour'], ['luminosity', 'Luminosity']] }],
    },
    // Remove background: a mask (white keeps, black removes) makes parts of the photo see-through.
    // The mask is the caller's, from env.mask(ref) -> a picture the size of the original photo,
    // unturned (it's turned and flipped here with the photo). No mask yet: nothing is removed.
    cutout: {
      name: 'Remove background', group: 'Shape and blending', alpha: true, first: true, makesAlpha: (p) => !!p.mask,
      params: [
        { k: 'mask', label: 'Mask', type: 'mask', def: null },
        range('soften', 'Soften edge', 0, 3, 0.2, 0.05, ' mm'),
        range('tighten', 'Tighten edge', 0, 100, 0, 1, '%'),
      ],
      run(d, w, h, p, env) {
        const m = p.mask && env.mask && env.mask(p.mask);
        if (!m) return;
        const mc = document.createElement('canvas');
        mc.width = w;
        mc.height = h;
        const g = mc.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        const geo = env.geo || { rotate: 0, flipH: false, flipV: false };
        const turned = geo.rotate === 90 || geo.rotate === 270;
        const tw = turned ? h : w, th = turned ? w : h;
        const soft = p.soften * env.pxPerMm;
        if (soft > 0.3) g.filter = `blur(${(soft / 2).toFixed(2)}px)`;
        g.translate(w / 2, h / 2);
        g.rotate((geo.rotate * Math.PI) / 180);
        g.scale(geo.flipH ? -1 : 1, geo.flipV ? -1 : 1);
        g.drawImage(m, -tw / 2, -th / 2, tw, th);
        const md = g.getImageData(0, 0, w, h).data;
        // Tighten: pulls the edge in, so a halo of the old background goes.
        const t = (p.tighten / 100) * 0.8;
        for (let i = 0; i < d.length; i += 4) {
          let a = md[i] / 255;
          if (t > 0) a = Math.max(0, (a - t) / (1 - t));
          d[i + 3] = d[i + 3] * a;
        }
      },
    },
    drop_shadow: {
      name: 'Drop shadow', group: 'Shape and blending', frame: true,
      params: [range('distance', 'Distance', 0, 30, 2.5, 0.1, ' mm'), range('angle', 'Angle', 0, 359, 135, 1, '°'), range('softness', 'Softness', 0, 30, 3, 0.1, ' mm'), range('opacity', 'Strength', 0, 100, 45, 1, '%'), { k: 'colour', label: 'Colour', type: 'colour', def: { c: 0, m: 0, y: 0, k: 100 } }],
    },
  };
  const GROUPS = ['Light', 'Colour', 'Detail and look', 'Shape and blending'];

  /* ---------- effects lists ---------- */
  let n = 0;
  function make(type) {
    const t = TYPES[type];
    const p = {};
    for (const q of t.params) p[q.k] = JSON.parse(JSON.stringify(q.def));
    return { id: 'fx' + Date.now().toString(36) + (n++).toString(36), type, on: true, strength: t.defStrength ?? 100, p };
  }
  const active = (effects) => (effects || []).filter((e) => e && e.on && TYPES[e.type]);
  const hasPixelWork = (effects) => active(effects).some((e) => !TYPES[e.type].frame);
  // Does the picture come out with see-through parts (a removed background)?
  const hasAlpha = (effects) => active(effects).some((e) => TYPES[e.type].makesAlpha && TYPES[e.type].makesAlpha({ ...e.p }) && (e.strength ?? 100) > 0);
  // Remove background always comes first (after flip and rotate), so the other effects work on the
  // cut-out: Blur softens its outline, whatever order the list is in.
  const inOrder = (effects) => [...(effects || [])].sort((a, b) => (TYPES[b.type]?.first ? 1 : 0) - (TYPES[a.type]?.first ? 1 : 0));
  // Width and height after any turn of 90° or 270°.
  function geometry(effects) {
    const g = active(effects).find((e) => e.type === 'flip_rotate');
    return g ? { flipH: !!g.p.flipH, flipV: !!g.p.flipV, rotate: +g.p.rotate || 0 } : { flipH: false, flipV: false, rotate: 0 };
  }
  function outSize(w, h, effects) {
    const r = geometry(effects).rotate;
    return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
  }
  // The frame effects that are on, ready for the page drawing to use.
  function frameEffects(effects) {
    const out = {};
    for (const e of active(effects)) {
      if (e.type === 'fade_edges') out.fade = e.p;
      if (e.type === 'blend_mode') out.blend = e.p.mode;
      if (e.type === 'drop_shadow') out.shadow = e.p;
    }
    return out;
  }

  /* ---------- rendering ---------- */
  // The picture with its geometric and pixel effects, at `scale` × the source's size.
  // env: { pxPerMm: source pixels per mm on the page, color(ref) -> [r, g, b], seed }
  // texture(ref, pixels, seed) -> { img, tiles } or null: where Texture effects get their pictures.
  function render(source, effects, { scale = 1, pxPerMm = 12, color = () => [0, 0, 0], seed = 1, texture = null, mask = null } = {}) {
    const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
    const g = geometry(effects);
    const tw = Math.max(1, Math.round(sw * scale)), th = Math.max(1, Math.round(sh * scale));
    const turned = g.rotate === 90 || g.rotate === 270;
    const c = document.createElement('canvas');
    c.width = turned ? th : tw;
    c.height = turned ? tw : th;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((g.rotate * Math.PI) / 180);
    ctx.scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1);
    ctx.drawImage(source, -tw / 2, -th / 2, tw, th);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const list = inOrder(active(effects)).filter((e) => !TYPES[e.type].frame && !TYPES[e.type].geometric);
    if (!list.length) return c;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    const env = { pxPerMm: pxPerMm * scale, color, seed, texture, mask, geo: g };
    for (const e of list) {
      const t = TYPES[e.type];
      const p = { ...Object.fromEntries(t.params.map((q) => [q.k, q.def])), ...e.p };
      const k = Math.max(0, Math.min(1, (e.strength ?? 100) / 100));
      if (k <= 0) continue;
      const before = k < 1 ? new Uint8ClampedArray(d) : null;
      t.run(d, c.width, c.height, p, env);
      // Strength mixes the colours back (and see-through-ness, for effects that change it).
      const chs = t.alpha ? 4 : 3;
      if (before) for (let i = 0; i < d.length; i += 4) for (let ch = 0; ch < chs; ch++) d[i + ch] = before[i + ch] + (d[i + ch] - before[i + ch]) * k;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  // How many pixels of each brightness (256 bins), for Levels and Curves.
  function histogram(canvas) {
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    const bins = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) bins[lum(d[i], d[i + 1], d[i + 2]) | 0]++;
    return bins;
  }

  return { TYPES, GROUPS, make, active, hasPixelWork, hasAlpha, inOrder, geometry, outSize, frameEffects, render, histogram, curveLut };
})();
if (typeof module !== 'undefined') module.exports = PhotoFX;
