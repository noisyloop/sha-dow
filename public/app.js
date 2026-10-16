import { EMOJIS, MAX_CHARS, TTL_MS, ALLOWED_HINT, sanitizeInput, checkPlaintext, toBinary, decodeBinary } from './shared/rules.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // never innerHTML
  return n;
};

const state = { me: null, taken: [], online: [], messages: new Map(), skew: 0, v: -1, lastTs: 0, fails: 0, lastInput: Date.now() };
const input = $('input');

// ---------- API (HTTP polling; works on serverless hosts) ----------
async function api(action, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' };
  const qs = action === 'feed' ? `&since=${Math.max(0, state.lastTs - 1000)}` : '';
  const res = await fetch(`/api/chat?a=${action}${qs}`, { credentials: 'same-origin', ...opts });
  const data = await res.json().catch(() => ({ error: 'Server error.' }));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Error'), { status: res.status });
  return data;
}

function showError(msg) {
  if ($('picker').open) $('picker-error').textContent = msg;
  else toast(msg);
}

async function loadFeed() {
  const f = await api('feed');
  state.skew = f.now - Date.now();
  state.v = f.v;
  for (const m of f.posts) {
    addPost(m, state.lastTs > 0);
    state.lastTs = Math.max(state.lastTs, m.ts);
  }
  state.taken = f.taken;
  state.online = f.online;
  renderOnline();
  if (f.me !== state.me) setMe(f.me);
  setQuota(f.left, f.limit);
  renderGrid();
  return f;
}

// Poll a tiny shared version number; only fetch the feed when it changes.
// Fast while you're active, slower when idle, paused when the tab is hidden.
let pollTimer;
async function poll() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  try {
    const { v } = await api('ver');
    if (v !== state.v) await loadFeed();
    state.fails = 0;
    setStatus('live', true);
  } catch {
    state.fails++;
    setStatus('reconnecting…');
  }
  const idle = Date.now() - state.lastInput > 5 * 60_000;
  const delay = state.fails ? Math.min(30_000, 2000 * 2 ** state.fails) : idle ? 15_000 : 3000;
  pollTimer = setTimeout(poll, delay);
}

let pingTimer;
function heartbeat() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (state.me && !document.hidden) api('ping', {}).catch(() => {});
  }, 30_000);
}

document.addEventListener('visibilitychange', () => !document.hidden && poll());
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => (state.lastInput = Date.now()), { passive: true });

async function start() {
  setStatus('connecting…');
  try {
    const f = await loadFeed();
    setStatus('live', true);
    if (!f.me) openPicker();
  } catch (err) {
    setStatus('offline');
    showError(err.message);
  }
  heartbeat();
  pollTimer = setTimeout(poll, 3000);
}

async function claimEmoji(emoji) {
  try {
    const r = await api('claim', { emoji });
    setMe(r.me);
    $('picker').close();
    await loadFeed();
  } catch (err) {
    showError(err.message);
  }
}

async function releaseEmoji() {
  try {
    setMe((await api('release', {})).me);
    await loadFeed();
  } catch (err) {
    showError(err.message);
  }
}

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
        claimEmoji(e);
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

let posting = false;
async function post() {
  const text = input.value.trim();
  if (posting || $('send').disabled || checkPlaintext(text)) return;
  posting = true;
  $('send').disabled = true;
  try {
    const r = await api('post', { bin: toBinary(text) });
    input.value = '';
    addPost(r.m, true);
    state.lastTs = Math.max(state.lastTs, r.m.ts);
    setQuota(r.left);
  } catch (err) {
    showError(err.message);
  } finally {
    posting = false;
    updateComposer();
  }
}
$('send').onclick = post;
$('name-btn').onclick = openPicker;
$('nav-handle').onclick = openPicker;
$('nav-about').onclick = () => $('about').showModal();
$('about-close').onclick = () => $('about').close();
$('picker-close').onclick = () => $('picker').close();
$('release').onclick = releaseEmoji;

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
start();
