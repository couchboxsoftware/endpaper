/* The start-up splash: an open book. The left page has the logo and how loading is going; the
   right page typesets a little layout. main.js calls step() as each piece loads, then finish()
   once Endpaper is ready: the page turns to an empty page and the splash fades. */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- the logo draws itself on ---------- */
  const mark = $('mark');
  for (const d of [BRAND.paths.left, BRAND.paths.right, BRAND.paths.spine]) el('path', { d, pathLength: 1, class: 'draw' }, mark);
  document.querySelectorAll('.draw').forEach((p) =>
    p.addEventListener('animationend', () => {
      // Drop the dash trick once drawn, so there's no seam at the join.
      p.style.animation = 'none';
      p.style.strokeDasharray = 'none';
      p.style.strokeDashoffset = '0';
    })
  );
  const v = new URLSearchParams(location.search).get('v');
  if (v) $('ver').textContent = 'Version ' + v;

  /* ---------- progress: CMYK patches light up, the ribbon drops ---------- */
  const TOTAL = 6; // splash up, settings, fonts, brand kit, colour, ready
  let done = 0;
  let ribbon = 0; // shown length, eases towards the target
  const RIBBON_MAX = 22;
  const patches = [...document.querySelectorAll('.patch')];
  const show = () => patches.forEach((p, i) => p.classList.toggle('on', i < done - 1 || done >= TOTAL));
  window.step = () => {
    done = Math.min(TOTAL - 1, done + 1);
    show();
  };
  // Endpaper is ready: once the page has been up long enough, turn it to an empty page, fade
  // out, then resolve (main.js waits for this before showing the app).
  let ending = null;
  window.finish = () => {
    done = TOTAL;
    show();
    if (!ending) ending = new Promise((resolve) => (endResolve = resolve));
    return ending;
  };
  let endResolve = null;
  function drawRibbon() {
    const target = 4 + (RIBBON_MAX - 4) * (done / TOTAL);
    ribbon += (target - ribbon) * 0.12;
    const y = 174 + ribbon;
    $('ribbon').setAttribute('d', `M156 174H164V${y.toFixed(2)}L160 ${(y - 3.5).toFixed(2)}L156 ${y.toFixed(2)}Z`);
  }

  /* ---------- the right page typesets a layout ---------- */
  const content = $('content');
  const defs = document.querySelector('defs');
  const INK = ['#00A0E3', '#E4007C', '#FFE600', '#7a3cff', '#00b388', '#ff7a1a'];
  let gid = 0;

  function picture(x, y, w, h, delay) {
    const id = 'g' + ++gid;
    const [a, b] = [pick(INK), pick(INK)];
    const g = el('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    el('stop', { offset: 0, 'stop-color': a }, g);
    el('stop', { offset: 1, 'stop-color': b }, g);
    const grp = el('g', { class: 'pic', style: `animation-delay:${delay}s` }, content);
    el('rect', { x, y, width: w, height: h, rx: 1, fill: `url(#${id})` }, grp);
    // a sun and some hills, so it reads as a photo
    el('circle', { cx: x + w * rand(0.6, 0.85), cy: y + h * 0.32, r: h * 0.14, fill: '#fff', 'fill-opacity': 0.55 }, grp);
    const hill = (lift, op) => {
      let d = `M${x} ${y + h}`;
      for (let i = 0; i <= 6; i++) d += `L${(x + (w * i) / 6).toFixed(1)} ${(y + h * lift + Math.sin(i * rand(0.8, 1.4) + gid) * h * 0.12).toFixed(1)}`;
      el('path', { d: d + `L${x + w} ${y + h}Z`, fill: '#000', 'fill-opacity': op }, grp);
    };
    hill(0.62, 0.22);
    hill(0.8, 0.3);
    el('rect', { x, y, width: w, height: h, fill: 'url(#dots)' }, grp);
    return delay + 0.35;
  }
  function lines(y, n, delay, { width = 94, gap = 6.2, colour = '#5d5967', weight = 1.6 } = {}) {
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const w = last ? rand(width * 0.3, width * 0.65) : rand(width * 0.88, width);
      el('path', { d: `M176 ${y + i * gap}h${w.toFixed(1)}`, stroke: colour, 'stroke-width': weight, 'stroke-linecap': 'round', fill: 'none', pathLength: 1, class: 'set', style: `animation-delay:${(delay + i * 0.07).toFixed(2)}s` }, content);
    }
    return delay + n * 0.07 + 0.2;
  }
  function heading(y, delay) {
    el('path', { d: `M176 ${y}h${rand(46, 74).toFixed(1)}`, stroke: pick(['#f2f0f5', '#E4007C']), 'stroke-width': 3.6, 'stroke-linecap': 'round', fill: 'none', pathLength: 1, class: 'set', style: `animation-delay:${delay}s` }, content);
    return delay + 0.25;
  }
  const LAYOUTS = [
    (d) => { d = heading(56, d); d = picture(176, 64, 94, 40, d); lines(114, 6, d); },
    (d) => { d = lines(54, 4, d); d = picture(176, 80, 94, 34, d); lines(124, 4, d); },
    (d) => { d = picture(176, 52, 94, 52, d); d = heading(114, d); lines(124, 4, d); },
    (d) => { d = heading(56, d); d = lines(66, 3, d); d = picture(176, 88, 44, 30, d); picture(226, 88, 44, 30, d - 0.2); lines(128, 4, d); },
  ];
  let lastLayout = -1;
  function typeset(delay) {
    content.classList.remove('away');
    content.replaceChildren();
    while (defs.querySelectorAll('linearGradient[id^="g"]').length > 6) defs.querySelector('linearGradient[id^="g"]').remove();
    let i;
    do i = Math.floor(Math.random() * LAYOUTS.length);
    while (i === lastLayout);
    lastLayout = i;
    LAYOUTS[i](delay);
  }

  /* ---------- turning the page ---------- */
  // The right page swings over the spine to the left: its free edge follows cos(), lifting as it goes.
  const turnPage = $('turn-page');
  const turnSheen = $('turn-sheen');
  function pagePath(c, lift) {
    const X = (dx) => (160 + dx * c).toFixed(2);
    return `M160 46C${X(30)} ${30 - lift * 0.3} ${X(80)} ${28 - lift} ${X(124)} ${36 - lift}V${162 - lift}C${X(80)} ${154 - lift} ${X(30)} ${156 - lift * 0.3} 160 172Z`;
  }
  const FIRST = 0.75; // the book has opened; the first layout starts setting
  const HOLD = 3; // the page stays at least this long (seconds from the start) before it turns
  const TURN = 0.95; // time to turn the page
  const REST = 0.3; // a beat on the empty page before fading
  const FADE = 0.38; // matches body.out in splash.html
  let started = null;
  let turnAt = null; // when the final turn began
  typeset(FIRST);

  function drawTurn(p) {
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // ease in and out
    const c = Math.cos(Math.PI * e);
    const lift = Math.sin(Math.PI * e) * 7;
    const d = pagePath(c, lift);
    turnPage.setAttribute('d', d);
    turnSheen.setAttribute('d', d);
    // The back of the page catches the light mid-turn, then settles as it lands on the left,
    // covering the logo: both pages are blank.
    turnPage.setAttribute('fill', c >= 0 || p > 0.9 ? '#1d1c22' : '#24222a');
    turnSheen.setAttribute('opacity', (1 - Math.abs(c)).toFixed(2));
  }
  function end() {
    document.body.classList.add('out');
    setTimeout(() => endResolve && endResolve(true), FADE * 1000);
  }

  // The page waits as long as Endpaper needs. Once it's ready (finish) and the page has been up
  // for HOLD seconds, it turns over to an empty page, rests a beat, then the splash fades away.
  function frame(now) {
    if (started == null) started = now;
    const t = (now - started) / 1000;
    drawRibbon();
    if (ending && turnAt == null && t >= HOLD) {
      turnAt = t;
      content.classList.add('away'); // the layout goes over with the page
      if (still) {
        content.replaceChildren();
        return end();
      }
    }
    if (turnAt != null) {
      const p = (t - turnAt) / TURN;
      if (p < 1) drawTurn(p);
      else {
        drawTurn(1); // the page lies flat on the left
        content.replaceChildren();
        return setTimeout(end, REST * 1000);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.step(); // the splash itself is up
})();
