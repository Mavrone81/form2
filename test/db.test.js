import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Helper: create parent rows for constraint tests
function setupTestData(db) {
  db.prepare(`
    insert into form_catalog (file_path, file_name, file_type, state)
    values (?, ?, ?, ?)
  `).run('/test/form.xlsx', 'form.xlsx', 'xlsx', 'ready');

  const formId = db.prepare('select id from form_catalog limit 1').get().id;

  db.prepare(`
    insert into users (username, password_hash, full_name, role, created_at)
    values (?, ?, ?, ?, ?)
  `).run('tech1', 'hash', 'Tech One', 'technician', '2026-01-01T00:00:00Z');

  const userId = db.prepare('select id from users limit 1').get().id;

  db.prepare(`
    insert into submissions (form_id, form_snapshot, state, created_by, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?)
  `).run(formId, '{}', 'draft', userId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

  const submissionId = db.prepare('select id from submissions limit 1').get().id;

  return { formId, userId, submissionId };
}

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

test('applying the schema twice is safe (idempotency)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'db-test-'));
  const dbPath = join(tmpDir, 'test.sqlite');

  try {
    // First open: create schema
    const db1 = openDb(dbPath);
    db1.prepare('insert into settings (key, value) values (?, ?)')
      .run('test_key', 'test_value');
    db1.close();

    // Second open: schema already exists, should not throw
    const db2 = openDb(dbPath);
    assert.doesNotThrow(() => openDb(dbPath), 'opening existing database should not throw');

    // Verify data survives reopen
    const setting = db2.prepare('select value from settings where key = ?')
      .get('test_key');
    assert.equal(setting.value, 'test_value', 'data should survive database reopen');

    // Verify tables still exist
    const names = db2.prepare("select name from sqlite_master where type='table'")
      .all().map((r) => r.name);
    assert.ok(names.includes('settings'), 'tables should exist after reopen');

    db2.close();
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('signatures UNIQUE(submission_id, stage) prevents double-signing', () => {
  const db = openDb(':memory:');
  const { submissionId, userId } = setupTestData(db);

  // Insert first signature
  db.prepare(`
    insert into signatures (submission_id, stage, user_id, full_name, image_png, signed_at)
    values (?, ?, ?, ?, ?, ?)
  `).run(submissionId, 'technician', userId, 'Tech One', 'data:image', '2026-01-01T00:00:00Z');

  // Try to insert same stage again for same submission
  assert.throws(
    () => db.prepare(`
      insert into signatures (submission_id, stage, user_id, full_name, image_png, signed_at)
      values (?, ?, ?, ?, ?, ?)
    `).run(submissionId, 'technician', userId, 'Tech One', 'data:image2', '2026-01-02T00:00:00Z'),
    'cannot sign the same stage twice'
  );
});

test('submissions.form_snapshot NOT NULL enforces audit trail', () => {
  const db = openDb(':memory:');
  const { formId, userId } = setupTestData(db);

  assert.throws(
    () => db.prepare(`
      insert into submissions (form_id, form_snapshot, state, created_by, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
    `).run(formId, null, 'draft', userId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    'form_snapshot must not be null'
  );
});

test('CHECK constraints reject invalid enum values', () => {
  const db = openDb(':memory:');
  const { formId, userId, submissionId } = setupTestData(db);

  // form_catalog.state
  assert.throws(
    () => db.prepare('insert into form_catalog (file_path, file_name, file_type, state) values (?, ?, ?, ?)')
      .run('/bad/state.xlsx', 'bad.xlsx', 'xlsx', 'bogus'),
    'form_catalog.state rejects bogus value'
  );

  // users.role
  assert.throws(
    () => db.prepare('insert into users (username, password_hash, full_name, role, created_at) values (?, ?, ?, ?, ?)')
      .run('baduser', 'hash', 'Bad User', 'bogus', '2026-01-01T00:00:00Z'),
    'users.role rejects bogus value'
  );

  // signatures.stage
  assert.throws(
    () => db.prepare(`
      insert into signatures (submission_id, stage, user_id, full_name, image_png, signed_at)
      values (?, ?, ?, ?, ?, ?)
    `).run(submissionId, 'bogus', userId, 'User', 'data:', '2026-01-01T00:00:00Z'),
    'signatures.stage rejects bogus value'
  );

  // form_fields.kind
  assert.throws(
    () => db.prepare(`
      insert into form_fields (form_id, field_key, label, kind, source)
      values (?, ?, ?, ?, ?)
    `).run(formId, 'field1', 'Field 1', 'bogus', 'parsed'),
    'form_fields.kind rejects bogus value'
  );

  // form_fields.source
  assert.throws(
    () => db.prepare(`
      insert into form_fields (form_id, field_key, label, kind, source)
      values (?, ?, ?, ?, ?)
    `).run(formId, 'field2', 'Field 2', 'text', 'bogus'),
    'form_fields.source rejects bogus value'
  );
});

test('cascade deletes submission removes submission_fields and signatures', () => {
  const db = openDb(':memory:');
  const { submissionId, userId } = setupTestData(db);

  // Add submission field and signature
  db.prepare(`
    insert into submission_fields (submission_id, field_key, label, value)
    values (?, ?, ?, ?)
  `).run(submissionId, 'field1', 'Field 1', 'value1');

  db.prepare(`
    insert into signatures (submission_id, stage, user_id, full_name, image_png, signed_at)
    values (?, ?, ?, ?, ?, ?)
  `).run(submissionId, 'technician', userId, 'Tech One', 'data:', '2026-01-01T00:00:00Z');

  // Verify they exist
  assert.equal(
    db.prepare('select count(*) as count from submission_fields where submission_id = ?')
      .get(submissionId).count, 1
  );
  assert.equal(
    db.prepare('select count(*) as count from signatures where submission_id = ?')
      .get(submissionId).count, 1
  );

  // Delete submission
  db.prepare('delete from submissions where id = ?').run(submissionId);

  // Verify cascade deleted dependent rows
  assert.equal(
    db.prepare('select count(*) as count from submission_fields where submission_id = ?')
      .get(submissionId).count, 0,
    'submission_fields should cascade delete'
  );
  assert.equal(
    db.prepare('select count(*) as count from signatures where submission_id = ?')
      .get(submissionId).count, 0,
    'signatures should cascade delete'
  );
});

test('deleting a user referenced by signature throws (no cascade)', () => {
  const db = openDb(':memory:');
  const { submissionId, userId } = setupTestData(db);

  // Add signature
  db.prepare(`
    insert into signatures (submission_id, stage, user_id, full_name, image_png, signed_at)
    values (?, ?, ?, ?, ?, ?)
  `).run(submissionId, 'technician', userId, 'Tech One', 'data:', '2026-01-01T00:00:00Z');

  // Verify signature exists
  assert.equal(
    db.prepare('select count(*) as count from signatures where user_id = ?')
      .get(userId).count, 1
  );

  // Try to delete user - should throw because signature references it
  assert.throws(
    () => db.prepare('delete from users where id = ?').run(userId),
    'cannot delete user with referencing signature (audit trail protection)'
  );

  // Verify user still exists
  assert.equal(
    db.prepare('select count(*) as count from users where id = ?')
      .get(userId).count, 1,
    'user should still exist after failed delete'
  );
});

test('submissions.state accepts arbitrary values (no check constraint)', () => {
  const db = openDb(':memory:');
  const { formId, userId } = setupTestData(db);

  // Should accept any arbitrary state string
  assert.doesNotThrow(
    () => db.prepare(`
      insert into submissions (form_id, form_snapshot, state, created_by, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
    `).run(formId, '{}', 'rejected', userId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    'submissions.state should accept any string'
  );

  // Verify it was inserted
  const submission = db.prepare('select state from submissions where state = ?')
    .get('rejected');
  assert.equal(submission.state, 'rejected', 'arbitrary state should be stored');
});
