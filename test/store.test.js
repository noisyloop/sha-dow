import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { memoryStore, findRedisConfig, storageVarNames } from '../lib/store.js';
import { SECURITY_HEADERS } from '../lib/headers.js';

test('memory store mirrors the Redis commands the chat uses', async () => {
  const s = memoryStore();
  const r = await s.exec([
    ['SET', 'k', 'a', 'NX', 'EX', 10],
    ['SET', 'k', 'b', 'NX', 'EX', 10],
    ['GET', 'k'],
    ['INCR', 'n'],
    ['INCR', 'n'],
    ['HSETNX', 'h', 'f', '1'],
    ['HSETNX', 'h', 'f', '2'],
    ['HGETALL', 'h'],
    ['ZADD', 'z', 1, 'a'],
    ['ZADD', 'z', 2, 'b'],
    ['ZADD', 'z', 3, 'c'],
    ['ZRANGE', 'z', '+inf', '(1', 'BYSCORE', 'REV', 'LIMIT', 0, 1],
    ['ZRANGE', 'z', '-inf', '+inf', 'BYSCORE'],
    ['ZREMRANGEBYRANK', 'z', 0, -3],
    ['ZCARD', 'z'],
    ['ZREMRANGEBYSCORE', 'z', '-inf', 2],
    ['ZCARD', 'z'],
  ]);
  assert.deepEqual(r, ['OK', null, 'a', 1, 2, 1, 0, ['f', '1'], 1, 1, 1, ['c'], ['a', 'b', 'c'], 1, 2, 1, 1]);
});

test('memory store expires keys', async () => {
  const s = memoryStore();
  await s.exec([['SET', 'k', 'v', 'EX', 0.05]]);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(await s.exec([['GET', 'k']]), [null]);
});

test('vercel.json serves the build and sends the same security headers', () => {
  const cfg = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  assert.equal(cfg.outputDirectory, 'dist');
  const sent = Object.fromEntries(cfg.headers[0].headers.map((h) => [h.key, h.value]));
  assert.deepEqual(sent, SECURITY_HEADERS);
});

test('Vercel function explains missing storage instead of crashing', async () => {
  process.env.VERCEL = '1';
  const { default: chat } = await import('../api/chat.js?missing');
  let status;
  let body;
  await chat({ url: '/api/chat?a=ver', headers: {} }, { writeHead: (s) => (status = s), end: (b) => (body = b) });
  delete process.env.VERCEL;
  assert.equal(status, 503);
  assert.match(JSON.parse(body).error, /Storage/);
});

test('finds Redis settings under every naming Vercel integrations use', () => {
  const rest = (env) => findRedisConfig(env);
  assert.equal(rest({ KV_REST_API_URL: 'https://a', KV_REST_API_TOKEN: 't' }).kind, 'rest');
  assert.equal(rest({ UPSTASH_REDIS_REST_URL: 'https://a', UPSTASH_REDIS_REST_TOKEN: 't' }).kind, 'rest');
  assert.deepEqual(rest({ STORAGE_KV_REST_API_URL: 'https://a', STORAGE_KV_REST_API_TOKEN: 't' }).vars, [
    'STORAGE_KV_REST_API_URL',
    'STORAGE_KV_REST_API_TOKEN',
  ]);
  assert.equal(rest({ REDIS_URL: 'rediss://default:x@h:6379' }).kind, 'tcp');
  assert.equal(rest({ KV_URL: 'redis://h:6379' }).kind, 'tcp');
  assert.equal(rest({ SHADOW_REDIS_URL: 'rediss://h:6379' }).kind, 'tcp');
  assert.equal(rest({ KV_REST_API_URL: 'https://a' }).kind, 'none'); // token missing
  assert.equal(rest({ REDIS_URL: 'not-a-url' }).kind, 'none');
  assert.equal(rest({}).kind, 'none');
});

test('health lists storage variable names only', () => {
  const names = storageVarNames({ REDIS_URL: 'rediss://secret', KV_REST_API_TOKEN: 'secret', PATH: '/bin' });
  assert.deepEqual(names, ['KV_REST_API_TOKEN', 'REDIS_URL']);
});
