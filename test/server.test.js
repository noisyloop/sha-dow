import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { toBinary } from '../public/shared/rules.js';

process.env.DAILY_LIMIT = '3';
const { server } = await import('../server.js');
server.listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function client(origin = base) {
  const res = await fetch(base + '/');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie, origin } });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  const next = (t) => {
    const i = inbox.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ t, resolve }));
  };
  const sendJson = (o) => ws.send(JSON.stringify(o));
  await once(ws, 'open');
  await next('hello');
  return { ws, next, send: sendJson };
}

test('sets hardened headers and a HttpOnly session cookie', async () => {
  const res = await fetch(base + '/');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base + '/../server.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
});

test('rejects cross-origin websocket', async () => {
  const res = await fetch(base + '/');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie, origin: 'https://evil.example' } });
  const [err] = await once(ws, 'error');
  assert.match(err.message, /403/);
});

test('emoji claims, network lock, validation and daily quota', async () => {
  const a = await client();
  const b = await client();

  a.send({ t: 'claim', emoji: '🦊' });
  assert.equal((await a.next('claimed')).emoji, '🦊');

  b.send({ t: 'claim', emoji: '🦊' });
  assert.match((await b.next('error')).reason, /taken/);

  // Same IP, different session: one emoji per network.
  b.send({ t: 'claim', emoji: '🐙' });
  assert.match((await b.next('error')).reason, /network/);

  b.send({ t: 'claim', emoji: 'X' });
  assert.match((await b.next('error')).reason, /list/);

  a.send({ t: 'post', bin: toBinary('<script>') });
  assert.match((await a.next('error')).reason, /invalid/);

  for (const word of ['one', 'two', 'three']) {
    a.send({ t: 'post', bin: toBinary(word) });
    const { m } = await a.next('msg');
    assert.equal(m.bin, toBinary(word));
    assert.equal(m.emoji, '🦊');
  }
  a.send({ t: 'post', bin: toBinary('four') });
  assert.match((await a.next('error')).reason, /Daily limit/);

  a.ws.close();
  b.ws.close();
});
