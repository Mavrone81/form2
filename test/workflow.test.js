import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { createSubmission, signAndAdvance, queueFor, saveFields, assertCanEdit } from '../server/workflow.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function setup() {
  const db = openDb(':memory:');
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();
  const users = {
    tech: createUser(db, { username: 't', password: 'p', fullName: 'Tech', role: 'technician' }),
    lead: createUser(db, { username: 'l', password: 'p', fullName: 'Lead', role: 'team_leader' }),
    eng: createUser(db, { username: 'e', password: 'p', fullName: 'Eng', role: 'engineer' })
  };
  const sub = createSubmission(db, { formId: 1, userId: users.tech.id, machineId: 'ED04', frequency: 'Y' });
  return { db, users, sub };
}

test('a submission walks technician to team leader to engineer', () => {
  const { db, users, sub } = setup();
  assert.equal(sub.state, 'draft');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG }).state, 'pending_lead');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.lead, signaturePng: PNG }).state, 'pending_engineer');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.eng, signaturePng: PNG }).state, 'approved');
});

test('signing is required before advancing', () => {
  const { db, users, sub } = setup();
  assert.throws(
    () => signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: '' }),
    /signature/i
  );
  assert.equal(db.prepare('select state from submissions where id=?').get(sub.id).state, 'draft');
});

test('the wrong role cannot advance, and state is untouched', () => {
  const { db, users, sub } = setup();
  assert.throws(() => signAndAdvance(db, { submissionId: sub.id, user: users.eng, signaturePng: PNG }), /cannot/i);
  assert.equal(db.prepare('select state from submissions where id=?').get(sub.id).state, 'draft');
});

test('an approved record is terminal', () => {
  const { db, users, sub } = setup();
  for (const u of [users.tech, users.lead, users.eng])
    signAndAdvance(db, { submissionId: sub.id, user: u, signaturePng: PNG });
  assert.throws(() => signAndAdvance(db, { submissionId: sub.id, user: users.eng, signaturePng: PNG }), /approved/i);
});

test('signature timestamp comes from the server, not the caller', () => {
  const { db, users, sub } = setup();
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG, signedAt: '1999-01-01T00:00:00Z' });
  const sig = db.prepare('select * from signatures where submission_id=?').get(sub.id);
  assert.ok(new Date(sig.signed_at).getFullYear() >= 2026);
});

test('queues show only what the role may act on', () => {
  const { db, users, sub } = setup();
  assert.equal(queueFor(db, users.lead).length, 0);
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  assert.equal(queueFor(db, users.lead).length, 1);
  assert.equal(queueFor(db, users.eng).length, 0);
  assert.equal(queueFor(db, users.tech).length, 1, 'technician still sees their own');
});

test('only the current stage owner may edit fields', () => {
  const { db, users, sub } = setup();
  // Draft belongs to the technician who created it.
  assert.doesNotThrow(() => assertCanEdit(db, sub.id, users.tech));
  assert.throws(() => assertCanEdit(db, sub.id, users.lead), /cannot/i);

  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  // Now with the lead: the technician must no longer be able to alter it.
  assert.throws(() => assertCanEdit(db, sub.id, users.tech), /cannot/i);
  assert.doesNotThrow(() => assertCanEdit(db, sub.id, users.lead));
});

test('an approved record cannot be edited by anyone', () => {
  const { db, users, sub } = setup();
  for (const u of [users.tech, users.lead, users.eng])
    signAndAdvance(db, { submissionId: sub.id, user: u, signaturePng: PNG });
  for (const u of Object.values(users))
    assert.throws(() => assertCanEdit(db, sub.id, u), /approved/i);
});

test('fields save and overwrite by key', () => {
  const { db, users, sub } = setup();
  saveFields(db, sub.id, { task_28: 'OK', remarks: 'none' }, users.tech);
  saveFields(db, sub.id, { task_28: 'Replaced belt' }, users.tech);
  const rows = db.prepare('select field_key, value from submission_fields where submission_id=? order by field_key').all(sub.id);
  assert.deepEqual(rows, [
    { field_key: 'remarks', value: 'none' },
    { field_key: 'task_28', value: 'Replaced belt' }
  ]);
});

// --- Additional tests beyond the brief ---

test('concurrency: two actors advancing the same submission — the second throws and the state advances only once', () => {
  const { db, users, sub } = setup();
  // First actor signs the technician stage successfully.
  const first = signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  assert.equal(first.state, 'pending_lead');

  // A second attempt to sign the SAME (already-passed) stage must fail. If the
  // implementation read `state` before opening its transaction instead of
  // inside it, this second call could wrongly re-derive the old state and
  // attempt to advance a second time.
  assert.throws(
    () => signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG }),
    /cannot/i
  );

  const row = db.prepare('select state from submissions where id=?').get(sub.id);
  assert.equal(row.state, 'pending_lead', 'state must have advanced exactly once');

  const sigCount = db.prepare(
    'select count(*) as c from signatures where submission_id=? and stage=?'
  ).get(sub.id, 'technician').c;
  assert.equal(sigCount, 1, 'only one signature must exist for the stage');
});

test('assertCanEdit refuses a user with the admin role', () => {
  const { db, users, sub } = setup();
  const admin = createUser(db, { username: 'a', password: 'p', fullName: 'Admin', role: 'admin' });
  assert.throws(() => assertCanEdit(db, sub.id, admin), /cannot/i);
});

test('a technician cannot sign a draft created by a different technician', () => {
  const { db, users, sub } = setup();
  const otherTech = createUser(db, { username: 't2', password: 'p', fullName: 'Other Tech', role: 'technician' });
  assert.throws(
    () => signAndAdvance(db, { submissionId: sub.id, user: otherTech, signaturePng: PNG }),
    /cannot|only/i
  );
  assert.equal(db.prepare('select state from submissions where id=?').get(sub.id).state, 'draft');
});

// --- Fix round 1: saveFields must enforce assertCanEdit itself ---

test('saveFields on an approved submission throws, and stored values are unchanged', () => {
  const { db, users, sub } = setup();
  saveFields(db, sub.id, { task_28: 'OK' }, users.tech);
  for (const u of [users.tech, users.lead, users.eng])
    signAndAdvance(db, { submissionId: sub.id, user: u, signaturePng: PNG });

  assert.throws(
    () => saveFields(db, sub.id, { task_28: 'Tampered' }, users.eng),
    /approved/i
  );

  const row = db.prepare('select value from submission_fields where submission_id=? and field_key=?')
    .get(sub.id, 'task_28');
  assert.equal(row.value, 'OK', 'the approved record must not have been mutated');
});

test('saveFields called by a user who is not the current stage owner throws', () => {
  const { db, users, sub } = setup();
  // Advance to pending_lead: the technician who created it no longer owns the stage.
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });

  assert.throws(
    () => saveFields(db, sub.id, { task_28: 'Sneaky edit' }, users.tech),
    /cannot/i
  );

  const row = db.prepare('select field_key from submission_fields where submission_id=? and field_key=?')
    .get(sub.id, 'task_28');
  assert.equal(row, undefined, 'no field row must have been written');
});

test('saveFields called with no user argument throws, rather than writing', () => {
  const { db, sub } = setup();
  assert.throws(() => saveFields(db, sub.id, { task_28: 'OK' }), /user/i);

  const row = db.prepare('select field_key from submission_fields where submission_id=? and field_key=?')
    .get(sub.id, 'task_28');
  assert.equal(row, undefined, 'no field row must have been written without a user');
});

test('saveFields happy path: the current stage owner still saves values successfully', () => {
  const { db, users, sub } = setup();
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  // Record is now pending_lead: the team leader is the current stage owner.
  saveFields(db, sub.id, { remarks: 'Reviewed by lead' }, users.lead);

  const row = db.prepare('select value from submission_fields where submission_id=? and field_key=?')
    .get(sub.id, 'remarks');
  assert.equal(row.value, 'Reviewed by lead');
});
