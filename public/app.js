import { EMOJIS, MAX_CHARS, TTL_MS, ALLOWED_HINT, sanitizeInput, checkPlaintext, toBinary, decodeBinary } from './shared/rules.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // never innerHTML
  return n;
};

const state = { me: null, taken: [], online: [], messages: new Map(), skew: 0, ws: null, retry: 0 };
const input = $('input');

// ---------- connection ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  setStatus('connecting…');
  ws.onopen = () => {
    state.retry = 0;
    setStatus('live', true);
  };
  ws.onclose = () => {
    setStatus('reconnecting…');
    setTimeout(connect, Math.min(15000, 1000 * 2 ** state.retry++));
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handle[msg.t]?.(msg);
  };
}
function send(obj) {
  if (state.ws?.readyState !== 1) return false;
  state.ws.send(JSON.stringify(obj));
  return true;
}

const handle = {
  hello(m) {
    state.skew = m.now - Date.now();
    state.messages.clear();
    $('timeline').replaceChildren();
    for (const x of m.messages) addPost(x, false);
    setMe(m.me);
    setQuota(m.left, m.limit);
    if (!m.me) openPicker();
  },
  presence(m) {
    state.taken = m.taken;
    state.online = m.online;
    renderOnline();
    renderGrid();
  },
  claimed(m) {
    setMe(m.emoji);
    if (m.emoji) $('picker').close();
    else renderGrid();
  },
  msg(m) {
    addPost(m.m, true);
  },
  quota(m) {
    setQuota(m.left);
  },
  error(m) {
    if ($('picker').open) $('picker-error').textContent = m.reason;
    else toast(m.reason);
  },
};

// ---------- identity ----------
function setMe(emoji) {
  state.me = emoji;
  $('me-avatar').textContent = emoji || '?';
  $('me-handle').textContent = emoji ? 'Anonymous' : 'pick an emoji';
  $('release').hidden = !emoji;
  input.placeholder = emoji ? '' : 'Pick an emoji name first';
  updateComposer();
}

function renderGrid() {
  const grid = $('grid');
  grid.replaceChildren(
    ...EMOJIS.map((e) => {
      const b = el('button', e === state.me ? 'mine' : '', e);
      b.type = 'button';
      b.disabled = state.taken.includes(e) && e !== state.me;
      b.setAttribute('aria-label', b.disabled ? `${e} taken` : `Choose ${e}`);
      b.onclick = () => {
        $('picker-error').textContent = '';
        send({ t: 'claim', emoji: e });
      };
      return b;
    }),
  );
}

function openPicker() {
  $('picker-error').textContent = '';
  renderGrid();
  if (!$('picker').open) $('picker').showModal();
}

function renderOnline() {
  $('online').replaceChildren(...state.online.map((e) => el('span', null, e)));
  const n = state.online.length;
  $('online-count').textContent = n ? `(${n})` : 'nobody yet';
}

// ---------- composer ----------
let quotaLeft = null;
let quotaLimit = 100;
function setQuota(left, limit) {
  quotaLeft = left;
  if (limit) quotaLimit = limit;
  $('quota').textContent = left == null ? '' : `${left} / ${quotaLimit} posts left today.`;
  updateComposer();
}

function updateComposer(stripped = false) {
  const text = input.value.trim();
  const err = text ? checkPlaintext(text) : null;
  const left = MAX_CHARS - input.value.length;
  $('counter').textContent = left;
  $('counter').classList.toggle('low', left <= 20);
  $('preview').textContent = text && !err ? toBinary(text) : '';
  const hint = $('hint');
  hint.textContent = stripped ? `Removed. Only ${ALLOWED_HINT}.` : err || 'Plain text only · auto-encoded to binary';
  hint.classList.toggle('bad', Boolean(stripped || err));
  $('send').disabled = !state.me || !text || Boolean(err) || quotaLeft === 0;
}

input.addEventListener('input', () => {
  const clean = sanitizeInput(input.value.replace(/\s/g, ' '));
  const stripped = clean !== input.value;
  if (stripped) {
    const pos = Math.max(0, input.selectionStart - (input.value.length - clean.length));
    input.value = clean;
    input.setSelectionRange(pos, pos);
  }
  updateComposer(stripped);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    post();
  }
});
input.addEventListener('focus', () => !state.me && openPicker());
// Block drag-and-drop of rich content; paste goes through the input sanitizer.
input.addEventListener('drop', (e) => e.preventDefault());

function post() {
  const text = input.value.trim();
  if ($('send').disabled || checkPlaintext(text)) return;
  if (send({ t: 'post', bin: toBinary(text) })) {
    input.value = '';
    updateComposer();
  }
}
$('send').onclick = post;
$('name-btn').onclick = openPicker;
$('nav-handle').onclick = openPicker;
$('nav-about').onclick = () => $('about').showModal();
$('about-close').onclick = () => $('about').close();
$('picker-close').onclick = () => $('picker').close();
$('release').onclick = () => send({ t: 'release' });

// ---------- timeline ----------
const now = () => Date.now() + state.skew;
// Classic board timestamp: 10/16/26(Thu)09:41:12
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ts) => {
  const d = new Date(ts - state.skew);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}(${DAYS[d.getDay()]})` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const remaining = (ts) => {
  const m = Math.min(TTL_MS / 60000, Math.max(0, (ts + TTL_MS - now()) / 60000));
  return m > 60 ? `burns in ${Math.ceil(m / 60)}h` : `burns in ${Math.ceil(m)}m`;
};

function addPost(m, fresh) {
  // Validate everything from the wire, even from our own server.
  if (!m || typeof m.id !== 'string' || !EMOJIS.includes(m.emoji) || !Number.isFinite(m.ts) || !Number.isInteger(m.no)) return;
  if (state.messages.has(m.id) || decodeBinary(m.bin) === null) return;
  state.messages.set(m.id, m);

  const li = el('li', fresh ? 'post new' : 'post');
  li.dataset.id = m.id;
  li.id = `p${m.no}`;
  const box = el('div', 'post-box');
  const meta = el('div', 'post-meta');
  meta.append(
    el('span', 'emoji', m.emoji),
    el('span', 'name', 'Anonymous'),
    el('span', 'date', stamp(m.ts)),
    el('span', 'no', `No.${m.no}`),
    el('span', 'ttl', `[${remaining(m.ts)}]`),
  );
  const bits = el('div', 'bits', m.bin);
  bits.title = 'Press and hold to peek';
  box.append(meta, bits);
  li.append(box);
  bindPeek(bits, m.bin);
  $('timeline').prepend(li);
  $('empty').hidden = true;
}

// Press-and-hold decodes locally; the binary comes back as soon as you let go.
function bindPeek(node, bin) {
  const show = (e) => {
    e.preventDefault();
    node.textContent = decodeBinary(bin) ?? '';
    node.classList.add('peek');
  };
  const hide = () => {
    node.textContent = bin;
    node.classList.remove('peek');
  };
  node.addEventListener('pointerdown', show);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) node.addEventListener(ev, hide);
  node.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Tick: refresh relative times and drop anything older than 24h.
setInterval(() => {
  for (const li of $('timeline').children) {
    const m = state.messages.get(li.dataset.id);
    if (!m) continue;
    if (m.ts + TTL_MS <= now()) {
      state.messages.delete(m.id);
      li.remove();
      continue;
    }
    li.querySelector('.ttl').textContent = `[${remaining(m.ts)}]`;
  }
  $('empty').hidden = state.messages.size > 0;
}, 15000);

// ---------- misc ----------
function setStatus(text, live = false) {
  $('status').textContent = text;
  $('status').classList.toggle('live', live);
}
let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

renderOnline();
updateComposer();
connect();
