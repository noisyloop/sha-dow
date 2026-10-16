import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlaintext, sanitizeInput, toBinary, decodeBinary, isValidEmoji, EMOJIS } from '../public/shared/rules.js';

test('round-trips plain text through binary', () => {
  const bin = toBinary('Hi there!');
  assert.match(bin, /^[01]{8}( [01]{8})*$/);
  assert.equal(decodeBinary(bin), 'Hi there!');
});

test('rejects markup, code and URLs', () => {
  for (const s of ['<script>alert(1)</script>', '{{7*7}}', 'a=b', 'https://x.y', '`rm`', '${x}', 'émoji', '😀', 'tab\there'])
    assert.ok(checkPlaintext(s), s);
});

test('rejects pre-encoded blobs', () => {
  for (const s of ['01001000 01101001', 'deadbeefcafe1234', 'SGVsbG8gV29ybGQh1', 'a'.repeat(25)])
    assert.ok(checkPlaintext(s), s);
  assert.equal(checkPlaintext("It's fine, really (ok)."), null);
});

test('server-side decode rejects smuggled bytes', () => {
  assert.equal(decodeBinary(toBinary('<b>')), null);
  assert.equal(decodeBinary('0100100'), null); // 7 bits
  assert.equal(decodeBinary('11111111'), null); // non-ASCII
  assert.equal(decodeBinary(toBinary(' hi')), null); // untrimmed
  assert.equal(decodeBinary(toBinary('x'.repeat(10) + ' ').repeat(30)), null); // too long
  assert.equal(decodeBinary({}), null);
});

test('sanitizeInput strips disallowed characters', () => {
  assert.equal(sanitizeInput('hi <b>you</b> 😀'), 'hi byoub ');
});

test('only curated emoji are valid handles', () => {
  assert.equal(new Set(EMOJIS).size, EMOJIS.length);
  assert.ok(isValidEmoji('🦊'));
  assert.ok(!isValidEmoji('🦊‍'));
  assert.ok(!isValidEmoji('A'));
});
