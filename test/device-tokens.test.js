import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { createApp } from '../server/index.js';
import { seedDemoUsers } from '../server/seed.js';
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

// --- HTTP layer ---
// The two functions above are exercised directly everywhere else in this
// file; these tests exist to prove the two `if` branches in routes.js that
// call them are actually wired up, following the boot()/call() pattern in
// test/api.test.js.

async function boot() {
  const db = openDb(':memory:');
  seedDemoUsers(db, { silent: true });
  const app = createApp({ db });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { db, server, call };
}

test('POST /api/login with wantDeviceToken issues a token; without it, the keys are absent', async () => {
  const { server, call } = await boot();
  const withToken = await call('POST', '/api/login', { username: 'tech', password: 'tech', wantDeviceToken: true });
  assert.equal(withToken.status, 200);
  assert.match(withToken.body.device_token, /^[0-9a-f]{64}$/);
  assert.ok(withToken.body.device_token_expires_at);

  const withoutToken = await call('POST', '/api/login', { username: 'lead', password: 'lead' });
  assert.equal(withoutToken.status, 200);
  assert.equal('device_token' in withoutToken.body, false);
  assert.equal('device_token_expires_at' in withoutToken.body, false);
  server.close();
});

test('deactivating a user via the admin route revokes a device token issued to them', async () => {
  const { db, server, call } = await boot();
  const login = await call('POST', '/api/login', { username: 'tech', password: 'tech', wantDeviceToken: true });
  const token = login.body.device_token;
  assert.ok(validateDeviceToken(db, token), 'token must be live right after issue');

  // Signing in as admin on the same call() re-authenticates that session
  // (login overwrites req.session.user), same as an admin taking over a
  // browser tab after a technician logged in from it.
  await call('POST', '/api/login', { username: 'admin', password: 'admin' });
  const patch = await call('PATCH', '/api/admin/users/1', { active: 0 });
  assert.equal(patch.status, 200);

  // No token-authed route exists yet (that's a later task), so the
  // end-to-end assertion stops at the function the route calls.
  assert.equal(validateDeviceToken(db, token), null, 'a deactivated user\'s token must stop validating');
  server.close();
});
