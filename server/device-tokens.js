import { randomBytes, createHash } from 'node:crypto';

// 30 days: long enough that a technician on the shop floor is not asked to
// sign back in every shift, short enough that a lost or stolen device is not
// a permanent hole.
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Unlike auth.js's password hash, a device token has no low-entropy secret
// behind it to defend with a slow, salted KDF -- the "password" IS 256 bits
// of randomBytes. A fast, unsalted digest is enough to keep the raw token out
// of the database, and it keeps validation cheap on every request.
const hashToken = (token) => createHash('sha256').update(String(token ?? '')).digest('hex');

export function issueDeviceToken(db, userId) {
  const token = randomBytes(32).toString('hex');
  const issuedAt = new Date();
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
  const user = db.prepare(`
    select users.id, users.username, users.full_name, users.role, users.active, users.created_at
    from device_tokens
    join users on users.id = device_tokens.user_id
    where device_tokens.token_hash = ?
      and device_tokens.expires_at > ?
      and users.active = 1
  `).get(hash, new Date().toISOString());
  if (!user) return null;
  db.prepare('update device_tokens set last_used_at = ? where token_hash = ?')
    .run(new Date().toISOString(), hash);
  return user;
}

// Called on deactivation (and available for a "log out this device"
// feature later): every token this user holds stops working immediately,
// rather than lingering until its own 30-day expiry.
export function revokeUserTokens(db, userId) {
  db.prepare('delete from device_tokens where user_id = ?').run(userId);
}
