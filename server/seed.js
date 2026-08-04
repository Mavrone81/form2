import { createUser } from './auth.js';

const DEMO = [
  { username: 'tech',  password: 'tech',  fullName: 'Demo Technician',  role: 'technician' },
  { username: 'lead',  password: 'lead',  fullName: 'Demo Team Leader', role: 'team_leader' },
  { username: 'eng',   password: 'eng',   fullName: 'Demo Engineer',    role: 'engineer' },
  { username: 'admin', password: 'admin', fullName: 'Demo Admin',       role: 'admin' }
];

export function seedDemoUsers(db, { silent = false } = {}) {
  const count = db.prepare('select count(*) n from users').get().n;
  if (count > 0) return [];
  for (const u of DEMO) createUser(db, u);
  if (!silent) {
    console.log('\nDemo accounts created — change these before real use:');
    for (const u of DEMO) console.log(`  ${u.role.padEnd(12)} ${u.username} / ${u.password}`);
    console.log('');
  }
  return DEMO;
}
