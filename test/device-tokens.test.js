import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { issueDeviceToken, validateDeviceToken, revokeUserTokens } from '../server/device-tokens.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function makeUser(db, overrides = {}) {
  return createUser(db, {
    username: overrides.username ?? 'tech1',
    password: 'pw',
    fullName: overrides.fullName ?? 'Tech One',
    role: overrides.role ?? 'technician',
  });
}

test('issue returns a 64-char hex token and stores only its hash', () => {
  const db = openDb(':memory:');
  const user = makeUser(db);
  const { token, expires_at } = issueDeviceToken(db, user.id);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(expires_at);
  const rows = db.prepare('select * from device_tokens').all();
  assert.equal(rows.length, 1);
  for (const row of rows) {
    assert.equal(JSON.stringify(row).includes(token), false, 'the raw token must never be stored');
  }
});

test('validate returns the user for a live token', () => {
  const db = openDb(':memory:');
  const user = makeUser(db);
  const { token } = issueDeviceToken(db, user.id);
  const found = validateDeviceToken(db, token);
  assert.ok(found);
  assert.equal(found.id, user.id);
  assert.equal(found.username, user.username);
});

test('validate returns null for a garbage token', () => {
  const db = openDb(':memory:');
  makeUser(db);
  assert.equal(validateDeviceToken(db, 'not-a-real-token'), null);
  assert.equal(validateDeviceToken(db, ''), null);
  assert.equal(validateDeviceToken(db, null), null);
});

test('validate returns null once expires_at has passed', () => {
  const db = openDb(':memory:');
  const user = makeUser(db);
  // Insert directly rather than mocking Date.now(), so the test exercises
  // the same expiry comparison validateDeviceToken makes on a real row.
  const token = 'a'.repeat(64);
  const hash = createHash('sha256').update(token).digest('hex');
  const past = new Date(Date.now() - 1000).toISOString();
  db.prepare(
    'insert into device_tokens (token_hash, user_id, issued_at, expires_at) values (?,?,?,?)'
  ).run(hash, user.id, past, past);
  assert.equal(validateDeviceToken(db, token), null);
});

test('validate returns null for an inactive user even with a live token', () => {
  const db = openDb(':memory:');
  const user = makeUser(db);
  const { token } = issueDeviceToken(db, user.id);
  db.prepare('update users set active = 0 where id = ?').run(user.id);
  assert.equal(validateDeviceToken(db, token), null);
});

test('revokeUserTokens kills every token for that user and leaves other users alone', () => {
  const db = openDb(':memory:');
  const u1 = makeUser(db, { username: 'tech1' });
  const u2 = makeUser(db, { username: 'tech2' });
  const t1 = issueDeviceToken(db, u1.id);
  const t2 = issueDeviceToken(db, u1.id);
  const t3 = issueDeviceToken(db, u2.id);
  revokeUserTokens(db, u1.id);
  assert.equal(validateDeviceToken(db, t1.token), null);
  assert.equal(validateDeviceToken(db, t2.token), null);
  assert.ok(validateDeviceToken(db, t3.token), "another user's token must survive");
});

test('expiry is 30 days from issue', () => {
  const db = openDb(':memory:');
  const user = makeUser(db);
  const before = Date.now();
  const { expires_at } = issueDeviceToken(db, user.id);
  const after = Date.now();
  const delta = new Date(expires_at).getTime() - before;
  assert.ok(delta >= THIRTY_DAYS_MS, `expected at least 30 days out, got ${delta}ms`);
  assert.ok(delta <= THIRTY_DAYS_MS + (after - before) + 1000, `expected close to 30 days out, got ${delta}ms`);
});
