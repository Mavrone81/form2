import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { hashPassword, verifyPassword, createUser, authenticate, requireRole } from '../server/auth.js';

test('hashing is salted and verifies', () => {
  const a = hashPassword('correct horse');
  const b = hashPassword('correct horse');
  assert.notEqual(a, b, 'same password must not produce the same hash');
  assert.ok(verifyPassword('correct horse', a));
  assert.equal(verifyPassword('wrong', a), false);
});

test('stored hash never contains the plaintext', () => {
  assert.equal(hashPassword('hunter2').includes('hunter2'), false);
});

test('authenticate accepts the right password and rejects the wrong one', () => {
  const db = openDb(':memory:');
  createUser(db, { username: 'tech1', password: 'pw', fullName: 'Tech One', role: 'technician' });
  assert.ok(authenticate(db, 'tech1', 'pw'));
  assert.equal(authenticate(db, 'tech1', 'nope'), null);
  assert.equal(authenticate(db, 'ghost', 'pw'), null);
});

test('an inactive user cannot authenticate', () => {
  const db = openDb(':memory:');
  const u = createUser(db, { username: 'gone', password: 'pw', fullName: 'G', role: 'technician' });
  db.prepare('update users set active = 0 where id = ?').run(u.id);
  assert.equal(authenticate(db, 'gone', 'pw'), null);
});

test('requireRole answers 401 signed out and 403 for the wrong role', () => {
  const run = (user, roles) => {
    const req = { session: user ? { user } : {} };
    let code = 200;
    const res = { status(c) { code = c; return this; }, json() { return this; } };
    let nexted = false;
    requireRole(...roles)(req, res, () => { nexted = true; });
    return { code, nexted };
  };
  assert.equal(run(null, ['admin']).code, 401);
  assert.equal(run({ role: 'technician' }, ['admin']).code, 403);
  assert.equal(run({ role: 'admin' }, ['admin']).nexted, true);
});

test('authenticate never returns password_hash', () => {
  const db = openDb(':memory:');
  createUser(db, { username: 'safe1', password: 'pw', fullName: 'Safe One', role: 'technician' });
  const user = authenticate(db, 'safe1', 'pw');
  assert.ok(user);
  assert.equal('password_hash' in user, false);
});

test('createUser never returns password_hash', () => {
  const db = openDb(':memory:');
  const created = createUser(db, { username: 'safe2', password: 'pw', fullName: 'Safe Two', role: 'technician' });
  assert.equal('password_hash' in created, false);
});

test("createUser's return value still carries the fields callers need", () => {
  const db = openDb(':memory:');
  const created = createUser(db, { username: 'safe3', password: 'pw', fullName: 'Safe Three', role: 'engineer' });
  assert.equal(typeof created.id, 'number');
  assert.equal(created.username, 'safe3');
  assert.equal(created.full_name, 'Safe Three');
  assert.equal(created.role, 'engineer');
});

test('createUser strips password_hash only from the return value — the user is still persisted and authenticable', () => {
  const db = openDb(':memory:');
  createUser(db, { username: 'safe4', password: 'correct-pw', fullName: 'Safe Four', role: 'admin' });
  const row = db.prepare('select password_hash from users where username = ?').get('safe4');
  assert.ok(row.password_hash, 'password_hash must still be stored in the database');
  assert.ok(row.password_hash.startsWith('scrypt$'));
  assert.ok(authenticate(db, 'safe4', 'correct-pw'), 'the stored user must still be able to authenticate');
  assert.equal(authenticate(db, 'safe4', 'wrong-pw'), null);
});

test('createUser with an invalid role throws and creates no row', () => {
  const db = openDb(':memory:');
  assert.throws(() => {
    createUser(db, { username: 'bad1', password: 'pw', fullName: 'Bad One', role: 'superadmin' });
  });
  const row = db.prepare('select * from users where username = ?').get('bad1');
  assert.equal(row, undefined);
});

test('a malformed stored hash fails verification cleanly instead of throwing', () => {
  assert.doesNotThrow(() => {
    assert.equal(verifyPassword('anything', 'garbage'), false);
  });
});

test('verifyPassword returns false, never throws, for other malformed stored shapes', () => {
  const malformed = [
    '',
    'scrypt$salt$hash$extra$segments',
    'scrypt$deadbeef$nothexatall!!',
    null,
    12345,
  ];
  for (const stored of malformed) {
    assert.doesNotThrow(() => {
      assert.equal(verifyPassword('anything', stored), false, `expected false for ${JSON.stringify(stored)}`);
    }, `expected no throw for ${JSON.stringify(stored)}`);
  }
});

test('requireRole denies with 403 when the session user has no role property', () => {
  const req = { session: { user: {} } };
  let code = 200;
  const res = { status(c) { code = c; return this; }, json() { return this; } };
  let nexted = false;
  requireRole('admin')(req, res, () => { nexted = true; });
  assert.equal(code, 403);
  assert.equal(nexted, false);
});

