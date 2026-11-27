/* Small shared helpers: DOM, ids, units, windows (modals), toasts and the right-click menu. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = (p = '') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = (o) => JSON.parse(JSON.stringify(o));
/* A store of finished pictures kept to a memory budget (bytes), not a number of entries: the
   least recently used go first. Something bigger than half the budget isn't kept at all (a page
   worked out at print size for an export, say). set(key, value, bytes); get(key). */
function memCache(budget) {
  const map = new Map(); // key -> { v, b }
  let total = 0;
  return {
    get(k) {
      const e = map.get(k);
      if (!e) return undefined;
      map.delete(k);
      map.set(k, e); // most recently used last
      return e.v;
    },
    set(k, v, bytes) {
      if (map.has(k)) (total -= map.get(k).b), map.delete(k);
      if (bytes > budget / 2) return;
      map.set(k, { v, b: bytes });
      total += bytes;
      while (total > budget && map.size > 1) {
        const [ok, oe] = map.entries().next().value;
        map.delete(ok);
        total -= oe.b;
      }
    },
    values: () => [...map.values()].map((e) => e.v),
    get bytes() {
      return total;
    },
    get size() {
      return map.size;
    },
  };
}
const pixelBytes = (...canvases) => canvases.reduce((a, c) => a + (c ? (c.width || 0) * (c.height || 0) * 4 : 0), 0);

function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- units: everything is stored in millimetres ---------- */
const MM_PER_PT = 25.4 / 72;
const PT_PER_MM = 72 / 25.4;
const Units = {
  list: ['mm', 'cm', 'px'],
  to(mm, unit, dpi = 300) {
    if (unit === 'cm') return mm / 10;
    if (unit === 'px') return (mm / 25.4) * dpi;
    return mm;
  },
  from(v, unit, dpi = 300) {
    if (unit === 'cm') return v * 10;
    if (unit === 'px') return (v / dpi) * 25.4;
    return v;
  },
  fmt(mm, unit, dpi = 300) {
    const v = Units.to(mm, unit, dpi);
    const d = unit === 'px' ? 0 : unit === 'cm' ? 3 : 2;
    return String(Number(v.toFixed(d)));
  },
  label(mm, unit, dpi) {
    return `${Units.fmt(mm, unit, dpi)} ${unit}`;
  },
  // Parses "12", "12mm", "1.2cm", "300px", "2in" or "36pt" into mm. Bare numbers use `unit`.
  parse(text, unit, dpi = 300) {
    const m = String(text).trim().replace(',', '.').match(/^(-?[\d.]+)\s*(mm|cm|px|in|pt|")?$/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (!isFinite(v)) return null;
    const u = (m[2] || unit).toLowerCase();
    if (u === 'in' || u === '"') return v * 25.4;
    if (u === 'pt') return v * MM_PER_PT;
    return Units.from(v, u, dpi);
  },
};

/* ---------- windows ---------- */
// Closes only when you press AND let go outside it, so dragging out of a field never closes it.
function openModal({ title, body, wide = false, cls = '', onClose, dismissable = true }) {
  const root = document.createElement('div');
  root.className = 'modal-overlay';
  root.innerHTML = `<div class="modal ${wide ? 'modal-wide' : ''} ${cls}" role="dialog" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2>${dismissable ? '<button class="icon-btn modal-x" aria-label="Close">✕</button>' : ''}</div>
    <div class="modal-body">${body}</div></div>`;
  document.body.appendChild(root);
  let downOutside = false;
  root.addEventListener('pointerdown', (e) => (downOutside = e.target === root));
  root.addEventListener('pointerup', (e) => {
    if (dismissable && downOutside && e.target === root) close();
    downOutside = false;
  });
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable && root === $$('.modal-overlay').pop()) {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  const x = $('.modal-x', root);
  if (x) x.onclick = () => close();
  let closed = false;
  function close(v) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    if (onClose) onClose(v);
  }
  const el = $('.modal', root);
  setTimeout(() => {
    const f = $('[autofocus]', el) || $('input,select,button.btn-accent', el);
    if (f) f.focus();
  }, 0);
  return { el, close, root };
}

function ask(message, { detail = '', ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title: message,
      body: `${detail ? `<p class="muted">${esc(detail)}</p>` : ''}<div class="modal-actions"><button class="btn btn-ghost" data-a="no">${esc(cancel)}</button><button class="btn ${danger ? 'btn-danger' : 'btn-accent'}" data-a="yes">${esc(ok)}</button></div>`,
      onClose: (v) => resolve(v === true),
    });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (b) m.close(b.dataset.a === 'yes');
    });
  });
}

function prompt(title, value = '', { ok = 'OK', label = '' } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<label class="field">${label ? `<span>${esc(label)}</span>` : ''}<input type="text" class="input" value="${esc(value)}" autofocus></label>
        <div class="modal-actions"><button class="btn btn-ghost" data-a="no">Cancel</button><button class="btn btn-accent" data-a="yes">${esc(ok)}</button></div>`,
      onClose: (v) => resolve(v ?? null),
    });
    const input = $('input', m.el);
    setTimeout(() => input.select(), 0);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && m.close(input.value));
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (b) m.close(b.dataset.a === 'yes' ? input.value : null);
    });
  });
}

/* ---------- toasts, with Undo where it helps ---------- */
function toast(text, { action, onAction, ms = 4500, kind = '' } = {}) {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="btn btn-sm">${esc(action)}</button>` : ''}`;
  host.appendChild(t);
  const done = () => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 250);
  };
  if (action) $('button', t).onclick = () => (onAction && onAction(), done());
  setTimeout(done, ms);
}

/* ---------- right-click menu ---------- */
function contextMenu(x, y, items) {
  $$('.ctx').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'ctx';
  m.innerHTML = items
    .map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}><span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>`))
    .join('');
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const close = () => {
    m.remove();
    document.removeEventListener('pointerdown', away, true);
  };
  const away = (e) => !m.contains(e.target) && close();
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  m.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    close();
    items[b.dataset.i].run();
  };
}

const bytesToBase64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const base64ToBytes = (b64) => {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
};
const timeAgo = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
