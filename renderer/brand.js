/* Endpaper brand: the open-book mark in process magenta. One place for the logo, the accent
   and the wordmark; the app, the start screen and tools/render-icon.js all use it. */
const BRAND = (() => {
  const magenta = '#E4007C';
  // Open book on a 48x48 grid with round 3px strokes (the same drawing rules as Couchbox's sofa).
  const left = 'M24 15c-4.5-3-11-3.6-16-2v22c5-1.6 11.5-1 16 2';
  const right = 'M24 15c4.5-3 11-3.6 16-2v22c-5-1.6-11.5-1-16 2';
  const spine = 'M24 15v22';
  const bookPaths = (stroke, width, extra = '') =>
    `<g fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}>` +
    `<path d="${left}" pathLength="1"/><path d="${right}" pathLength="1"/><path d="${spine}" pathLength="1"/></g>`;
  return {
    magenta,
    paths: { left, right, spine },
    bookPaths,
    icon: `<svg viewBox="5 9 38 31" aria-hidden="true" class="ep-icon">${bookPaths(magenta, 3)}</svg>`,
    tile: (size) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">` +
      `<rect x="1" y="1" width="46" height="46" rx="11" fill="#141414"/>` +
      `<g transform="translate(24 26) scale(0.86) translate(-24 -26)">${bookPaths(magenta, 3.4)}</g></svg>`,
    wordmark: '<span class="ep-word">end<b>paper</b></span>',
  };
})();
if (typeof module !== 'undefined') module.exports = BRAND;
