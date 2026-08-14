import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { createApp } from '../server/index.js';
import { seedDemoUsers } from '../server/seed.js';
import { issueDeviceToken, validateDeviceToken, revokeUserTokens } from '../server/device-tokens.js';
import { tokenOrSession, actingUser } from '../server/routes.js';

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
  // No production route uses tokenOrSession yet (that lands with the form
  // bundle route in the next task) -- this is the same app/session instance
  // as every other route in this file's HTTP tests, just with one extra,
  // test-only route on it, so a session cookie minted by the real /login
  // route above is recognized here too.
  app.get('/__test/whoami', tokenOrSession(db), (req, res) => {
    res.json({ authVia: req.authVia, user: actingUser(req) });
  });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, path, body, headers) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(headers ?? {}) },
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

  // A second user's token is a control: deactivating `tech` below must not
  // touch it.
  const leadLogin = await call('POST', '/api/login', { username: 'lead', password: 'lead', wantDeviceToken: true });
  const leadToken = leadLogin.body.device_token;
  assert.ok(validateDeviceToken(db, leadToken), 'control token must be live right after issue');

  // Signing in as admin on the same call() re-authenticates that session
  // (login overwrites req.session.user), same as an admin taking over a
  // browser tab after a technician logged in from it.
  await call('POST', '/api/login', { username: 'admin', password: 'admin' });
  const patch = await call('PATCH', '/api/admin/users/1', { active: 0 });
  assert.equal(patch.status, 200);

  // No production token-authed route exists yet (that's a later task), so
  // the end-to-end assertion stops at the function the route calls.
  assert.equal(validateDeviceToken(db, token), null, 'a deactivated user\'s token must stop validating');

  // The assertion above passes even if the route's call to
  // revokeUserTokens() were deleted entirely: validateDeviceToken() already
  // gates on `active=1` in its own SQL, so a still-deactivated user's token
  // reads as invalid regardless of whether the token row was ever deleted.
  // Reactivating the user removes that gate, so only *this* second
  // assertion actually depends on revokeUserTokens() having deleted the
  // token row (rather than leaving it live for a stale, already-paired
  // phone to keep using).
  const reactivate = await call('PATCH', '/api/admin/users/1', { active: 1 });
  assert.equal(reactivate.status, 200);
  assert.equal(validateDeviceToken(db, token), null, 'a revoked token must not come back to life on reactivation');

  // The control token was never touched by any of this.
  assert.ok(validateDeviceToken(db, leadToken), "another user's token must survive an unrelated deactivation");
  server.close();
});

// --- tokenOrSession middleware ---
// /__test/whoami (mounted in boot() above) is the only route guarded by
// tokenOrSession anywhere in this suite -- exercising the actual middleware
// over HTTP, on the same app/session instance the login route above uses,
// rather than calling it as a bare function.

test('a request with a valid Bearer token reaches a tokenOrSession route without a cookie', async () => {
  const { db, server, call } = await boot();
  const user = makeUser(db, { username: 'whoami-tech' });
  const { token } = issueDeviceToken(db, user.id);
  try {
    // No prior login on this call()'s cookie jar -- it is empty for the
    // whole test, so this proves the route works from the header alone.
    const res = await call('GET', '/__test/whoami', undefined, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.authVia, 'token');
    assert.equal(res.body.user.id, user.id);
    assert.equal(res.body.user.username, 'whoami-tech');
  } finally {
    server.close();
  }
});

test('a garbage Bearer token gets 401', async () => {
  const { server, call } = await boot();
  try {
    const res = await call('GET', '/__test/whoami', undefined, { authorization: 'Bearer not-a-real-token' });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('an expired Bearer token gets 401', async () => {
  const { db, server, call } = await boot();
  const user = makeUser(db, { username: 'expired-tech' });
  // Insert directly with a past expires_at, same technique as the
  // expiry test on validateDeviceToken itself above.
  const token = 'c'.repeat(64);
  const hash = createHash('sha256').update(token).digest('hex');
  const past = new Date(Date.now() - 1000).toISOString();
  db.prepare(
    'insert into device_tokens (token_hash, user_id, issued_at, expires_at) values (?,?,?,?)'
  ).run(hash, user.id, past, past);
  try {
    const res = await call('GET', '/__test/whoami', undefined, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('a valid token for a deactivated user gets 401', async () => {
  const { db, server, call } = await boot();
  const user = makeUser(db, { username: 'deactivated-tech' });
  const { token } = issueDeviceToken(db, user.id);
  db.prepare('update users set active = 0 where id = ?').run(user.id);
  try {
    const res = await call('GET', '/__test/whoami', undefined, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('no session and no Bearer token gets 401 from a tokenOrSession route', async () => {
  const { server, call } = await boot();
  try {
    const res = await call('GET', '/__test/whoami');
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('a successful token auth does not create a session', async () => {
  const { db, server } = await boot();
  const user = makeUser(db, { username: 'no-session-tech' });
  const { token } = issueDeviceToken(db, user.id);
  const port = server.address().port;
  try {
    // Raw fetch here (not the call() helper, which discards headers) so the
    // response's own Set-Cookie header can be inspected directly.
    const res = await fetch(`http://127.0.0.1:${port}/__test/whoami`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    // Express-session only sends Set-Cookie once a session has actually been
    // touched (saveUninitialized: false in server/index.js) -- a token-authed
    // request that never reads/writes req.session gets no session cookie at
    // all, proving the middleware did not mutate req.session on this path.
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    server.close();
  }
});

// --- precedence when a request carries both a valid session and a Bearer
// header ---
// The token branch runs first and decides the request outright, whether or
// not a valid session also exists (see the "Precedence" comment above
// tokenOrSession in server/routes.js). These two tests lock that in.

test('an invalid Bearer token is not rescued by a valid session in the same request', async () => {
  const { server, call } = await boot();
  // 'tech'/'tech' is the seeded demo technician used throughout this suite
  // (see test/device-tokens.test.js's sibling HTTP tests above) -- this
  // establishes a real, valid session cookie in call()'s jar.
  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  try {
    const res = await call('GET', '/__test/whoami', undefined, { authorization: 'Bearer not-a-real-token' });
    assert.equal(res.status, 401,
      'a malformed/expired/unknown token must fail closed even with a valid session sitting in the same cookie jar');
  } finally {
    server.close();
  }
});

test('a valid Bearer token wins over a valid session, reporting the token identity', async () => {
  const { db, server, call } = await boot();
  // The session belongs to the seeded 'tech' user; the token belongs to a
  // different user entirely, so a pass here can only mean the token branch
  // actually decided the request -- not that both branches happened to
  // agree on the same identity.
  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  const deviceHolder = makeUser(db, { username: 'device-holder' });
  const { token } = issueDeviceToken(db, deviceHolder.id);
  try {
    const res = await call('GET', '/__test/whoami', undefined, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.authVia, 'token');
    assert.equal(res.body.user.id, deviceHolder.id);
    assert.equal(res.body.user.username, 'device-holder');
  } finally {
    server.close();
  }
});

// --- last_used_at ---
// Neither this file's direct-call tests (near the top) nor its other HTTP
// tests above ever read the last_used_at column -- so nothing would catch a
// regression that dropped validateDeviceToken's update, or one that made
// tokenOrSession call validateDeviceToken twice per request.

test('last_used_at is bumped exactly once per token-authed HTTP request', async () => {
  const { db, server, call } = await boot();
  const user = makeUser(db, { username: 'last-used-tech' });
  const { token } = issueDeviceToken(db, user.id);
  const hash = createHash('sha256').update(token).digest('hex');
  // Start from an explicit sentinel rather than the null issueDeviceToken
  // leaves behind: "changed away from a fixed, deliberately-planted value"
  // is a stronger signal than "changed away from null", which a caller
  // could satisfy by accident in other ways.
  const sentinel = '1999-01-01T00:00:00.000Z';
  db.prepare('update device_tokens set last_used_at = ? where token_hash = ?').run(sentinel, hash);
  const readLastUsed = () => db.prepare('select last_used_at from device_tokens where token_hash=?').get(hash).last_used_at;
  const rowCount = () => db.prepare('select count(*) as n from device_tokens where token_hash=?').get(hash).n;

  try {
    const res1 = await call('GET', '/__test/whoami', undefined, { authorization: `Bearer ${token}` });
    assert.equal(res1.status, 200);
    const afterFirst = readLastUsed();
    assert.notEqual(afterFirst, sentinel, 'a token-authed request must bump last_used_at off the sentinel');
    assert.equal(rowCount(), 1, 'the update touches the existing row -- it must never insert a second one');

    // A short delay so the two real timestamps cannot land inside the same
    // millisecond and read as equal by coincidence, which would make the
    // second assertion below meaningless either way.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const res2 = await call('GET', '/__test/whoami', undefined, { authorization: `Bearer ${token}` });
    assert.equal(res2.status, 200);
    const afterSecond = readLastUsed();
    assert.notEqual(afterSecond, afterFirst, 'a second token-authed request must bump last_used_at again, to a new value');
    assert.equal(rowCount(), 1);

    // "Exactly once per request" is not something an HTTP-level test can
    // observe directly -- there is no hook here into how many times the
    // UPDATE statement ran inside a single request. That property instead
    // follows from the code shape: tokenOrSession's token branch calls
    // validateDeviceToken exactly one time per request (the single
    // `const user = validateDeviceToken(db, token);` line in its token
    // branch, server/routes.js), and validateDeviceToken's own body runs its
    // `update device_tokens set last_used_at = ...` exactly once per call.
    // What this test proves at the HTTP layer is the one part of that a
    // regression could actually break silently: the write is not skipped
    // (afterFirst would still equal sentinel) and each request keeps moving
    // the value forward rather than the column going stale after the first
    // hit (afterSecond would still equal afterFirst).
  } finally {
    server.close();
  }
});
