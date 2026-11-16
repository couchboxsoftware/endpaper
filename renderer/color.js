/* Colour: LittleCMS (lcms-wasm) with the chosen CMYK printing profile, Coated FOGRA39 by default.
   - CMYK → screen: how a CMYK colour will look printed (a soft proof), for the editor.
   - Photo RGB → CMYK: done on export, so the PDF holds real CMYK pixels. */
const Color = (() => {
  let L = null; // lcms module
  let toScreen = 0; // CMYK_8 -> RGB_8
  let toCmyk = 0; // RGB_8 -> CMYK_8
  let profileName = '';
  let profileBytes = null;
  const cache = new Map();

  async function init(bytes, intent = 'relative', name = '') {
    if (!L) {
      const mod = await import('../node_modules/lcms-wasm/dist/lcms.js');
      L = await mod.instantiate({ locateFile: () => new URL('../node_modules/lcms-wasm/dist/lcms.wasm', location.href).href });
      L.K = mod;
    }
    if (toScreen) L.cmsDeleteTransform(toScreen);
    if (toCmyk) L.cmsDeleteTransform(toCmyk);
    toScreen = toCmyk = 0;
    cache.clear();
    profileBytes = bytes || null;
    profileName = name;
    if (!bytes) return false;
    const K = L.K;
    const srgb = L.cmsCreate_sRGBProfile();
    const cmyk = L.cmsOpenProfileFromMem(bytes, bytes.byteLength);
    if (!cmyk) return false;
    const it = intent === 'perceptual' ? K.INTENT_PERCEPTUAL : K.INTENT_RELATIVE_COLORIMETRIC;
    const bpc = K.cmsFLAGS_BLACKPOINTCOMPENSATION;
    toScreen = L.cmsCreateTransform(cmyk, K.TYPE_CMYK_8, srgb, K.TYPE_RGB_8, K.INTENT_RELATIVE_COLORIMETRIC, bpc);
    toCmyk = L.cmsCreateTransform(srgb, K.TYPE_RGB_8, cmyk, K.TYPE_CMYK_8, it, bpc);
    profileName = name || L.cmsGetProfileInfoASCII(cmyk, K.cmsInfoDescription, 'en', 'US');
    return true;
  }

  // CMYK (0-100) → [r, g, b] for the screen.
  function rgb(c) {
    if (!c) return null;
    const key = `${c.c}|${c.m}|${c.y}|${c.k}`;
    let v = cache.get(key);
    if (v) return v;
    if (toScreen) {
      const out = L.cmsDoTransform(toScreen, new Uint8Array([c.c * 2.55, c.m * 2.55, c.y * 2.55, c.k * 2.55].map(Math.round)), 1);
      v = [out[0], out[1], out[2]];
    } else {
      const k = 1 - c.k / 100;
      v = [255 * (1 - c.c / 100) * k, 255 * (1 - c.m / 100) * k, 255 * (1 - c.y / 100) * k].map(Math.round);
    }
    cache.set(key, v);
    return v;
  }
  const css = (c, alpha = 1) => {
    const v = rgb(c);
    if (!v) return 'transparent';
    return alpha < 1 ? `rgba(${v[0]},${v[1]},${v[2]},${alpha})` : `rgb(${v[0]},${v[1]},${v[2]})`;
  };
  const hex = (c) => '#' + rgb(c).map((n) => n.toString(16).padStart(2, '0')).join('');

  // A screen colour (#rrggbb) → the nearest CMYK the profile can print (for the colour picker).
  function fromHex(h) {
    const n = parseInt(h.slice(1), 16);
    const px = new Uint8Array([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
    let o;
    if (toCmyk) o = L.cmsDoTransform(toCmyk, px, 1);
    else {
      const r = px[0] / 255, g = px[1] / 255, b = px[2] / 255;
      const k = 1 - Math.max(r, g, b);
      o = k >= 1 ? [0, 0, 0, 255] : [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k].map((x) => x * 255);
    }
    const p = (x) => Math.round((x / 255) * 100);
    return { c: p(o[0]), m: p(o[1]), y: p(o[2]), k: p(o[3]) };
  }

  // RGBA pixels → { cmyk (4 bytes a pixel, 255 = full ink), alpha (or null when fully opaque) }.
  function imageToCmyk(rgba, w, h) {
    const n = w * h;
    const cmyk = new Uint8Array(n * 4);
    let alpha = null;
    for (let i = 0; i < n; i++)
      if (rgba[i * 4 + 3] !== 255) {
        alpha = new Uint8Array(n);
        for (let j = 0; j < n; j++) alpha[j] = rgba[j * 4 + 3];
        break;
      }
    const CH = 1 << 20;
    const rgb = new Uint8Array(Math.min(n, CH) * 3);
    for (let start = 0; start < n; start += CH) {
      const len = Math.min(CH, n - start);
      for (let i = 0; i < len; i++) {
        const s = (start + i) * 4;
        rgb[i * 3] = rgba[s];
        rgb[i * 3 + 1] = rgba[s + 1];
        rgb[i * 3 + 2] = rgba[s + 2];
      }
      if (toCmyk) {
        const out = L.cmsDoTransform(toCmyk, rgb.subarray(0, len * 3), len);
        cmyk.set(out.subarray(0, len * 4), start * 4);
      } else
        for (let i = 0; i < len; i++) {
          const r = rgb[i * 3] / 255, g = rgb[i * 3 + 1] / 255, b = rgb[i * 3 + 2] / 255;
          const k = 1 - Math.max(r, g, b);
          const o = (start + i) * 4;
          if (k < 1) {
            cmyk[o] = ((1 - r - k) / (1 - k)) * 255;
            cmyk[o + 1] = ((1 - g - k) / (1 - k)) * 255;
            cmyk[o + 2] = ((1 - b - k) / (1 - k)) * 255;
          }
          cmyk[o + 3] = k * 255;
        }
    }
    return { cmyk, alpha };
  }

  return { init, rgb, css, hex, fromHex, imageToCmyk, get profileName() { return profileName; }, get profileBytes() { return profileBytes; }, get ready() { return !!toCmyk; } };
})();
