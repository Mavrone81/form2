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

// --- sliding expiry (I4) ---
// The spec's rule is "signed out after 30 days without an online sign-in", so
// the 30 days must run from the device's LAST contact, not from the day it
// was paired. A token validated while it is close to expiry is renewed for a
// full 30 days by the same write that stamps last_used_at.

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

// Plants a token row with an arbitrary expires_at, so a test can sit at any
// point in a token's life without waiting or mocking the clock. Same
// insert-directly technique the expiry tests above already use.
function plantToken(db, userId, { token, expiresAt, issuedAt }) {
  const hash = createHash('sha256').update(token).digest('hex');
  db.prepare('insert into device_tokens (token_hash, user_id, issued_at, expires_at) values (?,?,?,?)')
    .run(hash, userId, issuedAt ?? new Date().toISOString(), expiresAt);
  return hash;
}

const expiryOf = (db, hash) =>
  db.prepare('select expires_at from device_tokens where token_hash=?').get(hash).expires_at;

test('validating a token that is close to expiry slides it out to a full 30 days', () => {
  const db = openDb(':memory:');
  const user = makeUser(db);
  const token = 'd'.repeat(64);
  // 10 days left: inside the 15-day renewal window.
  const nearExpiry = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const hash = plantToken(db, user.id, { token, expiresAt: nearExpiry });

  const before = Date.now();
  assert.ok(validateDeviceToken(db, token), 'a live token must still validate');
  const after = Date.now();

  const renewed = new Date(expiryOf(db, hash)).getTime();
  assert.ok(renewed > new Date(nearExpiry).getTime(), 'the expiry must have moved forward');
  assert.ok(renewed >= before + THIRTY_DAYS_MS, `expected at least 30 days out, got ${renewed - before}ms`);
  assert.ok(renewed <= after + THIRTY_DAYS_MS + 1000, `expected close to 30 days out, got ${renewed - before}ms`);
});

test('validating a token that is far from expiry leaves its expiry exactly where it was', () => {
  const db = openDb(':memory:');
  const user = makeUser(db);
  const token = 'e'.repeat(64);
  // 25 days left: outside the 15-day renewal window, so nothing to renew.
  const farExpiry = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString();
  const hash = plantToken(db, user.id, { token, expiresAt: farExpiry });

  assert.ok(validateDeviceToken(db, token));
  assert.equal(expiryOf(db, hash), farExpiry, 'a token nowhere near expiry must not be rewritten');

  // ...and last_used_at still moved, so "no renewal" is not "no write at all".
  const lastUsed = db.prepare('select last_used_at from device_tokens where token_hash=?').get(hash).last_used_at;
  assert.ok(lastUsed, 'last_used_at must still be stamped on a non-renewing validation');

  // A freshly issued token is 30 days out, i.e. also outside the window --
  // proving the renewal threshold is genuinely below the full TTL and not
  // "renew on every request".
  const fresh = issueDeviceToken(db, user.id);
  const freshHash = createHash('sha256').update(fresh.token).digest('hex');
  assert.ok(validateDeviceToken(db, fresh.token));
  assert.equal(expiryOf(db, freshHash), fresh.expires_at);
});

test('an already-expired token is never resurrected by validation', () => {
  const db = openDb(':memory:');
  const user = makeUser(db);
  const token = 'f'.repeat(64);
  const past = new Date(Date.now() - 1000).toISOString();
  const hash = plantToken(db, user.id, { token, expiresAt: past, issuedAt: past });

  assert.equal(validateDeviceToken(db, token), null);
  assert.equal(expiryOf(db, hash), past, 'a dead token must stay dead -- the slide only applies to a LIVE one');
  // And again, to be sure a second attempt cannot walk it back to life either.
  assert.equal(validateDeviceToken(db, token), null);
  assert.equal(expiryOf(db, hash), past);
});

test('the renewal threshold is 15 days: a token just inside it slides, one just outside does not', () => {
  const db = openDb(':memory:');
  const user = makeUser(db);
  const inside = 'a1'.repeat(32);
  const outside = 'b2'.repeat(32);
  // A minute either side of the boundary, so this pins the threshold itself
  // rather than merely "somewhere between 10 and 25 days".
  const insideAt = new Date(Date.now() + FIFTEEN_DAYS_MS - 60_000).toISOString();
  const outsideAt = new Date(Date.now() + FIFTEEN_DAYS_MS + 60_000).toISOString();
  const insideHash = plantToken(db, user.id, { token: inside, expiresAt: insideAt });
  const outsideHash = plantToken(db, user.id, { token: outside, expiresAt: outsideAt });

  assert.ok(validateDeviceToken(db, inside));
  assert.ok(validateDeviceToken(db, outside));

  assert.notEqual(expiryOf(db, insideHash), insideAt, 'just inside 15 days must renew');
  assert.equal(expiryOf(db, outsideHash), outsideAt, 'just outside 15 days must not');
});

// --- opportunistic cleanup on issue (I6) ---

test('issuing a token deletes that user\'s expired rows, and only that user\'s', () => {
  const db = openDb(':memory:');
  const mine = makeUser(db, { username: 'cleanup-mine' });
  const other = makeUser(db, { username: 'cleanup-other' });
  const past = new Date(Date.now() - 1000).toISOString();

  const myDead = plantToken(db, mine.id, { token: 'c1'.repeat(32), expiresAt: past, issuedAt: past });
  const theirDead = plantToken(db, other.id, { token: 'c2'.repeat(32), expiresAt: past, issuedAt: past });
  const myLive = issueDeviceToken(db, mine.id);
  const myLiveHash = createHash('sha256').update(myLive.token).digest('hex');

  const rows = (hash) => db.prepare('select count(*) n from device_tokens where token_hash=?').get(hash).n;
  // The issue above already ran the cleanup once; assert on its effect.
  assert.equal(rows(myDead), 0, 'this user\'s expired row must be swept on issue');
  assert.equal(rows(theirDead), 1, 'another user\'s expired row must be left alone');
  assert.equal(rows(myLiveHash), 1, 'the token just issued must survive its own cleanup');

  // A live row of the same user is never swept either.
  issueDeviceToken(db, mine.id);
  assert.equal(rows(myLiveHash), 1, 'a LIVE row must survive a later issue for the same user');
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

// --- POST /logout revokes the presented device token (I6) ---

test('logging out with a Bearer token revokes THAT token and leaves the user\'s other devices alone', async () => {
  const { db, server, call } = await boot();
  try {
    const login = await call('POST', '/api/login', { username: 'tech', password: 'tech', wantDeviceToken: true });
    const signingOut = login.body.device_token;
    // A second device of the SAME user -- the control that proves this is a
    // per-device sign-out, not a per-account one.
    const otherDevice = issueDeviceToken(db, db.prepare("select id from users where username='tech'").get().id).token;
    assert.ok(validateDeviceToken(db, signingOut));
    assert.ok(validateDeviceToken(db, otherDevice));

    const res = await call('POST', '/api/logout', undefined, { authorization: `Bearer ${signingOut}` });
    assert.equal(res.status, 200);

    assert.equal(validateDeviceToken(db, signingOut), null, 'the presented token must stop working immediately');
    assert.ok(validateDeviceToken(db, otherDevice), "this user's other paired device must keep working");
  } finally {
    server.close();
  }
});

test('a session-only logout revokes nothing -- the browser path is unchanged', async () => {
  const { db, server, call } = await boot();
  try {
    const login = await call('POST', '/api/login', { username: 'tech', password: 'tech', wantDeviceToken: true });
    const token = login.body.device_token;
    // No Authorization header at all: exactly what the web client sends.
    const res = await call('POST', '/api/logout');
    assert.equal(res.status, 200);
    assert.ok(validateDeviceToken(db, token), 'a browser sign-out must not surrender the device credential');
  } finally {
    server.close();
  }
});

test('logging out with a garbage Bearer token is still a plain 200 and revokes nothing else', async () => {
  const { db, server, call } = await boot();
  try {
    const login = await call('POST', '/api/login', { username: 'tech', password: 'tech', wantDeviceToken: true });
    const token = login.body.device_token;
    const res = await call('POST', '/api/logout', undefined, { authorization: 'Bearer not-a-real-token' });
    assert.equal(res.status, 200, 'logout is best-effort -- an unknown token is not an error to report');
    assert.ok(validateDeviceToken(db, token), 'an unknown token must delete nothing');
  } finally {
    server.close();
  }
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
