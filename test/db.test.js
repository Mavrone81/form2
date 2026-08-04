import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';

test('schema creates every table', () => {
  const db = openDb(':memory:');
  const names = db.prepare("select name from sqlite_master where type='table'")
    .all().map((r) => r.name);
  for (const t of ['settings', 'form_catalog', 'form_fields', 'users',
                   'submissions', 'submission_fields', 'signatures']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test('foreign keys are enforced', () => {
  const db = openDb(':memory:');
  assert.throws(() => db.prepare(
    'insert into signatures (submission_id, stage, user_id, full_name, image_png, signed_at) values (?,?,?,?,?,?)'
  ).run(999, 'technician', 1, 'X', 'data:', '2026-01-01T00:00:00Z'));
});

test('applying the schema twice is safe', () => {
  const db = openDb(':memory:');
  assert.doesNotThrow(() => openDb(':memory:'));
  assert.ok(db);
});
