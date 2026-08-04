import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const ROLES = ['technician', 'team_leader', 'engineer', 'admin'];
const KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function createUser(db, { username, password, fullName, role }) {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  const info = db.prepare(
    'insert into users (username, password_hash, full_name, role, active, created_at) values (?,?,?,?,1,?)'
  ).run(username, hashPassword(password), fullName, role, new Date().toISOString());
  return db.prepare(
    'select id, username, full_name, role, active, created_at from users where id = ?'
  ).get(info.lastInsertRowid);
}

export function authenticate(db, username, password) {
  const user = db.prepare('select * from users where username = ? and active = 1').get(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

export function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (!roles.includes(user.role))
      return res.status(403).json({ error: 'Your role cannot perform this action.' });
    next();
  };
}
