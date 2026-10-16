// Storage: Redis over the Upstash REST API on Vercel, or an in-memory stand-in locally.
// Both expose exec([[cmd, ...args], ...]) -> results, so the chat logic is identical everywhere.
// Only the commands the chat uses are implemented in memory.

export function createStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisStore(url.replace(/\/$/, ''), token);
  if (process.env.VERCEL) throw new Error('No Redis configured: add a Redis database in Vercel → Storage.');
  return memoryStore();
}

function redisStore(url, token) {
  return {
    async exec(commands) {
      const res = await fetch(`${url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands.map((c) => c.map(String))),
      });
      if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
      const out = await res.json();
      return out.map((r) => {
        if (r.error) throw new Error(`Redis: ${r.error}`);
        return r.result;
      });
    },
  };
}

export function memoryStore() {
  const data = new Map(); // key -> { v, exp }
  const live = (k) => {
    const e = data.get(k);
    if (e && e.exp && e.exp <= Date.now()) {
      data.delete(k);
      return undefined;
    }
    return e;
  };
  const bound = (s, isMax) => {
    s = String(s);
    if (s === '+inf') return { n: Infinity, ex: false };
    if (s === '-inf') return { n: -Infinity, ex: false };
    if (s.startsWith('(')) return { n: Number(s.slice(1)), ex: true };
    return { n: Number(s), ex: false };
  };
  const inRange = (score, lo, hi) =>
    (lo.ex ? score > lo.n : score >= lo.n) && (hi.ex ? score < hi.n : score <= hi.n);
  const zset = (k) => {
    const e = live(k);
    return e ? e.v : null;
  };
  const sorted = (z) => [...z].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));

  const ops = {
    GET: (k) => {
      const e = live(k);
      return e ? e.v : null;
    },
    SET: (k, v, ...opts) => {
      const o = opts.map((x) => String(x).toUpperCase());
      if (o.includes('NX') && live(k)) return null;
      const ex = o.indexOf('EX');
      data.set(k, { v: String(v), exp: ex >= 0 ? Date.now() + Number(opts[ex + 1]) * 1000 : 0 });
      return 'OK';
    },
    DEL: (...ks) => ks.filter((k) => live(k) && data.delete(k)).length,
    INCR: (k) => {
      const e = live(k);
      const n = (e ? Number(e.v) : 0) + 1;
      data.set(k, { v: String(n), exp: e ? e.exp : 0 });
      return n;
    },
    EXPIRE: (k, s) => {
      const e = live(k);
      if (!e) return 0;
      e.exp = Date.now() + Number(s) * 1000;
      return 1;
    },
    HGETALL: (k) => {
      const e = live(k);
      return e ? [...e.v].flat() : [];
    },
    HSET: (k, ...fv) => {
      const e = live(k) || { v: new Map(), exp: 0 };
      data.set(k, e);
      let added = 0;
      for (let i = 0; i < fv.length; i += 2) {
        if (!e.v.has(fv[i])) added++;
        e.v.set(fv[i], String(fv[i + 1]));
      }
      return added;
    },
    HSETNX: (k, f, v) => {
      const e = live(k);
      if (e && e.v.has(f)) return 0;
      return ops.HSET(k, f, v);
    },
    HDEL: (k, ...fs) => {
      const e = live(k);
      return e ? fs.filter((f) => e.v.delete(f)).length : 0;
    },
    ZADD: (k, score, member) => {
      const e = live(k) || { v: new Map(), exp: 0 };
      data.set(k, e);
      const added = e.v.has(member) ? 0 : 1;
      e.v.set(member, Number(score));
      return added;
    },
    ZCARD: (k) => zset(k)?.size || 0,
    // ZRANGE key start stop BYSCORE [REV] [LIMIT offset count]; with REV, start is the max.
    ZRANGE: (k, a, b, ...opts) => {
      const z = zset(k);
      if (!z) return [];
      const o = opts.map((x) => String(x).toUpperCase());
      if (!o.includes('BYSCORE')) throw new Error('memory ZRANGE supports BYSCORE only');
      const rev = o.includes('REV');
      const [lo, hi] = rev ? [bound(b), bound(a)] : [bound(a), bound(b)];
      let list = sorted(z).filter(([, s]) => inRange(s, lo, hi));
      if (rev) list.reverse();
      const li = o.indexOf('LIMIT');
      if (li >= 0) list = list.slice(Number(opts[li + 1]), Number(opts[li + 1]) + Number(opts[li + 2]));
      return list.map(([m]) => m);
    },
    ZREMRANGEBYSCORE: (k, a, b) => {
      const z = zset(k);
      if (!z) return 0;
      const lo = bound(a);
      const hi = bound(b);
      let n = 0;
      for (const [m, s] of z) if (inRange(s, lo, hi) && z.delete(m)) n++;
      return n;
    },
    ZREMRANGEBYRANK: (k, start, stop) => {
      const z = zset(k);
      if (!z) return 0;
      const list = sorted(z);
      const len = list.length;
      const s = Number(start) < 0 ? len + Number(start) : Number(start);
      const e = Number(stop) < 0 ? len + Number(stop) : Number(stop);
      let n = 0;
      for (let i = Math.max(0, s); i <= Math.min(len - 1, e); i++) if (z.delete(list[i][0])) n++;
      return n;
    },
  };

  return {
    async exec(commands) {
      return commands.map(([cmd, ...args]) => {
        const op = ops[String(cmd).toUpperCase()];
        if (!op) throw new Error(`memory store: unsupported ${cmd}`);
        return op(...args.map(String));
      });
    },
  };
}
