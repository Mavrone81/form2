import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginThrottle, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS } from '../server/login-throttle.js';

test('blocks only after the fifth failure', () => {
  const t = createLoginThrottle();
  const k = t.key('tech1', '1.1.1.1');
  for (let i = 0; i < LOGIN_MAX_FAILS - 1; i++) {
    t.fail(k);
    assert.equal(t.blocked(k), false, `blocked too early after ${i + 1} failures`);
  }
  t.fail(k);
  assert.equal(t.blocked(k), true);
});

test('locking one account does not lock another at the same address', () => {
  // Otherwise five wrong guesses at a known username take out everyone else
  // behind the same office connection.
  const t = createLoginThrottle();
  const victim = t.key('tech1', '1.1.1.1');
  const other = t.key('tech2', '1.1.1.1');
  for (let i = 0; i < LOGIN_MAX_FAILS; i++) t.fail(victim);
  assert.equal(t.blocked(victim), true);
  assert.equal(t.blocked(other), false);
});

test('the same account from a different address is counted separately', () => {
  const t = createLoginThrottle();
  const here = t.key('tech1', '1.1.1.1');
  const there = t.key('tech1', '2.2.2.2');
  for (let i = 0; i < LOGIN_MAX_FAILS; i++) t.fail(here);
  assert.equal(t.blocked(here), true);
  assert.equal(t.blocked(there), false);
});

test('a success clears the count so one mistype is not held against you', () => {
  const t = createLoginThrottle();
  const k = t.key('tech1', '1.1.1.1');
  for (let i = 0; i < LOGIN_MAX_FAILS; i++) t.fail(k);
  assert.equal(t.blocked(k), true);
  t.clear(k);
  assert.equal(t.blocked(k), false);
});

test('the block releases once the window passes', () => {
  const t = createLoginThrottle();
  const t0 = 1_000_000;
  const k = t.key('tech1', '1.1.1.1');
  for (let i = 0; i < LOGIN_MAX_FAILS; i++) t.fail(k, t0);
  assert.equal(t.blocked(k, t0), true);
  assert.equal(t.blocked(k, t0 + LOGIN_WINDOW_MS + 1), false);
});

test('a lapsed window starts again at one, not at the cap', () => {
  // A counter that only ever increments turns a 15-minute lock into a permanent
  // one: after the lock expires the very next failure re-trips it immediately.
  const t = createLoginThrottle();
  const t0 = 1_000_000;
  const k = t.key('tech1', '1.1.1.1');
  for (let i = 0; i < LOGIN_MAX_FAILS; i++) t.fail(k, t0);
  const later = t0 + LOGIN_WINDOW_MS + 1;
  t.fail(k, later);
  assert.equal(t.blocked(k, later), false);
});

test('usernames are normalised so case and spacing cannot split the count', () => {
  const t = createLoginThrottle();
  assert.equal(t.key('  Tech1 ', '1.1.1.1'), t.key('tech1', '1.1.1.1'));
});

test('sweep drops expired entries so the map cannot grow without bound', () => {
  const t = createLoginThrottle();
  const t0 = 1_000_000;
  t.fail(t.key('tech1', '1.1.1.1'), t0);
  assert.equal(t.size, 1);
  t.sweep(t0 + LOGIN_WINDOW_MS + 1);
  assert.equal(t.size, 0);
});
