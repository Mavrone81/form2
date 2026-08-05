import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { createSubmission, signAndAdvance, queueFor, saveFields, assertCanEdit, completenessFor, rejectSubmission } from '../server/workflow.js';

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

// --- Fix round 1: completenessFor (moved out of routes.js so it is
// testable without booting HTTP) and error codes distinguishing permission
// failures from other errors ---

const TASKS = [
  { row: 2, freq: '1M' },
  { row: 3, freq: '3M' },
  { row: 4, freq: '6M' },
  { row: 5, freq: 'Y' }
];

test('completenessFor: every in-scope task filled reports zero missing', () => {
  const { db, users, sub } = setup();
  saveFields(db, sub.id, { task_2: 'a', task_3: 'b', task_4: 'c', task_5: 'd' }, users.tech);
  assert.deepEqual(completenessFor(db, sub.id, TASKS, 'Y'), { inScope: 4, filled: 4, missing: [] });
});

test('completenessFor: nothing filled reports every in-scope key as missing', () => {
  const { db, sub } = setup();
  assert.deepEqual(completenessFor(db, sub.id, TASKS, 'Y'), {
    inScope: 4, filled: 0, missing: ['task_2', 'task_3', 'task_4', 'task_5']
  });
});

test('completenessFor: some filled reports exactly the unfilled in-scope keys', () => {
  const { db, users, sub } = setup();
  saveFields(db, sub.id, { task_3: 'b', task_5: 'd' }, users.tech);
  assert.deepEqual(completenessFor(db, sub.id, TASKS, 'Y'), { inScope: 4, filled: 2, missing: ['task_2', 'task_4'] });
});

test('completenessFor: a whitespace-only value counts as NOT filled', () => {
  const { db, users, sub } = setup();
  saveFields(db, sub.id, { task_2: '   ', task_3: 'b', task_4: '\t\n', task_5: 'd' }, users.tech);
  assert.deepEqual(completenessFor(db, sub.id, TASKS, 'Y'), { inScope: 4, filled: 2, missing: ['task_2', 'task_4'] });
});

test('completenessFor: a frequency with zero in-scope tasks reports an empty, complete result', () => {
  const { db, sub } = setup();
  // 'NONE' is not one of the recognized frequencies, so tasksInScope's
  // covers() finds no index for it and brings nothing into scope.
  assert.deepEqual(completenessFor(db, sub.id, TASKS, 'NONE'), { inScope: 0, filled: 0, missing: [] });
});

test('assertCanEdit marks a wrong-stage/wrong-role failure as err.code === FORBIDDEN', () => {
  const { db, users, sub } = setup();
  try {
    assertCanEdit(db, sub.id, users.lead);
    assert.fail('expected assertCanEdit to throw');
  } catch (err) {
    assert.equal(err.code, 'FORBIDDEN');
  }
});

test('assertCanEdit marks a missing submission as err.code === NOT_FOUND', () => {
  const { db, users } = setup();
  try {
    assertCanEdit(db, 999999, users.tech);
    assert.fail('expected assertCanEdit to throw');
  } catch (err) {
    assert.equal(err.code, 'NOT_FOUND');
  }
});

test('signAndAdvance marks a wrong-role failure as err.code === FORBIDDEN', () => {
  const { db, users, sub } = setup();
  try {
    signAndAdvance(db, { submissionId: sub.id, user: users.eng, signaturePng: PNG });
    assert.fail('expected signAndAdvance to throw');
  } catch (err) {
    assert.equal(err.code, 'FORBIDDEN');
  }
});

test('signAndAdvance does NOT mark a missing-signature failure as FORBIDDEN', () => {
  const { db, users, sub } = setup();
  try {
    signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: '' });
    assert.fail('expected signAndAdvance to throw');
  } catch (err) {
    assert.notEqual(err.code, 'FORBIDDEN');
  }
});

// --- Reject / send-back ---------------------------------------------------
//
// A rejection always returns the record to the TECHNICIAN, never one stage
// back, and clears EVERY signature — because every stage must redo its work
// against whatever the technician changes next. A signature is the record's
// claim that a named person saw exactly this content; leaving one attached
// across an edit would make that claim false. The rejection itself is kept
// forever in its own table, so clearing the ink never erases the history.

const rejectionsOf = (db, id) =>
  db.prepare('select * from rejections where submission_id=? order by id').all(id);
const stateOf = (db, id) => db.prepare('select state from submissions where id=?').get(id).state;
const signatureStages = (db, id) =>
  db.prepare('select stage from signatures where submission_id=? order by stage').all(id).map((s) => s.stage);

test('a team leader rejects a pending_lead record: state, signatures and the recorded rejection', () => {
  const { db, users, sub } = setup();
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  assert.deepEqual(signatureStages(db, sub.id), ['technician']);

  const before = Date.now();
  const returned = rejectSubmission(db, {
    submissionId: sub.id, user: users.lead, reason: 'Torque values missing on task 4.'
  });

  assert.equal(returned.state, 'rejected', 'the returned row must already carry the new state');
  assert.equal(stateOf(db, sub.id), 'rejected');
  assert.deepEqual(signatureStages(db, sub.id), [], 'every signature must be cleared');

  const rows = rejectionsOf(db, sub.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'Torque values missing on task 4.');
  assert.equal(rows[0].rejected_by, users.lead.id);
  assert.equal(rows[0].full_name, 'Lead', 'the name is denormalised so a later rename cannot rewrite history');
  assert.equal(rows[0].stage, 'team_leader');
  const at = new Date(rows[0].rejected_at).getTime();
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'rejected_at must be a server clock timestamp');
});

test('an engineer rejecting clears the TEAM LEADER\'s signature too, not just the technician\'s', () => {
  const { db, users, sub } = setup();
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  signAndAdvance(db, { submissionId: sub.id, user: users.lead, signaturePng: PNG });
  assert.deepEqual(signatureStages(db, sub.id), ['team_leader', 'technician']);

  rejectSubmission(db, { submissionId: sub.id, user: users.eng, reason: 'Wrong interval worked.' });

  assert.equal(stateOf(db, sub.id), 'rejected');
  assert.deepEqual(signatureStages(db, sub.id), [],
    'the team leader signed content that is about to change, so their signature must go too');
  assert.equal(rejectionsOf(db, sub.id)[0].stage, 'engineer');
});

test('a rejection with an empty or whitespace-only reason fails, and changes nothing', () => {
  for (const reason of ['', '   ', '\t\n ', undefined, null]) {
    const { db, users, sub } = setup();
    signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });

    let thrown;
    try {
      rejectSubmission(db, { submissionId: sub.id, user: users.lead, reason });
      assert.fail(`expected a reason of ${JSON.stringify(reason)} to be refused`);
    } catch (err) { thrown = err; }

    // An input problem, not a permission problem — the route maps a
    // non-FORBIDDEN throw to 400, exactly as a missing signature already does.
    assert.notEqual(thrown.code, 'FORBIDDEN', 'a missing reason is a 400, not a 403');
    assert.match(thrown.message, /reason/i);

    assert.equal(stateOf(db, sub.id), 'pending_lead', 'state must be untouched');
    assert.deepEqual(signatureStages(db, sub.id), ['technician'], 'signatures must be untouched');
    assert.deepEqual(rejectionsOf(db, sub.id), [], 'no rejection may be recorded');
  }
});

test('only the reviewer whose stage it currently is may reject', () => {
  // A technician can never reject.
  {
    const { db, users, sub } = setup();
    signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
    try {
      rejectSubmission(db, { submissionId: sub.id, user: users.tech, reason: 'nope' });
      assert.fail('a technician must not be able to reject');
    } catch (err) { assert.equal(err.code, 'FORBIDDEN'); }
    assert.equal(stateOf(db, sub.id), 'pending_lead');
    assert.deepEqual(rejectionsOf(db, sub.id), []);
  }

  // A technician cannot reject their OWN draft either — reject is a
  // reviewer's action, and `draft`/`rejected` are the technician's own stages.
  {
    const { db, users, sub } = setup();
    try {
      rejectSubmission(db, { submissionId: sub.id, user: users.tech, reason: 'nope' });
      assert.fail('a technician must not be able to reject their own draft');
    } catch (err) { assert.equal(err.code, 'FORBIDDEN'); }
    assert.equal(stateOf(db, sub.id), 'draft');
  }

  // An engineer cannot reject a record still awaiting the team leader.
  {
    const { db, users, sub } = setup();
    signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
    try {
      rejectSubmission(db, { submissionId: sub.id, user: users.eng, reason: 'too early' });
      assert.fail('an engineer must not be able to reject a pending_lead record');
    } catch (err) { assert.equal(err.code, 'FORBIDDEN'); }
    assert.equal(stateOf(db, sub.id), 'pending_lead');
    assert.deepEqual(signatureStages(db, sub.id), ['technician']);
    assert.deepEqual(rejectionsOf(db, sub.id), []);
  }

  // `approved` is terminal: nobody can reject it, ever.
  {
    const { db, users, sub } = setup();
    for (const u of [users.tech, users.lead, users.eng])
      signAndAdvance(db, { submissionId: sub.id, user: u, signaturePng: PNG });
    for (const u of [users.tech, users.lead, users.eng]) {
      try {
        rejectSubmission(db, { submissionId: sub.id, user: u, reason: 'too late' });
        assert.fail('an approved record must never be rejectable');
      } catch (err) { assert.equal(err.code, 'FORBIDDEN'); }
    }
    assert.equal(stateOf(db, sub.id), 'approved');
    assert.deepEqual(signatureStages(db, sub.id), ['engineer', 'team_leader', 'technician']);
    assert.deepEqual(rejectionsOf(db, sub.id), []);
  }
});

test('after a rejection the technician can edit, re-sign and resubmit — back to pending_lead', () => {
  const { db, users, sub } = setup();
  saveFields(db, sub.id, { task_28: 'OK' }, users.tech);
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  rejectSubmission(db, { submissionId: sub.id, user: users.lead, reason: 'Task 28 needs the measured value.' });

  // Editable again by its creator, exactly as a draft is.
  assert.doesNotThrow(() => assertCanEdit(db, sub.id, users.tech));
  assert.throws(() => assertCanEdit(db, sub.id, users.lead), /cannot/i);
  saveFields(db, sub.id, { task_28: 'Measured 4.2 Nm' }, users.tech);
  assert.equal(
    db.prepare('select value from submission_fields where submission_id=? and field_key=?').get(sub.id, 'task_28').value,
    'Measured 4.2 Nm'
  );

  // And it travels the whole chain again from the bottom.
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG }).state, 'pending_lead');
  assert.deepEqual(signatureStages(db, sub.id), ['technician'], 'the fresh signature is the only one');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.lead, signaturePng: PNG }).state, 'pending_engineer');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.eng, signaturePng: PNG }).state, 'approved');

  // The rejection is still on the record afterwards — an approved record must
  // still be able to say it was sent back once, by whom, and why.
  assert.equal(rejectionsOf(db, sub.id).length, 1);
});

test('a rejected record sits in its technician\'s queue, not in any reviewer\'s', () => {
  const { db, users, sub } = setup();
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  assert.equal(queueFor(db, users.lead).length, 1);

  rejectSubmission(db, { submissionId: sub.id, user: users.lead, reason: 'Send it back.' });

  assert.equal(queueFor(db, users.lead).length, 0, 'a rejected record must leave the reviewer\'s queue');
  assert.equal(queueFor(db, users.eng).length, 0);
  const techQueue = queueFor(db, users.tech);
  assert.equal(techQueue.length, 1, 'the technician must be able to see it to act on it');
  assert.equal(techQueue[0].state, 'rejected');
});

test('concurrency: a second reviewer rejecting the same record fails cleanly, leaving one rejection', () => {
  const { db, users, sub } = setup();
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });

  const first = rejectSubmission(db, { submissionId: sub.id, user: users.lead, reason: 'First reason.' });
  assert.equal(first.state, 'rejected');

  // The state was re-read INSIDE the transaction, so a second actor working
  // from a stale view of the record cannot reject it a second time.
  try {
    rejectSubmission(db, { submissionId: sub.id, user: users.lead, reason: 'Second reason.' });
    assert.fail('the second rejection must fail');
  } catch (err) { assert.equal(err.code, 'FORBIDDEN'); }
  try {
    rejectSubmission(db, { submissionId: sub.id, user: users.eng, reason: 'Third reason.' });
    assert.fail('a different reviewer must not be able to reject an already-rejected record');
  } catch (err) { assert.equal(err.code, 'FORBIDDEN'); }

  const rows = rejectionsOf(db, sub.id);
  assert.equal(rows.length, 1, 'exactly one rejection row');
  assert.equal(rows[0].reason, 'First reason.');
  assert.equal(stateOf(db, sub.id), 'rejected');
});

test('rejecting a record that does not exist is a NOT_FOUND, not a crash', () => {
  const { db, users } = setup();
  try {
    rejectSubmission(db, { submissionId: 999999, user: users.lead, reason: 'x' });
    assert.fail('expected a throw');
  } catch (err) { assert.equal(err.code, 'NOT_FOUND'); }
});

// --- The Parts Required table: empty rows are the normal case ---------------
// Most maintenance visits replace no parts at all. A blank parts row is not an
// omission, so it must never be counted as unfilled work and must never stand
// between a technician and a signature.

test('blank parts rows do not count towards completeness', () => {
  const { db, users, sub } = setup();
  saveFields(db, sub.id, { task_2: 'a', task_3: 'b', task_4: 'c', task_5: 'd' }, users.tech);
  assert.deepEqual(completenessFor(db, sub.id, TASKS, 'Y'), { inScope: 4, filled: 4, missing: [] },
    'a record with every task done and no parts recorded is complete');
});

test('a parts row filled in does not change the completeness count either', () => {
  const { db, users, sub } = setup();
  saveFields(db, sub.id, { task_2: 'a', task_3: 'b', task_4: 'c', task_5: 'd' }, users.tech);
  const before = completenessFor(db, sub.id, TASKS, 'Y');
  saveFields(db, sub.id, { part_11_no: 'WX-1', part_11_qty: '2' }, users.tech);
  assert.deepEqual(completenessFor(db, sub.id, TASKS, 'Y'), before,
    'parts are recorded work, not outstanding work — the count is about tasks');
});

test('empty parts rows do not block signing, at any stage', () => {
  const { db, users, sub } = setup();
  // Nothing recorded in the parts table at all — the ordinary case.
  saveFields(db, sub.id, { task_5: 'OK' }, users.tech);
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG }).state, 'pending_lead');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.lead, signaturePng: PNG }).state, 'pending_engineer');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.eng, signaturePng: PNG }).state, 'approved');
});
