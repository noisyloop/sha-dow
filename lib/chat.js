// sha-dow chat API. Stateless: every request reads/writes the store, so it runs on Vercel functions.
//   GET  /api/chat?a=ver          -> { v }            tiny, CDN-cached for a few seconds, shared by everyone
//   GET  /api/chat?a=feed&since=  -> posts + presence + your handle/quota (only fetched when v changes)
//   POST /api/chat?a=claim|release|ping|post   JSON body
import crypto from 'node:crypto';
import { TTL_MS, isValidEmoji, decodeBinary } from '../public/shared/rules.js';
import { storageVarNames } from './store.js';

const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 100;
const TTL_S = TTL_MS / 1000;
const MAX_POSTS = 2000;
const FEED_LIMIT = 200;
const ONLINE_MS = 150_000; // clients ping every 60s
const COOKIE = 'sd_sid';
const ON_VERCEL = Boolean(process.env.VERCEL);
const TRUST_PROXY = ON_VERCEL || process.env.TRUST_PROXY === '1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

const K = {
  ver: 'sd:ver',
  no: 'sd:no',
  posts: 'sd:posts',
  claims: 'sd:claims', // hash emoji -> {"sid","ip","seen"}
  salt: 'sd:salt',
};

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
  }
}

function getCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE && /^[a-f0-9]{64}$/.test(v || '')) return v;
  }
  return null;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function rawIp(req) {
  let ip = req.socket?.remoteAddress || '';
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) ip = fwd;
  }
  ip = ip.replace(/^::ffff:/, '');
  // IPv6 users get whole /64 blocks; treat the block as one network.
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}

// Raw IPs are never stored: they're HMACed with a salt that lives in the store and rotates every 24h.
let saltCache = null;
async function ipHash(store, req) {
  if (!saltCache || saltCache.until < Date.now()) {
    const fresh = crypto.randomBytes(32).toString('hex');
    const [, salt] = await store.exec([['SET', K.salt, fresh, 'NX', 'EX', TTL_S], ['GET', K.salt]]);
    saltCache = { salt, until: Date.now() + 10 * 60_000 };
  }
  return crypto.createHmac('sha256', saltCache.salt).update(rawIp(req)).digest('hex').slice(0, 32);
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON only.');
  if ('body' in req) {
    // Vercel parses the body lazily and throws on invalid JSON.
    let body;
    try {
      body = req.body;
    } catch {
      throw new HttpError(400, 'Bad JSON.');
    }
    if (JSON.stringify(body ?? {}).length > 4096) throw new HttpError(413, 'Too large.');
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        throw new HttpError(400, 'Bad JSON.');
      }
    }
    return body ?? {};
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4096) throw new HttpError(413, 'Too large.');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new HttpError(400, 'Bad JSON.');
  }
}

// Fixed-window counter: `max` hits per `windowS` seconds.
async function limit(store, key, max, windowS) {
  const [, n] = await store.exec([['SET', key, 0, 'NX', 'EX', windowS], ['INCR', key]]);
  return n <= max;
}

function parseClaims(flat, now) {
  const claims = new Map();
  for (let i = 0; i < flat.length; i += 2) {
    try {
      const c = JSON.parse(flat[i + 1]);
      if (c.seen + TTL_MS > now) claims.set(flat[i], c);
    } catch {}
  }
  return claims;
}
const emojiOf = (claims, sid) => [...claims].find(([, c]) => c.sid === sid)?.[0] || null;
const quotaKeys = (sid, ip) => [`sd:q:s:${sid}`, `sd:q:i:${ip}`];

async function quotaLeft(store, sid, ip, now) {
  const cmds = quotaKeys(sid, ip).flatMap((k) => [['ZREMRANGEBYSCORE', k, '-inf', now - TTL_MS], ['ZCARD', k]]);
  const r = await store.exec(cmds);
  return Math.max(0, DAILY_LIMIT - Math.max(r[1], r[3]));
}

// ---------- actions ----------
async function feed(store, ctx, query) {
  const now = Date.now();
  const since = Math.max(Number(query.get('since')) || 0, now - TTL_MS);
  const [v, posts, flat] = await store.exec([
    ['GET', K.ver],
    ['ZRANGE', K.posts, '+inf', `(${since}`, 'BYSCORE', 'REV', 'LIMIT', 0, FEED_LIMIT],
    ['HGETALL', K.claims],
  ]);
  const claims = parseClaims(flat, now);
  const parsed = [];
  for (const p of posts.reverse()) {
    try {
      parsed.push(JSON.parse(p));
    } catch {}
  }
  return {
    now,
    v: Number(v) || 0,
    posts: parsed,
    taken: [...claims.keys()],
    online: [...claims].filter(([, c]) => c.seen + ONLINE_MS > now).map(([e]) => e),
    me: emojiOf(claims, ctx.sid),
    left: await quotaLeft(store, ctx.sid, ctx.ip, now),
    limit: DAILY_LIMIT,
  };
}

async function claim(store, ctx, body) {
  const emoji = body.emoji;
  if (!isValidEmoji(emoji)) throw new HttpError(400, 'Pick an emoji from the list.');
  // Short per-network lock so two sessions on one IP can't race for two emoji.
  const [locked] = await store.exec([['SET', `sd:lock:${ctx.ip}`, 1, 'NX', 'EX', 5]]);
  if (!locked) throw new HttpError(429, 'One moment, try again.');
  try {
    const now = Date.now();
    const [flat] = await store.exec([['HGETALL', K.claims]]);
    const claims = parseClaims(flat, now);
    const held = claims.get(emoji);
    if (held && held.sid !== ctx.sid) throw new HttpError(409, `${emoji} is taken. Pick another.`);
    for (const [e, c] of claims)
      if (e !== emoji && c.ip === ctx.ip && c.sid !== ctx.sid) throw new HttpError(409, `Your network already uses ${e}.`);

    const val = JSON.stringify({ sid: ctx.sid, ip: ctx.ip, seen: now });
    // Expired fields are still physically present; clear them so HSETNX can succeed.
    const stale = [];
    for (let i = 0; i < flat.length; i += 2) if (!claims.has(flat[i])) stale.push(flat[i]);
    if (stale.length) await store.exec([['HDEL', K.claims, ...stale]]);
    if (held) await store.exec([['HSET', K.claims, emoji, val]]);
    else {
      const [ok] = await store.exec([['HSETNX', K.claims, emoji, val]]);
      if (!ok) throw new HttpError(409, `${emoji} was just taken. Pick another.`);
    }
    const mine = [...claims].filter(([e, c]) => c.sid === ctx.sid && e !== emoji).map(([e]) => e);
    await store.exec([...(mine.length ? [['HDEL', K.claims, ...mine]] : []), ['INCR', K.ver], ['EXPIRE', K.claims, TTL_S]]);
    return { me: emoji };
  } finally {
    await store.exec([['DEL', `sd:lock:${ctx.ip}`]]);
  }
}

async function release(store, ctx) {
  const [flat] = await store.exec([['HGETALL', K.claims]]);
  const mine = emojiOf(parseClaims(flat, Date.now()), ctx.sid);
  if (mine) await store.exec([['HDEL', K.claims, mine], ['INCR', K.ver]]);
  return { me: null };
}

async function ping(store, ctx) {
  const now = Date.now();
  const [flat] = await store.exec([['HGETALL', K.claims]]);
  const claims = parseClaims(flat, now);
  const mine = emojiOf(claims, ctx.sid);
  if (!mine) return { me: null };
  const wasOffline = claims.get(mine).seen + ONLINE_MS <= now;
  await store.exec([
    ['HSET', K.claims, mine, JSON.stringify({ ...claims.get(mine), seen: now })],
    ['EXPIRE', K.claims, TTL_S],
    ...(wasOffline ? [['INCR', K.ver]] : []),
  ]);
  return { me: mine };
}

async function post(store, ctx, body) {
  const now = Date.now();
  const [flat] = await store.exec([['HGETALL', K.claims]]);
  const claims = parseClaims(flat, now);
  const emoji = emojiOf(claims, ctx.sid);
  if (!emoji) throw new HttpError(403, 'Pick an emoji first.');
  if (decodeBinary(body.bin) === null) throw new HttpError(400, 'Rejected: invalid characters.');
  if ((await quotaLeft(store, ctx.sid, ctx.ip, now)) === 0)
    throw new HttpError(429, `Daily limit reached (${DAILY_LIMIT} posts per 24h).`);
  if (!(await limit(store, `sd:b:s:${ctx.sid}`, 5, 15)) || !(await limit(store, `sd:b:i:${ctx.ip}`, 10, 15)))
    throw new HttpError(429, 'Slow down.');
  const [dup] = await store.exec([['SET', `sd:last:${emoji}`, body.bin, 'NX', 'EX', 60]]);
  if (!dup) {
    const [last] = await store.exec([['GET', `sd:last:${emoji}`]]);
    if (last === body.bin) throw new HttpError(409, 'No duplicate posts.');
    await store.exec([['SET', `sd:last:${emoji}`, body.bin, 'EX', 60]]);
  }

  const [no] = await store.exec([['INCR', K.no]]);
  const m = { id: crypto.randomUUID(), no, emoji, bin: body.bin, ts: now };
  const [qs, qi] = quotaKeys(ctx.sid, ctx.ip);
  const tag = `${now}:${m.id}`;
  await store.exec([
    ['ZADD', K.posts, now, JSON.stringify(m)],
    ['ZREMRANGEBYSCORE', K.posts, '-inf', now - TTL_MS],
    ['ZREMRANGEBYRANK', K.posts, 0, -(MAX_POSTS + 1)],
    ['EXPIRE', K.posts, TTL_S],
    ['ZADD', qs, now, tag],
    ['EXPIRE', qs, TTL_S],
    ['ZADD', qi, now, tag],
    ['EXPIRE', qi, TTL_S],
    ['HSET', K.claims, emoji, JSON.stringify({ ...claims.get(emoji), seen: now })],
    ['INCR', K.ver],
  ]);
  return { m, left: await quotaLeft(store, ctx.sid, ctx.ip, now) };
}

// ---------- entry point ----------
export async function handle(req, res, store) {
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('a');

    if (req.method === 'GET' && action === 'health') {
      // Diagnostics without secrets: which storage is in use and whether it answers.
      if (url.search !== '?a=health') throw new HttpError(400, 'Bad request.');
      let ok = false;
      try {
        ok = (await store.exec([['GET', K.ver]])).length === 1;
      } catch (err) {
        console.error('health:', err.message);
      }
      return send(ok ? 200 : 503, { storage: store.kind || 'custom', ok, found: storageVarNames() }, {
        'Cache-Control': 'public, max-age=0, s-maxage=10',
      });
    }

    if (req.method === 'GET' && action === 'ver') {
      // Exact URL only, so nobody can bust the shared CDN cache with extra query params.
      if (url.search !== '?a=ver') throw new HttpError(400, 'Bad request.');
      const [v] = await store.exec([['GET', K.ver]]);
      // Shared CDN cache: all viewers polling within the window cost one store read.
      return send(200, { v: Number(v) || 0 }, { 'Cache-Control': 'public, max-age=0, s-maxage=5' });
    }

    const headers = {};
    let sid = getCookie(req);
    if (!sid) {
      if (req.method !== 'GET') throw new HttpError(403, 'Reload the page.');
      sid = crypto.randomBytes(32).toString('hex');
      const secure = TRUST_PROXY ? '; Secure' : '';
      headers['Set-Cookie'] = `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_S}${secure}`;
    }
    const ctx = { sid, ip: await ipHash(store, req) };
    if (!(await limit(store, `sd:r:${ctx.ip}`, 40, 10))) throw new HttpError(429, 'Slow down.');

    if (req.method === 'GET' && action === 'feed') return send(200, await feed(store, ctx, url.searchParams), headers);

    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (!sameOrigin(req)) throw new HttpError(403, 'Bad origin.');
    const body = await readJson(req);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Bad request.');
    const actions = { claim, release, ping, post };
    if (!Object.hasOwn(actions, action)) throw new HttpError(404, 'Unknown action.');
    return send(200, await actions[action](store, ctx, body), headers);
  } catch (err) {
    if (err instanceof HttpError) return send(err.status, { error: err.message });
    console.error(err);
    return send(500, { error: 'Server error. Try again.' });
  }
}
