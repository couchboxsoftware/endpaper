/* Textures drawn by code: paper, canvas, linen and the rest. Every one repeats seamlessly, because
   it's made from noise that wraps around at the tile's edges, so a tile can repeat forever with no
   join. Each is drawn at whatever size is asked for (a small swatch, or print resolution), and a
   seed gives a fresh variation of the same texture.

   Also here: seamless(image), which guesses whether any picture repeats without a visible join
   (its opposite edges match about as well as neighbouring pixels do).

   This file knows nothing about Endpaper, so it can move to another app with photofx.js. */
const TextureGen = (() => {
  // id, name, a sensible tile size in mm, and an optional warm tint (r, g, b multipliers).
  const PRESETS = [
    { id: 'paper', name: 'Fine paper', mm: 60 },
    { id: 'watercolour', name: 'Watercolour paper', mm: 80 },
    { id: 'canvas', name: 'Canvas', mm: 25 },
    { id: 'linen', name: 'Linen', mm: 30 },
    { id: 'kraft', name: 'Kraft card', mm: 60, tint: [1, 0.86, 0.66] },
    { id: 'specks', name: 'Recycled specks', mm: 50 },
    { id: 'crumpled', name: 'Crumpled paper', mm: 120 },
    { id: 'concrete', name: 'Concrete', mm: 60 },
    { id: 'grunge', name: 'Grunge', mm: 120 },
    { id: 'dust', name: 'Film dust', mm: 80 },
    { id: 'wood', name: 'Wood grain', mm: 120, tint: [1, 0.85, 0.68] },
  ];
  const byId = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

  /* ---------- noise that wraps around ---------- */
  function hash(x, y, s) {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  const sm = (t) => t * t * (3 - 2 * t);
  const wrap = (i, p) => ((i % p) + p) % p;
  // Value noise on a grid of px × py cells that repeats every px cells across and py down.
  function pnoise(x, y, px, py, s) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = sm(x - ix), fy = sm(y - iy);
    const x0 = wrap(ix, px), x1 = wrap(ix + 1, px), y0 = wrap(iy, py), y1 = wrap(iy + 1, py);
    const a = hash(x0, y0, s), b = hash(x1, y0, s), c = hash(x0, y1, s), d = hash(x1, y1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  // u, v from 0 to 1 across the tile. p cells for the first layer, doubling each layer.
  function fbm(u, v, p, layers, s) {
    let sum = 0, amp = 0.5, total = 0;
    for (let i = 0; i < layers; i++) {
      const q = p << i;
      sum += amp * pnoise(u * q, v * q, q, q, s + i * 101);
      total += amp;
      amp *= 0.5;
    }
    return sum / total;
  }
  const n2 = (u, v, px, py, s) => pnoise(u * px, v * py, px, py, s);

  // Each preset: the grey level (0–255) at u, v. N is the tile's size in pixels, s the seed.
  const SHADE = {
    paper: (u, v, s, N, x, y) => 238 + (fbm(u, v, 12, 4, s) - 0.5) * 26 + (hash(x, y, s + 7) - 0.5) * 9,
    watercolour: (u, v, s) => 232 + (fbm(u, v, 10, 5, s) - 0.5) * 70 - Math.pow(Math.abs(fbm(u, v, 24, 3, s + 9) - 0.5) * 2, 3) * 34,
    canvas: (u, v, s) => {
      const T = 48;
      const a = Math.sin(2 * Math.PI * u * T);
      return 222 + a * Math.sin(2 * Math.PI * v * T + a * 0.4) * 16 + (fbm(u, v, 16, 3, s) - 0.5) * 30;
    },
    linen: (u, v, s, N, x, y) => 226 + (n2(u, v, 6, 160, s) - 0.5) * 40 + (n2(u, v, 160, 6, s + 3) - 0.5) * 40 + (hash(x, y, s + 5) - 0.5) * 8,
    kraft: (u, v, s) => 196 + (n2(u, v, 300, 20, s) - 0.5) * 34 + (fbm(u, v, 10, 3, s + 4) - 0.5) * 24,
    specks: (u, v, s) => 241 + (n2(u, v, 300, 40, s) - 0.5) * 14,
    crumpled: (u, v, s) => 175 + (1 - Math.abs(2 * fbm(u, v, 6, 5, s) - 1)) * 70,
    concrete: (u, v, s, N, x, y) => 200 + (fbm(u, v, 20, 5, s) - 0.5) * 70 - (hash(x >> 1, y >> 1, s + 11) > 0.985 ? 60 : 0),
    grunge: (u, v, s, N, x, y) => {
      const f = fbm(u, v, 6, 5, s);
      return f > 0.56 ? 150 + fbm(u, v, 40, 3, s + 2) * 60 : 236 + (hash(x, y, s + 3) - 0.5) * 10;
    },
    dust: () => 250,
    wood: (u, v, s) => {
      const rings = Math.sin(2 * Math.PI * (v * 14 + fbm(u, v, 3, 4, s) * 2.2));
      return 205 + rings * 24 + (n2(u, v, 20, 300, s + 6) - 0.5) * 14;
    },
  };

  // Marks drawn on top (specks, dust, scratches), each repeated across the edges so they wrap too.
  function marks(id, g, N, s) {
    let seed = (s * 9301 + 49297) % 233280 || 1;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const k = N / 512; // marks keep their size relative to the tile
    const wrapped = (fn) => {
      for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
        g.save();
        g.translate(dx, dy);
        fn();
        g.restore();
      }
    };
    const dots = (count, colour, rMin, rMax) => {
      const list = Array.from({ length: count }, () => [r() * N, r() * N, (rMin + r() * (rMax - rMin)) * k, 0.25 + r() * 0.6]);
      wrapped(() => {
        for (const [x, y, rad, a] of list) {
          g.fillStyle = `rgba(${colour},${a})`;
          g.beginPath();
          g.arc(x, y, Math.max(0.3, rad), 0, Math.PI * 2);
          g.fill();
        }
      });
    };
    const lines = (count, colour, width, reach) => {
      const list = Array.from({ length: count }, () => {
        const x = r() * N, y = r() * N, a = reach * k;
        return [x, y, x + (r() - 0.5) * a, y + (r() - 0.5) * a, x + (r() - 0.5) * a * 1.5, y + (r() - 0.5) * a * 1.5, x + (r() - 0.5) * a * 2, y + (r() - 0.5) * a * 2];
      });
      g.strokeStyle = colour;
      g.lineWidth = Math.max(0.4, width * k);
      wrapped(() => {
        for (const [x, y, ...c] of list) {
          g.beginPath();
          g.moveTo(x, y);
          g.bezierCurveTo(...c);
          g.stroke();
        }
      });
    };
    if (id === 'specks') dots(900, '60,50,40', 0.4, 1.6);
    if (id === 'dust') {
      dots(520, '30,30,30', 0.3, 1.8);
      lines(14, 'rgba(40,40,40,0.45)', 0.7, 170);
    }
    if (id === 'grunge') lines(40, 'rgba(60,60,60,0.35)', 0.6, 60);
  }

  /* ---------- making a tile ---------- */
  const cache = new Map();
  // A square tile, size × size pixels. Kept, so asking again is instant.
  function make(id, { size = 512, seed = 1 } = {}) {
    const pre = byId[id];
    if (!pre) return null;
    const N = Math.max(16, Math.round(size));
    const key = `${id}|${N}|${seed}`;
    if (cache.has(key)) {
      const c = cache.get(key);
      cache.delete(key);
      cache.set(key, c);
      return c;
    }
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    const im = g.createImageData(N, N);
    const d = im.data, f = SHADE[id], t = pre.tint || [1, 1, 1];
    const s = (seed | 0) * 7919 + id.length * 131;
    for (let y = 0; y < N; y++) {
      const v = y / N;
      for (let x = 0; x < N; x++) {
        const val = f(x / N, v, s, N, x, y);
        const i = (y * N + x) * 4;
        d[i] = val * t[0];
        d[i + 1] = val * t[1];
        d[i + 2] = val * t[2];
        d[i + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
    marks(id, g, N, s);
    cache.set(key, c);
    if (cache.size > 24) cache.delete(cache.keys().next().value);
    return c;
  }

  /* ---------- does a picture repeat? ---------- */
  // Compares the left edge with the right and the top with the bottom, against how much
  // neighbouring pixels usually differ inside the picture. Works on a copy no bigger than 256 px.
  function seamless(img) {
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const k = Math.min(1, 256 / Math.max(w0, h0));
    const w = Math.max(8, Math.round(w0 * k)), h = Math.max(8, Math.round(h0 * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const L = (x, y) => {
      const i = (y * w + x) * 4;
      return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    };
    const colDiff = (a, b) => {
      let s = 0;
      for (let y = 0; y < h; y++) s += Math.abs(L(a, y) - L(b, y));
      return s / h;
    };
    const rowDiff = (a, b) => {
      let s = 0;
      for (let x = 0; x < w; x++) s += Math.abs(L(x, a) - L(x, b));
      return s / w;
    };
    // How different neighbours are inside the picture, across and down separately (a texture can
    // be streaky one way and smooth the other), from several places.
    const spots = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
    let across = 0, down = 0;
    for (const f of spots) {
      const x = Math.floor(f * (w - 2)), y = Math.floor(f * (h - 2));
      across += colDiff(x, x + 1);
      down += rowDiff(y, y + 1);
    }
    across /= spots.length;
    down /= spots.length;
    return colDiff(w - 1, 0) <= across * 1.6 + 3 && rowDiff(h - 1, 0) <= down * 1.6 + 3;
  }

  return { PRESETS, get: (id) => byId[id] || null, make, seamless };
})();
if (typeof module !== 'undefined') module.exports = TextureGen;
