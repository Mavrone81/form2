// Login throttle: 5 FAILED attempts per (username, IP) per 15 minutes.
//
// Keyed on the pair, deliberately. Per-IP alone misses credential stuffing that
// rotates addresses while walking a list of accounts, and it locks out everyone
// else behind the same office connection. Per-username alone hands anyone a
// denial-of-service against a known account -- fail five times and the real
// technician is locked out, no password required. The pair confines a lockout to
// the attacker's own address and their chosen username.
//
// Counts failures only and clears on success, so someone who mistypes once and
// then gets it right is never penalised. The window expires as a unit, so a
// lapsed entry starts again at one rather than resuming at the cap -- a counter
// that never resets turns a 15-minute lock into a permanent one.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

export function createLoginThrottle({ windowMs = WINDOW_MS, max = MAX_FAILS } = {}) {
  const fails = new Map();

  const key = (username, ip) =>
    `${String(username ?? '').trim().toLowerCase().slice(0, 128)}|${ip || 'unknown'}`;

  return {
    key,
    blocked(k, now = Date.now()) {
      const e = fails.get(k);
      return !!e && now <= e.resetAt && e.n >= max;
    },
    fail(k, now = Date.now()) {
      const e = fails.get(k);
      if (!e || now > e.resetAt) fails.set(k, { n: 1, resetAt: now + windowMs });
      else e.n += 1;
    },
    clear(k) {
      fails.delete(k);
    },
    // Drop expired entries so the map cannot grow without bound.
    sweep(now = Date.now()) {
      for (const [k, e] of fails) if (now > e.resetAt) fails.delete(k);
    },
    get size() {
      return fails.size;
    },
  };
}

export const LOGIN_WINDOW_MS = WINDOW_MS;
export const LOGIN_MAX_FAILS = MAX_FAILS;
