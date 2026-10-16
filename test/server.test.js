import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { toBinary } from '../public/shared/rules.js';

process.env.DAILY_LIMIT = '3';
process.env.STATIC_DIR = 'public';
const { createServer } = await import('../local-server.js');
const server = createServer();
server.listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function client() {
  const res = await fetch(`${base}/api/chat?a=feed`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (a, body, headers = {}) => {
    const r = await fetch(`${base}/api/chat?a=${a}`, {
      method: body ? 'POST' : 'GET',
      headers: { cookie, origin: base, 'content-type': 'application/json', ...headers },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, ...(await r.json()) };
  };
  return { call, first: await res.json() };
}

test('hardened headers, session cookie, no path traversal', async () => {
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const res = await fetch(`${base}/api/chat?a=feed`);
  assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base + '/../lib/chat.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/lib/chat.js')).status, 404);
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
});

test('version endpoint is CDN-cacheable and sets no cookie', async () => {
  const res = await fetch(`${base}/api/chat?a=ver`);
  assert.match(res.headers.get('cache-control'), /s-maxage=5/);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(typeof (await res.json()).v, 'number');
  assert.equal((await fetch(`${base}/api/chat?a=ver&bust=1`)).status, 400);
});

test('health check reports storage kind and no secrets', async () => {
  const r = await fetch(`${base}/api/chat?a=health`);
  assert.equal(r.status, 200);
  const h = await r.json();
  assert.equal(h.storage, process.env.REDIS_URL ? 'tcp' : 'memory');
  assert.equal(h.ok, true);
  assert.ok(Array.isArray(h.found));
  assert.equal((await fetch(`${base}/api/chat?a=health&x=1`)).status, 400);
});

test('rejects cross-origin, cookieless and non-JSON writes', async () => {
  const { call } = await client();
  assert.equal((await call('claim', { emoji: '🐼' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('claim', { emoji: '🐼' }, { 'content-type': 'text/plain' })).status, 415);
  const r = await fetch(`${base}/api/chat?a=claim`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: '{"emoji":"🐼"}',
  });
  assert.equal(r.status, 403);
});

test('emoji claims, network lock, validation, feed and daily quota', async () => {
  const a = await client();
  const b = await client();
  assert.equal(a.first.me, null);
  assert.equal(a.first.limit, 3);

  assert.equal((await a.call('claim', { emoji: '🦊' })).me, '🦊');
  assert.match((await b.call('claim', { emoji: '🦊' })).error, /taken/);
  assert.match((await b.call('claim', { emoji: '🐙' })).error, /network/); // same IP, other session
  assert.match((await b.call('claim', { emoji: 'X' })).error, /list/);
  assert.match((await b.call('post', { bin: toBinary('hi') })).error, /emoji first/);

  assert.match((await a.call('post', { bin: toBinary('<script>') })).error, /invalid/);
  assert.match((await a.call('post', { bin: 'hello' })).error, /invalid/);

  const before = (await a.call('ver')).v;
  for (const word of ['one', 'two', 'three']) {
    const r = await a.call('post', { bin: toBinary(word) });
    assert.equal(r.m.bin, toBinary(word));
    assert.equal(r.m.emoji, '🦊');
  }
  assert.ok((await a.call('ver')).v > before);
  assert.match((await a.call('post', { bin: toBinary('four') })).error, /Daily limit/);

  // Quota is per network too: another session on this IP is also out.
  const feed = await b.call('feed');
  assert.equal(feed.left, 0);
  assert.deepEqual(feed.posts.slice(-3).map((p) => p.no), [1, 2, 3]);
  assert.ok(feed.taken.includes('🦊'));
  assert.ok(feed.online.includes('🦊'));

  // Switching handles frees the old one.
  assert.equal((await a.call('claim', { emoji: '🐢' })).me, '🐢');
  assert.ok(!(await b.call('feed')).taken.includes('🦊'));
  assert.equal((await a.call('release', {})).me, null);
  assert.equal((await b.call('claim', { emoji: '🦊' })).me, '🦊');
});
