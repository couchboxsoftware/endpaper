/* Preview book (View, Preview book, Ctrl+Shift+P): the design as a real book you can open, page
   through and turn over to see its spine and back. Pages are drawn trimmed, as printed, by the
   same drawing as thumbnails and image export (Render.draw). Books with a cover only.

   How it moves: a turning page is cut into thin strips, each tilted a little more than the one
   before, so it bends like paper. Covers are stiff boards. The closed book is a solid block that
   turns sideways, stops on the spine, and carries on to the back. */
const BookView = (() => {
  const N = 36; // strips in a turning page (more = a smoother bend)
  const PAGE_BEND = 30; // how far a paper page curls mid-turn, in degrees
  const BAR = 64; // height of the bar along the bottom, px
  let root = null;
  let v = null; // everything about the open preview

  const available = (doc) => !!doc && !!doc.cover && doc.cover.enabled;
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- drawing the book's sides ---------- */
  // One surface drawn trimmed, at `s` pixels per mm, then cut to [x0, x0 + w] mm across.
  function drawPart(doc, surface, s, x0, w, { gutter } = {}) {
    const sz = Model.surfaceSize(doc, surface);
    const full = document.createElement('canvas');
    full.width = Math.max(1, Math.round(sz.w * s));
    full.height = Math.max(1, Math.round(sz.h * s));
    Render.draw(full.getContext('2d'), doc, surface, s, { bleed: false });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = full.height;
    const g = c.getContext('2d');
    g.drawImage(full, Math.round(x0 * s), 0, c.width, c.height, 0, 0, c.width, c.height);
    if (gutter) shadeGutter(g, c.width, c.height, gutter);
    return c.toDataURL('image/jpeg', 0.92);
  }
  // The shadow down the inner edge of a page, where it curves into the spine.
  function shadeGutter(g, w, h, side) {
    const d = w * 0.12;
    const gr = side === 'left' ? g.createLinearGradient(w, 0, w - d, 0) : g.createLinearGradient(0, 0, d, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.2)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    side === 'left' ? g.fillRect(w - d, 0, d, h) : g.fillRect(0, 0, d, h);
  }
  function blankPage(s, doc, side) {
    const c = document.createElement('canvas');
    c.width = Math.round(doc.w * s);
    c.height = Math.round(doc.h * s);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    shadeGutter(g, c.width, c.height, side);
    return c.toDataURL('image/jpeg', 0.92);
  }

  // The leaves of the book: each has a front (a right-hand page) and a back (the left-hand page
  // once it's turned). Pictures are drawn when first needed, so long books open quickly.
  function buildLeaves(doc, s) {
    const c = Model.cover(doc);
    const outside = { kind: 'cover' };
    const inside = doc.cover.inside.enabled ? { kind: 'cover', side: 'inside' } : null;
    const face = (label, make) => ({ label, url: null, make });
    const page = (idx, side) => face(`page ${Model.pageNumber(doc, idx)}`, () => drawPart(doc, { kind: 'page', idx }, s, 0, doc.w, { gutter: side }));
    const blank = (side) => face('', () => blankPage(s, doc, side));
    const leaves = [
      {
        stiff: true,
        front: face('front cover', () => drawPart(doc, outside, s, c.front[0], doc.w)),
        back: inside ? face('inside front cover', () => drawPart(doc, inside, s, c.back[0], doc.w, { gutter: 'left' })) : blank('left'),
      },
    ];
    const n = doc.pages.length;
    for (let i = 0; i < n; i += 2) leaves.push({ front: page(i, 'right'), back: i + 1 < n ? page(i + 1, 'left') : blank('left') });
    leaves.push({
      stiff: true,
      front: inside ? face('inside back cover', () => drawPart(doc, inside, s, c.front[0], doc.w, { gutter: 'right' })) : blank('right'),
      back: face('back cover', () => drawPart(doc, outside, s, c.back[0], doc.w)),
    });
    return leaves;
  }
  const urlOf = (f) => f.url || (f.url = f.make());

  /* ---------- opening and closing ---------- */
  async function open() {
    const doc = App.S.doc;
    if (root || !available(doc)) return;
    if (window.Text && Text.active) Text.finish();
    Menu.close();
    await Promise.all([Fonts.ensureDoc(doc), Assets.ensureDoc(doc)]);
    Layout.invalidate();

    // Fit the open book in the window, and draw the pictures sharp for this screen.
    const top = document.getElementById('menubar')?.offsetHeight || 0;
    // Leave room above and below: a page lifting mid-turn comes towards you and looks bigger.
    const availW = innerWidth - 120, availH = (innerHeight - top - BAR) * 0.78;
    const k = Math.max(0.5, Math.min(availH / doc.h, availW / (2 * doc.w + 40))); // px per mm
    const s = k * Math.min(2, devicePixelRatio || 1);
    const W = doc.w * k, H = doc.h * k;
    const c = Model.cover(doc);
    v = { doc, k, s, W, H, T: Math.max(4, c.spine * k), SW: (doc.w * k) / N, state: 0, spin: 0, turn: null, spinning: false, queue: [], anim: 0, grab: null };
    v.leaves = buildLeaves(doc, s);
    v.LEAVES = v.leaves.length;

    root = document.createElement('div');
    root.id = 'bookview';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Preview book');
    root.innerHTML = `
      <button class="btn btn-sm bv-close" data-bv="close" title="Back to editing (Esc)">Close</button>
      <div class="bv-stage"><div class="bv-book">
        <div class="bv-shadow"></div>
        <div class="bv-edges bv-edgeL"></div><div class="bv-edges bv-edgeR"></div>
        <div class="bv-side bv-L"></div><div class="bv-side bv-R"></div>
        <div class="bv-cast bv-castR"></div><div class="bv-cast bv-castL"></div>
        <div class="bv-leaf"></div>
        <div class="bv-closed"></div>
      </div></div>
      <div class="bv-bar">
        <span class="bv-tip">Click a page or drag its edge to turn it. On a closed book, the left arrow turns it over.</span>
        <button class="btn btn-sm" data-bv="first" title="Close the book on the front cover (Home)">⏮</button>
        <button class="btn btn-sm" data-bv="prev" title="Back a page (Left arrow)">‹</button>
        <span class="bv-where"></span>
        <button class="btn btn-sm" data-bv="next" title="Next page (Right arrow)">›</button>
        <button class="btn btn-sm" data-bv="last" title="Close the book on the back cover (End)">⏭</button>
      </div>`;
    document.body.appendChild(root);
    build();
    fit();
    draw();
    label();
    root.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', fit);
  }
  function close() {
    if (!root) return;
    cancelAnimationFrame(v.anim);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', fit);
    root.remove();
    root = null;
    v = null;
  }
  const q = (sel) => root.querySelector(sel);

  /* ---------- building the book on screen ---------- */
  function build() {
    const { W, H, T, SW } = v;
    const book = (v.book = q('.bv-book'));
    Object.assign(book.style, { width: 2 * W + 'px', height: H + 'px' });
    for (const [el, left] of [[q('.bv-L'), 0], [q('.bv-R'), W]]) Object.assign(el.style, { width: W + 'px', height: H + 'px', left: left + 'px' });
    Object.assign(q('.bv-castR').style, { left: W + 'px', width: W + 'px', height: H + 'px' });
    Object.assign(q('.bv-castL').style, { left: '0px', width: W + 'px', height: H + 'px' });
    const leaf = q('.bv-leaf');
    Object.assign(leaf.style, { left: W + 'px', width: W + 'px', height: H + 'px' });

    // The turning page: strips, each inside the one before, so their tilts add up into a curve.
    v.strips = [];
    let parent = leaf;
    for (let i = 0; i < N; i++) {
      const st = document.createElement('div');
      st.className = 'bv-strip';
      Object.assign(st.style, { left: (i ? SW : 0) + 'px', width: SW + 0.6 + 'px' });
      const f = document.createElement('div'), b = document.createElement('div');
      f.className = 'bv-face';
      b.className = 'bv-face bv-back';
      f.style.backgroundSize = b.style.backgroundSize = `${W}px ${H}px`;
      f.style.backgroundPosition = `${-i * SW}px 0`;
      b.style.backgroundPosition = `${-(W - (i + 1) * SW)}px 0`;
      st.append(f, b);
      parent.appendChild(st);
      v.strips.push({ st, f, b, k: -1 });
      parent = st;
    }

    // The closed book: front, back, spine, page edges, top and bottom, around its middle.
    const closed = (v.closed = q('.bv-closed'));
    Object.assign(closed.style, { width: W + 'px', height: H + 'px' });
    const side = (w, h, transform, background) => {
      const el = document.createElement('div');
      el.className = 'bv-cf';
      Object.assign(el.style, { width: w + 'px', height: h + 'px', left: (W - w) / 2 + 'px', top: (H - h) / 2 + 'px', transform, background });
      closed.appendChild(el);
      return el;
    };
    const img = (url) => `url(${url}) 0 0 / 100% 100% no-repeat`;
    const across = 'repeating-linear-gradient(90deg, #e2ddd2 0 1px, #bdb7aa 1px 2px)';
    const down = 'repeating-linear-gradient(0deg, #e2ddd2 0 1px, #bdb7aa 1px 2px)';
    const c = Model.cover(v.doc);
    const spineURL = c.spine > 0.05 ? drawPart(v.doc, { kind: 'cover' }, v.s, c.spineX[0], c.spine) : null;
    v.cFront = side(W, H, `translateZ(${T / 2}px)`, img(urlOf(v.leaves[0].front)));
    v.cBack = side(W, H, `rotateY(180deg) translateZ(${T / 2}px)`, img(urlOf(v.leaves[v.LEAVES - 1].back)));
    v.cSpine = side(T, H, `rotateY(-90deg) translateZ(${W / 2}px)`, spineURL ? img(spineURL) : '#2b2930');
    side(Math.max(1, T - 2), H - 4, `rotateY(90deg) translateZ(${W / 2 - 2}px)`, across);
    v.cTop = side(W - 4, Math.max(1, T - 2), `rotateX(90deg) translateZ(${H / 2 - 1}px)`, down);
    side(W - 4, Math.max(1, T - 2), `rotateX(-90deg) translateZ(${H / 2 - 1}px)`, down);

    // Dragging.
    book.addEventListener('pointerdown', onDown);
    book.addEventListener('pointermove', onMove);
    book.addEventListener('pointerup', onUp);
    book.addEventListener('pointercancel', onUp);
  }
  function fit() {
    if (!root) return;
    const top = document.getElementById('menubar')?.offsetHeight || 0;
    const sw = innerWidth - 80, sh = (innerHeight - top - BAR) * 0.78;
    const z = Math.min(1.4, sw / (2 * v.W + 40), sh / v.H);
    q('.bv-stage').style.transform = `scale(${z})`;
  }

  /* ---------- drawing a moment ---------- */
  const shiftFor = (s) => (s === 0 ? -v.W / 2 : s === v.LEAVES ? v.W / 2 : 0);
  function draw() {
    const { W, H, LEAVES, leaves, book } = v;
    const t = v.turn;
    // Which pages lie flat on each side, under any turning page.
    const leftLeaf = t ? t.k - 1 : v.state - 1;
    const rightLeaf = t ? t.k + 1 : v.state;
    const L = q('.bv-L'), R = q('.bv-R');
    L.style.backgroundImage = leftLeaf >= 0 ? `url(${urlOf(leaves[leftLeaf].back)})` : 'none';
    L.style.visibility = leftLeaf >= 0 ? 'visible' : 'hidden';
    R.style.backgroundImage = rightLeaf < LEAVES ? `url(${urlOf(leaves[rightLeaf].front)})` : 'none';
    R.style.visibility = rightLeaf < LEAVES ? 'visible' : 'hidden';
    // The block of pages at each outer edge, thicker as pages pile up.
    const per = Math.min(1.4, (v.T * 0.8) / Math.max(1, LEAVES - 2));
    const leftCount = Math.max(0, leftLeaf), rightCount = Math.max(0, LEAVES - 1 - rightLeaf);
    const eL = q('.bv-edgeL'), eR = q('.bv-edgeR');
    Object.assign(eL.style, { width: leftCount * per + 'px', left: -leftCount * per + 'px', display: leftLeaf >= 0 && leftCount ? 'block' : 'none' });
    Object.assign(eR.style, { width: rightCount * per + 'px', left: 2 * W + 'px', display: rightLeaf < LEAVES && rightCount ? 'block' : 'none' });
    // Slide the book so a closed book sits in the middle.
    let shift = shiftFor(v.state);
    if (t) shift = shiftFor(t.k) + (shiftFor(t.k + 1) - shiftFor(t.k)) * (t.theta / 180);
    book.style.transform = `translateX(${shift}px)`;

    // The closed book, part way over or on its spine: the solid block instead of flat pages.
    const closedView = !t && v.spin !== (v.state === LEAVES ? 180 : 0);
    book.classList.toggle('bv-spinning', closedView);
    book.style.perspectiveOrigin = closedView ? W - shift + 'px 40%' : '50% 40%';
    if (closedView) {
      v.closed.style.left = W / 2 - shift + 'px';
      v.closed.style.transform = `rotateY(${v.spin}deg)`;
      const r = (v.spin * Math.PI) / 180;
      v.cFront.style.setProperty('--sh', (0.55 * (1 - Math.cos(r))).toFixed(3));
      v.cBack.style.setProperty('--sh', (0.55 * (1 + Math.cos(r))).toFixed(3));
      v.cSpine.style.setProperty('--sh', (0.55 * (1 - Math.sin(r))).toFixed(3));
      v.cTop.style.setProperty('--sh', '0.18');
      return;
    }

    const leaf = q('.bv-leaf');
    if (!t) {
      leaf.style.display = 'none';
      q('.bv-castR').style.opacity = q('.bv-castL').style.opacity = 0;
      return;
    }
    leaf.style.display = 'block';
    const lf = leaves[t.k];
    const th = t.theta;
    // Paper bends most halfway over; covers are stiff boards and don't bend at all.
    const bend = lf.stiff ? 0 : PAGE_BEND * Math.sin((Math.PI * th) / 180);
    let sumW = 0;
    const wts = [];
    for (let i = 1; i < N; i++) sumW += wts[i] = Math.pow(i / N, 2.4);
    let phi = 0;
    const front = urlOf(lf.front), back = urlOf(lf.back);
    for (let i = 0; i < N; i++) {
      const a = i === 0 ? th - bend : (bend * wts[i]) / sumW;
      phi += a;
      const st = v.strips[i];
      st.st.style.transform = `rotateY(${-a}deg)` + (i === 0 ? ' translateZ(0.6px)' : '');
      // A strip turned edge-on to you looks darker.
      const shade = (0.42 * Math.abs(Math.sin((phi * Math.PI) / 180))).toFixed(3);
      st.f.style.setProperty('--sh', shade);
      st.b.style.setProperty('--sh', shade);
      if (st.k !== t.k) {
        st.f.style.backgroundImage = `url(${front})`;
        st.b.style.backgroundImage = `url(${back})`;
        st.k = t.k;
      }
    }
    // The shadow the turning page casts on the page underneath.
    const lift = Math.sin((Math.PI * th) / 180);
    q('.bv-castR').style.opacity = th < 90 ? (0.6 * lift).toFixed(3) : 0;
    q('.bv-castL').style.opacity = th >= 90 ? (0.6 * lift).toFixed(3) : 0;
    q('.bv-castR').style.visibility = rightLeaf < LEAVES ? 'visible' : 'hidden';
    q('.bv-castL').style.visibility = leftLeaf >= 0 ? 'visible' : 'hidden';
  }
  // Draws the next pictures ahead of time, while nothing is moving.
  function prepareAround() {
    const run = () => {
      if (!v || v.turn || v.spinning) return;
      for (const i of [v.state + 1, v.state - 2, v.state + 2, v.state - 1, v.state]) {
        const lf = v.leaves[i];
        if (!lf) continue;
        for (const f of [lf.front, lf.back]) if (!f.url) return urlOf(f), setTimeout(run, 30);
      }
    };
    setTimeout(run, 60);
  }

  function label() {
    const s = v.state;
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    let text;
    if (v.spin > 0 && v.spin < 180) text = 'Spine';
    else if (s === 0) text = 'Front cover';
    else if (s === v.LEAVES) text = 'Back cover';
    else {
      const l = v.leaves[s - 1].back.label, r = v.leaves[s].front.label;
      if (l.startsWith('page') && r.startsWith('page')) text = `Pages ${l.slice(5)}–${r.slice(5)}`;
      else text = cap([l, r].filter(Boolean).join(' and '));
    }
    q('.bv-where').textContent = text;
    const onSpine = v.spin > 0 && v.spin < 180;
    q('[data-bv="first"]').disabled = !onSpine && s === 0;
    q('[data-bv="last"]').disabled = !onSpine && s === v.LEAVES;
    prepareAround();
  }

  /* ---------- turning pages ---------- */
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const turnMs = () => (reduceMotion() ? 0 : 760);
  function animate(from, to, ms, frame, done) {
    const t0 = performance.now();
    cancelAnimationFrame(v.anim);
    const step = (now) => {
      if (!v) return;
      const p = ms ? Math.min(1, (now - t0) / ms) : 1;
      frame(from + (to - from) * ease(p));
      if (p < 1) v.anim = requestAnimationFrame(step);
      else done();
    };
    v.anim = requestAnimationFrame(step);
  }
  function turnTo(target, done, ms = turnMs()) {
    const from = v.turn.theta;
    animate(from, target, ms * Math.max(0.25, Math.abs(target - from) / 180), (th) => ((v.turn.theta = th), draw()), done);
  }
  function go(dir) {
    if (v.turn || v.spinning) return v.queue.length < 3 && v.queue.push(dir);
    if (dir > 0 && v.state < v.LEAVES) {
      v.turn = { k: v.state, theta: 0 };
      turnTo(180, () => finish(1));
    } else if (dir < 0 && v.state > 0) {
      v.turn = { k: v.state - 1, theta: 180 };
      turnTo(0, () => finish(-1));
    }
  }
  function finish(dir) {
    v.state += dir;
    v.turn = null;
    v.spin = v.state === v.LEAVES ? 180 : 0;
    draw();
    label();
    if (v.queue.length) go(v.queue.shift());
  }

  /* ---------- turning the closed book over ---------- */
  const onSpine = () => v.spin > 0 && v.spin < 180;
  function spinTo(target, ms = 640) {
    if (v.spinning || v.turn) return;
    v.spinning = true;
    const dur = reduceMotion() ? 0 : Math.max(1, (ms * Math.abs(target - v.spin)) / 90);
    animate(v.spin, target, dur, (a) => ((v.spin = a), draw()), () => {
      v.spinning = false;
      v.spin = target;
      if (target === 180) v.state = v.LEAVES;
      if (target === 0) v.state = 0;
      draw();
      label();
    });
  }
  // Left arrow / ‹ : back a page, or on the front cover turn the book over towards the back.
  function stepLeft() {
    if (v.spinning) return;
    if (onSpine()) return spinTo(180);
    if (v.state === 0 && !v.turn) return spinTo(90);
    go(-1);
  }
  // Right arrow / › : the next page, or on the back cover turn the book over towards the front.
  function stepRight() {
    if (v.spinning) return;
    if (onSpine()) return spinTo(0);
    if (v.state === v.LEAVES && !v.turn) return spinTo(90);
    go(1);
  }
  // Home / ⏮ and End / ⏭ : close the book on the front or back cover.
  function toFront() {
    if (onSpine()) return spinTo(0);
    for (let i = 0; i < v.state; i++) go(-1);
  }
  function toBack() {
    if (onSpine()) return spinTo(180);
    for (let i = v.state; i < v.LEAVES; i++) go(1);
  }

  /* ---------- clicking and dragging ---------- */
  function onDown(e) {
    if (e.button !== 0 || v.turn || v.spinning) return;
    const r = v.book.getBoundingClientRect();
    const z = r.width / (2 * v.W); // the stage is scaled to fit
    const forward = (e.clientX - r.left) / z > v.W;
    if (!onSpine() && (forward ? v.state >= v.LEAVES : v.state <= 0)) return;
    v.grab = { x0: e.clientX, z, forward, moved: false, spin0: v.spin, mode: null };
    v.book.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    const g = v && v.grab;
    if (!g) return;
    const dx = (e.clientX - g.x0) / g.z;
    if (!g.moved && Math.abs(dx) < 5) return;
    if (!g.moved) {
      g.moved = true;
      // On the spine, or dragging a closed book the opposite way to opening it: turn it over.
      g.mode = onSpine() || (v.state === 0 && dx > 0) || (v.state === v.LEAVES && dx < 0) ? 'spin' : 'turn';
      if (g.mode === 'turn') {
        if (g.forward ? v.state >= v.LEAVES : v.state <= 0) return (v.grab = null);
        v.turn = g.forward ? { k: v.state, theta: 0 } : { k: v.state - 1, theta: 180 };
      }
      v.book.classList.add('bv-grab');
    }
    if (g.mode === 'spin') {
      v.spin = Math.min(180, Math.max(0, g.spin0 + (dx / v.W) * 180));
      return draw();
    }
    // Dragging across the open book is a full turn.
    const p = Math.min(1, Math.max(0, (g.forward ? -dx : dx) / (1.6 * v.W)));
    v.turn.theta = g.forward ? 180 * p : 180 * (1 - p);
    draw();
  }
  function onUp() {
    const g = v && v.grab;
    if (!g) return;
    v.grab = null;
    v.book.classList.remove('bv-grab');
    if (!g.moved) return onSpine() ? null : go(g.forward ? 1 : -1);
    if (g.mode === 'spin') {
      // Settle on whichever is nearest: the front, the spine or the back.
      const target = [0, 90, 180].reduce((a, b) => (Math.abs(b - v.spin) < Math.abs(a - v.spin) ? b : a));
      return spinTo(target, 420);
    }
    // Let go past halfway and it carries on over; otherwise it falls back.
    const over = g.forward ? v.turn.theta > 70 : v.turn.theta < 110;
    const dir = g.forward ? 1 : -1;
    if (over) turnTo(g.forward ? 180 : 0, () => finish(dir), turnMs() * 0.8);
    else turnTo(g.forward ? 0 : 180, () => ((v.turn = null), draw()), turnMs() * 0.6);
  }

  /* ---------- keys and buttons ---------- */
  function onClick(e) {
    const b = e.target.closest('[data-bv]');
    if (!b) return;
    ({ close, first: toFront, prev: stepLeft, next: stepRight, last: toBack })[b.dataset.bv]();
  }
  function onKey(e) {
    if (!root || document.querySelector('.modal-overlay') || document.querySelector('.mb-drop')) return;
    const k = e.key;
    const map = { ArrowRight: stepRight, PageDown: stepRight, ' ': stepRight, ArrowLeft: stepLeft, PageUp: stepLeft, Home: toFront, End: toBack, Escape: close };
    if (map[k] && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      map[k]();
    }
  }

  // For the tests in test/: jump to a moment without animating.
  const testHooks = {
    state: () => v && { state: v.state, spin: v.spin, turn: v.turn, leaves: v.LEAVES, where: q('.bv-where').textContent },
    setTurn: (k, theta) => ((v.turn = theta == null ? null : { k, theta }), draw()),
    setState: (s) => ((v.state = s), (v.turn = null), (v.spin = s === v.LEAVES ? 180 : 0), draw(), label()),
    setSpin: (a) => ((v.spin = a), draw(), label()),
    stepLeft: () => stepLeft(),
    stepRight: () => stepRight(),
  };

  return { open, close, isOpen: () => !!root, available, toggle: () => (root ? close() : open()), test: testHooks };
})();
