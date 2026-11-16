/* A baseline JPEG encoder for CMYK pixels, so photos in the PDF are real CMYK but still small.
   Written the way Photoshop writes CMYK JPEGs: an Adobe marker, no colour transform, and the
   values stored inverted, which the PDF undoes with /Decode [1 0 1 0 1 0 1 0].
   Based on the public-domain AAN DCT and the standard tables from the JPEG spec (Annex K). */
const CmykJpeg = (() => {
  const ZZ = [0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63];
  const Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  const DC_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const AC_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
  const AC_VALS = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ];
  const AASF = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

  function huff(bits, vals) {
    const t = [];
    let code = 0;
    let p = 0;
    for (let k = 1; k <= 16; k++) {
      for (let j = 0; j < bits[k]; j++) t[vals[p++]] = [code++, k];
      code *= 2;
    }
    return t;
  }
  const HDC = huff(DC_BITS, DC_VALS);
  const HAC = huff(AC_BITS, AC_VALS);
  const CAT = new Int32Array(65535);
  const BIT = new Array(65535);
  (() => {
    let lo = 1;
    let hi = 2;
    for (let cat = 1; cat <= 15; cat++) {
      for (let n = lo; n < hi; n++) {
        CAT[32767 + n] = cat;
        BIT[32767 + n] = [n, cat];
      }
      for (let n = -(hi - 1); n <= -lo; n++) {
        CAT[32767 + n] = cat;
        BIT[32767 + n] = [hi - 1 + n, cat];
      }
      lo <<= 1;
      hi <<= 1;
    }
  })();

  function encode(cmyk, w, h, quality = 92) {
    quality = clamp(Math.round(quality), 1, 100);
    const sf = quality < 50 ? Math.floor(5000 / quality) : Math.floor(200 - quality * 2);
    const qt = new Array(64);
    for (let i = 0; i < 64; i++) qt[ZZ[i]] = clamp(Math.floor((Q[i] * sf + 50) / 100), 1, 255);
    const fdt = new Float64Array(64);
    for (let r = 0, k = 0; r < 8; r++) for (let c = 0; c < 8; c++, k++) fdt[k] = 1 / (qt[ZZ[k]] * AASF[r] * AASF[c] * 8);

    // Output buffer that grows.
    let buf = new Uint8Array(1 << 20);
    let len = 0;
    const byte = (b) => {
      if (len >= buf.length) {
        const nb = new Uint8Array(buf.length * 2);
        nb.set(buf);
        buf = nb;
      }
      buf[len++] = b;
    };
    const word = (v) => (byte((v >> 8) & 255), byte(v & 255));
    let bnew = 0;
    let bpos = 7;
    const bits = (bs) => {
      const v = bs[0];
      let p = bs[1] - 1;
      while (p >= 0) {
        if (v & (1 << p)) bnew |= 1 << bpos;
        p--;
        bpos--;
        if (bpos < 0) {
          if (bnew === 0xff) (byte(0xff), byte(0));
          else byte(bnew);
          bpos = 7;
          bnew = 0;
        }
      }
    };

    // Headers.
    word(0xffd8);
    word(0xffee); // Adobe: transform 0 (CMYK stored as is)
    word(14);
    [0x41, 0x64, 0x6f, 0x62, 0x65].forEach(byte);
    word(100);
    word(0);
    word(0);
    byte(0);
    word(0xffdb);
    word(67);
    byte(0);
    for (let i = 0; i < 64; i++) byte(qt[i]);
    word(0xffc0);
    word(8 + 4 * 3);
    byte(8);
    word(h);
    word(w);
    byte(4);
    for (let c = 1; c <= 4; c++) (byte(c), byte(0x11), byte(0));
    word(0xffc4);
    word(2 + 17 + DC_VALS.length + 17 + AC_VALS.length);
    byte(0x00);
    for (let i = 1; i <= 16; i++) byte(DC_BITS[i]);
    DC_VALS.forEach(byte);
    byte(0x10);
    for (let i = 1; i <= 16; i++) byte(AC_BITS[i]);
    AC_VALS.forEach(byte);
    word(0xffda);
    word(6 + 4 * 2);
    byte(4);
    for (let c = 1; c <= 4; c++) (byte(c), byte(0));
    byte(0);
    byte(63);
    byte(0);

    const data = new Float64Array(64);
    const outq = new Int32Array(64);
    const DU = new Int32Array(64);
    const dc = [0, 0, 0, 0];
    const EOB = HAC[0];
    const Z16 = HAC[0xf0];

    function block(comp, bx, by) {
      for (let y = 0; y < 8; y++) {
        const yy = Math.min(by + y, h - 1);
        for (let x = 0; x < 8; x++) {
          const xx = Math.min(bx + x, w - 1);
          data[y * 8 + x] = 255 - cmyk[(yy * w + xx) * 4 + comp] - 128; // inverted, Adobe style
        }
      }
      fdct();
      for (let j = 0; j < 64; j++) DU[ZZ[j]] = outq[j];
      const diff = DU[0] - dc[comp];
      dc[comp] = DU[0];
      if (diff === 0) bits(HDC[0]);
      else {
        bits(HDC[CAT[32767 + diff]]);
        bits(BIT[32767 + diff]);
      }
      let end = 63;
      while (end > 0 && DU[end] === 0) end--;
      if (end === 0) return bits(EOB);
      let i = 1;
      while (i <= end) {
        const start = i;
        while (DU[i] === 0 && i <= end) i++;
        let zeros = i - start;
        if (zeros >= 16) {
          for (let m = 1; m <= zeros >> 4; m++) bits(Z16);
          zeros &= 0xf;
        }
        const pos = 32767 + DU[i];
        bits(HAC[(zeros << 4) + CAT[pos]]);
        bits(BIT[pos]);
        i++;
      }
      if (end !== 63) bits(EOB);
    }

    function fdct() {
      const d = data;
      for (let o = 0; o < 64; o += 8) {
        const t0 = d[o] + d[o + 7], t7 = d[o] - d[o + 7];
        const t1 = d[o + 1] + d[o + 6], t6 = d[o + 1] - d[o + 6];
        const t2 = d[o + 2] + d[o + 5], t5 = d[o + 2] - d[o + 5];
        const t3 = d[o + 3] + d[o + 4], t4 = d[o + 3] - d[o + 4];
        let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
        d[o] = t10 + t11;
        d[o + 4] = t10 - t11;
        const z1 = (t12 + t13) * 0.707106781;
        d[o + 2] = t13 + z1;
        d[o + 6] = t13 - z1;
        t10 = t4 + t5;
        t11 = t5 + t6;
        t12 = t6 + t7;
        const z5 = (t10 - t12) * 0.382683433;
        const z2 = 0.5411961 * t10 + z5;
        const z4 = 1.306562965 * t12 + z5;
        const z3 = t11 * 0.707106781;
        const z11 = t7 + z3, z13 = t7 - z3;
        d[o + 5] = z13 + z2;
        d[o + 3] = z13 - z2;
        d[o + 1] = z11 + z4;
        d[o + 7] = z11 - z4;
      }
      for (let o = 0; o < 8; o++) {
        const t0 = d[o] + d[o + 56], t7 = d[o] - d[o + 56];
        const t1 = d[o + 8] + d[o + 48], t6 = d[o + 8] - d[o + 48];
        const t2 = d[o + 16] + d[o + 40], t5 = d[o + 16] - d[o + 40];
        const t3 = d[o + 24] + d[o + 32], t4 = d[o + 24] - d[o + 32];
        let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
        d[o] = t10 + t11;
        d[o + 32] = t10 - t11;
        const z1 = (t12 + t13) * 0.707106781;
        d[o + 16] = t13 + z1;
        d[o + 48] = t13 - z1;
        t10 = t4 + t5;
        t11 = t5 + t6;
        t12 = t6 + t7;
        const z5 = (t10 - t12) * 0.382683433;
        const z2 = 0.5411961 * t10 + z5;
        const z4 = 1.306562965 * t12 + z5;
        const z3 = t11 * 0.707106781;
        const z11 = t7 + z3, z13 = t7 - z3;
        d[o + 40] = z13 + z2;
        d[o + 24] = z13 - z2;
        d[o + 8] = z11 + z4;
        d[o + 56] = z11 - z4;
      }
      for (let i = 0; i < 64; i++) {
        const v = d[i] * fdt[i];
        outq[i] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0;
      }
    }

    for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) for (let c = 0; c < 4; c++) block(c, x, y);
    if (bpos >= 0) bits([(1 << (bpos + 1)) - 1, bpos + 1]);
    word(0xffd9);
    return buf.slice(0, len);
  }

  return { encode };
})();
if (typeof module !== 'undefined') module.exports = CmykJpeg;
