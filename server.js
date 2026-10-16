import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TTL_MS, isValidEmoji, decodeBinary } from './public/shared/rules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const MAX_MESSAGES = 2000;
const MAX_CONN_PER_IP = 4;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 100; // posts per rolling 24h
const COOKIE = 'sd_sid';

// Per-boot salt: raw IPs are never stored, and hashes are useless after a restart.
const SALT = crypto.randomBytes(32);

// ---------- in-memory state (a restart wipes everything, by design) ----------
const messages = []; // { id, emoji, bin, ts }
const claims = new Map(); // emoji -> { sid, ip, lastSeen }
const sockets = new Set(); // ws (ws.sid, ws.ip)
const buckets = new Map(); // key -> { tokens, at }
const daily = new Map(); // 'sid:..' | 'ip:..' -> [post timestamps within the last 24h]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

export function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) ip = fwd;
  }
  ip = ip.replace(/^::ffff:/, '');
  // IPv6 users get whole /64 blocks; treat the block as one network.
  if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':');
  return crypto.createHmac('sha256', SALT).update(ip).digest('hex').slice(0, 32);
}

function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name && /^[a-f0-9]{64}$/.test(v || '')) return v;
  }
  return null;
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Token bucket: `cap` burst, refills one token every `everyMs`.
function allow(key, cap = 5, everyMs = 3000) {
  const now = Date.now();
  const b = buckets.get(key) || { tokens: cap, at: now };
  b.tokens = Math.min(cap, b.tokens + (now - b.at) / everyMs);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Rolling 24h post quota, enforced per session AND per network so a new session doesn't reset it.
function quotaLeft(ws, now = Date.now()) {
  let left = DAILY_LIMIT;
  for (const key of ['sid:' + ws.sid, 'ip:' + ws.ip]) {
    const list = (daily.get(key) || []).filter((ts) => ts + TTL_MS > now);
    daily.set(key, list);
    left = Math.min(left, DAILY_LIMIT - list.length);
  }
  return Math.max(0, left);
}
function spendQuota(ws, now) {
  for (const key of ['sid:' + ws.sid, 'ip:' + ws.ip]) daily.get(key).push(now);
}

// ---------- HTTP: static files + session cookie ----------
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (TRUST_PROXY) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
  const file = path.resolve(ROOT, rel);
  const type = MIME[path.extname(file)];
  if (!file.startsWith(ROOT + path.sep) || !type) {
    res.writeHead(404).end();
    return;
  }
  let body;
  try {
    body = await fs.readFile(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
  if (type.startsWith('text/html') && !getCookie(req, COOKIE)) {
    const secure = TRUST_PROXY ? '; Secure' : '';
    const sid = crypto.randomBytes(32).toString('hex');
    headers['Set-Cookie'] = `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure}`;
  }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
});

// ---------- WebSocket chat ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const sid = getCookie(req, COOKIE);
  const ip = clientIp(req);
  const perIp = [...sockets].filter((s) => s.ip === ip).length;
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !sid || !allowedOrigin(req) || perIp >= MAX_CONN_PER_IP) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.sid = sid;
    ws.ip = ip;
    wss.emit('connection', ws);
  });
});

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const broadcast = (obj) => {
  const data = JSON.stringify(obj);
  for (const ws of sockets) if (ws.readyState === 1) ws.send(data);
};

const emojiOf = (sid) => [...claims].find(([, c]) => c.sid === sid)?.[0] || null;
const online = () => [...new Set([...sockets].map((s) => emojiOf(s.sid)).filter(Boolean))];
const presence = () => ({ t: 'presence', taken: [...claims.keys()], online: online() });

function claim(ws, emoji) {
  if (!isValidEmoji(emoji)) return 'Pick an emoji from the list.';
  const held = claims.get(emoji);
  if (held && held.sid !== ws.sid) return `${emoji} is taken. Pick another.`;
  for (const [e, c] of claims) {
    // One emoji per network: another session on the same IP can't grab a second one.
    if (e !== emoji && c.ip === ws.ip && c.sid !== ws.sid) return `Your network already uses ${e}.`;
  }
  for (const [e, c] of claims) if (c.sid === ws.sid) claims.delete(e); // switching handles
  claims.set(emoji, { sid: ws.sid, ip: ws.ip, lastSeen: Date.now() });
  return null;
}

wss.on('connection', (ws) => {
  sockets.add(ws);
  const now = Date.now();
  const mine = emojiOf(ws.sid);
  if (mine) claims.get(mine).lastSeen = now;
  send(ws, { t: 'hello', me: mine, ttl: TTL_MS, now, left: quotaLeft(ws), limit: DAILY_LIMIT, messages: messages.filter((m) => m.ts + TTL_MS > now) });
  broadcast(presence());

  ws.on('message', (raw, isBinary) => {
    if (isBinary || !allow('ip:' + ws.ip, 20, 500)) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'claim') {
      const err = claim(ws, msg.emoji);
      if (err) return send(ws, { t: 'error', reason: err });
      send(ws, { t: 'claimed', emoji: msg.emoji });
      broadcast(presence());
    } else if (msg.t === 'release') {
      const e = emojiOf(ws.sid);
      if (e) claims.delete(e);
      send(ws, { t: 'claimed', emoji: null });
      broadcast(presence());
    } else if (msg.t === 'post') {
      const emoji = emojiOf(ws.sid);
      if (!emoji) return send(ws, { t: 'error', reason: 'Pick an emoji first.' });
      if (decodeBinary(msg.bin) === null) return send(ws, { t: 'error', reason: 'Rejected: invalid characters.' });
      if (quotaLeft(ws) === 0)
        return send(ws, { t: 'error', reason: `Daily limit reached (${DAILY_LIMIT} posts per 24h).` });
      if (!allow('sid:' + ws.sid) || !allow('post:' + ws.ip, 8, 3000))
        return send(ws, { t: 'error', reason: 'Slow down.' });
      const last = messages.findLast((m) => m.emoji === emoji);
      if (last && last.bin === msg.bin && Date.now() - last.ts < 60_000)
        return send(ws, { t: 'error', reason: 'No duplicate posts.' });
      const m = { id: crypto.randomUUID(), emoji, bin: msg.bin, ts: Date.now() };
      messages.push(m);
      spendQuota(ws, m.ts);
      send(ws, { t: 'quota', left: quotaLeft(ws) });
      if (messages.length > MAX_MESSAGES) messages.shift();
      claims.get(emoji).lastSeen = m.ts;
      broadcast({ t: 'msg', m });
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    const e = emojiOf(ws.sid);
    if (e) claims.get(e).lastSeen = Date.now();
    broadcast(presence());
  });
});

// Sweeper: drop expired messages, idle handles and stale rate-limit buckets.
setInterval(() => {
  const now = Date.now();
  while (messages.length && messages[0].ts + TTL_MS <= now) messages.shift();
  const active = new Set([...sockets].map((s) => s.sid));
  let changed = false;
  for (const [e, c] of claims) {
    if (!active.has(c.sid) && c.lastSeen + TTL_MS <= now) {
      claims.delete(e);
      changed = true;
    }
  }
  for (const [k, b] of buckets) if (now - b.at > 60_000) buckets.delete(k);
  for (const [k, list] of daily) if (!list.length || list[list.length - 1] + TTL_MS <= now) daily.delete(k);
  if (changed) broadcast(presence());
}, 30_000).unref();

// Heartbeat: terminate dead sockets so they don't hold per-IP slots.
setInterval(() => {
  for (const ws of sockets) {
    if (ws.alive === false) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30_000).unref();
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`sha-dow listening on http://localhost:${PORT}`));
}

export { server };
