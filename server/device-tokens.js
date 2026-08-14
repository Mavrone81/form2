import { randomBytes, createHash } from 'node:crypto';

// 30 days: long enough that a technician on the shop floor is not asked to
// sign back in every shift, short enough that a lost or stolen device is not
// a permanent hole.
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// How close to its own expiry a token has to be before a successful
// validation slides it forward another full TOKEN_TTL_MS. This is what makes
// the spec's rule ("a device is signed out after 30 days without an online
// sign-in") actually mean what it says: the 30 days run from the device's
// LAST contact with the server, not from the day it was paired. A phone in
// active use therefore never hard-expires mid-shift — every online request
// it makes inside the last 15 days of its life renews it — while a device
// that stops talking to the server (lost, left in a drawer, handed back)
// still dies exactly 30 days after its final request, because nothing is
// there to renew it.
//
// Half the TTL rather than "every request": renewing on every single
// validation would rewrite expires_at on every bundle/sync call for no
// benefit. At 15 days the renewal is rare, and the worst case for a device
// used daily is that its expiry sits between 15 and 30 days out at all
// times — never close enough to strand a technician on the shop floor.
const TOKEN_SLIDE_WITHIN_MS = 15 * 24 * 60 * 60 * 1000;

// Unlike auth.js's password hash, a device token has no low-entropy secret
// behind it to defend with a slow, salted KDF -- the "password" IS 256 bits
// of randomBytes. A fast, unsalted digest is enough to keep the raw token out
// of the database, and it keeps validation cheap on every request.
const hashToken = (token) => createHash('sha256').update(String(token ?? '')).digest('hex');

export function issueDeviceToken(db, userId) {
  const token = randomBytes(32).toString('hex');
  const issuedAt = new Date();
  // Opportunistic cleanup, scoped to THIS user only: a dead row is useless
  // to everyone (validateDeviceToken's own `expires_at > ?` already refuses
  // it), and pairing a device is exactly the moment where clearing out the
  // previous pairings of the same account costs nothing. Deliberately not a
  // sweep of every user's dead rows -- that would make one person's login
  // pay for the whole table, and there is no correctness benefit to it.
  db.prepare('delete from device_tokens where user_id = ? and expires_at <= ?')
    .run(userId, issuedAt.toISOString());
  const expiresAt = new Date(issuedAt.getTime() + TOKEN_TTL_MS).toISOString();
  db.prepare(
    'insert into device_tokens (token_hash, user_id, issued_at, expires_at) values (?,?,?,?)'
  ).run(hashToken(token), userId, issuedAt.toISOString(), expiresAt);
  return { token, expires_at: expiresAt };
}

// Returns the user a live token belongs to, or null for anything that isn't
// one -- an unknown token, an expired one, or a token whose owner has since
// been deactivated. password_hash is left out of the select, matching
// authenticate()'s own safe shape in auth.js.
export function validateDeviceToken(db, token) {
  const hash = hashToken(token);
  const now = new Date();
  const nowIso = now.toISOString();
  // expires_at travels back with the user row purely so the sliding-renewal
  // decision below can be made without a second SELECT; it is stripped off
  // before the caller ever sees it, so the returned shape is unchanged (and
  // still carries no password_hash).
  const row = db.prepare(`
    select users.id, users.username, users.full_name, users.role, users.active, users.created_at,
           device_tokens.expires_at as token_expires_at
    from device_tokens
    join users on users.id = device_tokens.user_id
    where device_tokens.token_hash = ?
      and device_tokens.expires_at > ?
      and users.active = 1
  `).get(hash, nowIso);
  if (!row) return null;
  const { token_expires_at: expiresAt, ...user } = row;

  // Sliding expiry -- see TOKEN_SLIDE_WITHIN_MS. Written in the SAME update
  // that stamps last_used_at (one write per validated request, exactly as
  // before) rather than as a second statement: this runs on every
  // token-authed request the app makes, and "renew" is the same fact as
  // "used", recorded once.
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  const nextExpiry = remaining < TOKEN_SLIDE_WITHIN_MS
    ? new Date(now.getTime() + TOKEN_TTL_MS).toISOString()
    : expiresAt;
  db.prepare('update device_tokens set last_used_at = ?, expires_at = ? where token_hash = ?')
    .run(nowIso, nextExpiry, hash);
  return user;
}

// Called on deactivation (and available for a "log out this device"
// feature later): every token this user holds stops working immediately,
// rather than lingering until its own 30-day expiry.
export function revokeUserTokens(db, userId) {
  db.prepare('delete from device_tokens where user_id = ?').run(userId);
}

// "Log out THIS device": deletes the single row the presented raw token
// hashes to, leaving every other device this user has paired alone (a
// technician signing out of a borrowed handset must not strand their own
// phone). Keyed on the hash, so possession of the raw token is itself the
// authority to revoke it -- there is nothing to check first, and an unknown,
// already-revoked or already-expired token simply deletes nothing.
export function revokeDeviceToken(db, token) {
  db.prepare('delete from device_tokens where token_hash = ?').run(hashToken(token));
}
