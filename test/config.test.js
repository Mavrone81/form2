import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../server/config.js';

test('defaults suit local development', () => {
  const c = resolveConfig({});
  assert.equal(c.port, 30000);
  assert.equal(c.dbPath, 'data/pm.sqlite');
  assert.equal(c.formsDir, '');
  assert.ok(c.sessionSecret.length >= 32, 'a secret is generated when unset');
});

test('environment overrides every default', () => {
  const c = resolveConfig({ PORT: '8080', DB_PATH: '/data/pm.sqlite', FORMS_DIR: '/forms', SESSION_SECRET: 'x'.repeat(40) });
  assert.equal(c.port, 8080);
  assert.equal(c.dbPath, '/data/pm.sqlite');
  assert.equal(c.formsDir, '/forms');
  assert.equal(c.sessionSecret, 'x'.repeat(40));
});

test('a short SESSION_SECRET is rejected rather than silently accepted', () => {
  // A weak secret lets an attacker forge a session cookie and sign a QA
  // record as someone else. Fail loudly at boot instead.
  assert.throws(() => resolveConfig({ SESSION_SECRET: 'short' }), /SESSION_SECRET/);
});

test('generated secrets differ between boots', () => {
  assert.notEqual(resolveConfig({}).sessionSecret, resolveConfig({}).sessionSecret);
});
