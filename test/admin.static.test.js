// STATIC GUARD ONLY — not a behavioural test.
//
// There is no DOM simulation harness in this project (no build step, no
// framework, no bundler — plain ES modules loaded directly by the browser),
// so these tests read web/js/admin.js (and, for the cross-cutting DOM-safety
// guard, every file under web/js/) as plain text and assert the required
// code shapes are present. Passing these tests proves the right code shapes
// exist; it does NOT prove the folder panel, user table or PDF mapper
// actually render or behave correctly in a real browser. That was verified
// by hand against a running server — see task-15-report.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const jsDir = fileURLToPath(new URL('../web/js/', import.meta.url));
const jsFiles = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const sources = new Map(jsFiles.map((f) => [f, readFileSync(jsDir + f, 'utf8')]));

const adminSrc = sources.get('admin.js');
assert.ok(adminSrc, 'expected web/js/admin.js to exist');

test('static: no file under web/js/ ever uses innerHTML, insertAdjacentHTML, outerHTML or document.write', () => {
  // Form titles and field labels originate in spreadsheet/PDF files supplied
  // by whoever set up the forms folder and must never be interpreted as
  // markup — admin.js renders exactly that kind of data (form titles, file
  // names, user-authored field labels/sections). Checked across every file
  // under web/js/, not just admin.js, so this stays true as new files land.
  for (const [name, src] of sources) {
    assert.doesNotMatch(src, /\.innerHTML\b/, `${name} must never use innerHTML`);
    assert.doesNotMatch(src, /insertAdjacentHTML/, `${name} must never use insertAdjacentHTML`);
    assert.doesNotMatch(src, /\.outerHTML\b/, `${name} must never use outerHTML`);
    assert.doesNotMatch(src, /document\.write\(/, `${name} must never use document.write`);
  }
});

test('static: admin.js actually renders text via textContent (the innerHTML ban is not vacuous)', () => {
  assert.match(adminSrc, /\.textContent\s*=/, 'expected at least one textContent assignment in admin.js');
});

test('static: the user-role select offers exactly the four roles, in the shape the server accepts', () => {
  // server/auth.js: export const ROLES = ['technician', 'team_leader', 'engineer', 'admin'].
  // admin.js keeps its own copy for the <select> options (it cannot import a
  // server file into a browser module) — this guards that copy stays exactly
  // in sync, no more and no fewer roles, in the same order.
  const rolesMatch = /const ROLES\s*=\s*\[([^\]]+)\]/.exec(adminSrc);
  assert.ok(rolesMatch, 'expected a `const ROLES = [...]` array in admin.js');
  const roles = rolesMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepEqual(roles, ['technician', 'team_leader', 'engineer', 'admin']);
});

test('static: the field mapper seeds the three sign-off signature blocks plus the two general record fields', () => {
  assert.match(adminSrc, /DEFAULT_FIELDS/, 'expected a DEFAULT_FIELDS seed constant in admin.js');
  const defaultsBlock = /const DEFAULT_FIELDS\s*=\s*\[[\s\S]*?\n\];/.exec(adminSrc);
  assert.ok(defaultsBlock, 'expected a DEFAULT_FIELDS = [...] array literal');
  const body = defaultsBlock[0];
  for (const key of ['machine_id', 'remarks', 'sig_technician', 'sig_team_leader', 'sig_engineer']) {
    assert.match(body, new RegExp(`field_key:\\s*'${key}'`), `expected DEFAULT_FIELDS to include field_key '${key}'`);
  }
  // The three sign-off rows must actually be kind: 'signature', not text.
  const sigKeys = ['sig_technician', 'sig_team_leader', 'sig_engineer'];
  for (const key of sigKeys) {
    const rowMatch = new RegExp(`field_key:\\s*'${key}'[^}]*kind:\\s*'signature'`).exec(body);
    assert.ok(rowMatch, `expected ${key} to be seeded with kind: 'signature'`);
  }
});

test('static: no response shape anywhere renders a password hash', () => {
  // GET /api/admin/users only ever selects id/username/full_name/role/active
  // (server/routes.js), and POST /api/admin/users strips password_hash
  // before responding — there is no password_hash in any admin.js response
  // shape to accidentally render. This guards that admin.js never even
  // references the literal field name, which would be a sign it expects
  // (and might display) that column.
  for (const [name, src] of sources) {
    assert.doesNotMatch(src, /password_hash/, `${name} must never reference password_hash`);
  }
  // And no admin.js control ever binds a user's password value back into a
  // displayed field (e.g. reusing the create-user password input's value
  // when rendering the users table) — the only `type="password"` fields are
  // in the new-user form, both write-only.
  const passwordInputs = [...adminSrc.matchAll(/type\s*=\s*'password'/g)];
  assert.ok(passwordInputs.length >= 1, 'expected at least the new-user password input');
});

test('static: admin.js extends the shared api.js client rather than calling fetch() directly', () => {
  // Task requirement: "web/js/api.js already wraps fetch ... Extend it with
  // the admin calls rather than writing new fetch code."
  assert.doesNotMatch(adminSrc, /\bfetch\(/, 'admin.js must not call fetch() directly — use api.js');
  assert.match(adminSrc, /from '\.\/api\.js'/, 'expected admin.js to import the shared api client');
});
