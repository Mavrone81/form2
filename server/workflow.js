import { tasksInScope } from './intervals.js';

export const STAGES = [
  { state: 'draft', actor: 'technician', next: 'pending_lead' },
  { state: 'pending_lead', actor: 'team_leader', next: 'pending_engineer' },
  { state: 'pending_engineer', actor: 'engineer', next: 'approved' }
];

const stageFor = (state) => STAGES.find((s) => s.state === state);

// Route handlers must be able to tell "you may not do this" apart from
// "your input was bad" without string-matching messages. FORBIDDEN marks the
// former so every caller (PATCH, sign, anything future) maps it to the same
// status code; NOT_FOUND marks a missing row.
function forbidden(message) {
  const err = new Error(message);
  err.code = 'FORBIDDEN';
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.code = 'NOT_FOUND';
  return err;
}

// Shared by assertCanEdit and signAndAdvance so the two can never silently
// diverge on who owns a record right now. Each caller supplies its own
// wording (edit vs. sign read differently) but the underlying rule — approved
// is terminal, only the current stage's actor role may act, and the
// technician stage additionally requires being the record's creator — lives
// in exactly one place.
function assertStageOwnership(sub, user, messages) {
  if (sub.state === 'approved') throw forbidden(messages.terminal);
  const stage = stageFor(sub.state);
  if (!stage) {
    if (messages.unknownState) throw new Error(messages.unknownState(sub.state));
    throw forbidden(messages.role);
  }
  if (stage.actor !== user.role) throw forbidden(messages.role);
  if (stage.actor === 'technician' && sub.created_by !== user.id) throw forbidden(messages.owner);
  return stage;
}

export function createSubmission(db, { formId, userId, machineId = '', frequency = '', snapshot = null }) {
  const now = new Date().toISOString();
  const fields = snapshot ??
    db.prepare('select field_key, label, section, kind, sort_order from form_fields where form_id=? order by sort_order').all(formId);
  const info = db.prepare(`insert into submissions
    (form_id, form_snapshot, machine_id, frequency, state, created_by, created_at, updated_at)
    values (?,?,?,?, 'draft', ?,?,?)`)
    .run(formId, JSON.stringify(fields), machineId, frequency, userId, now, now);
  return db.prepare('select * from submissions where id=?').get(info.lastInsertRowid);
}

// The whole point of this module is that no future HTTP route can bypass the
// sign-off rules, so saveFields enforces assertCanEdit itself rather than
// trusting every caller to remember to check first. A caller that already
// called assertCanEdit is unaffected — the check simply passes again.
export function saveFields(db, submissionId, values, user) {
  if (!user) throw new Error('A user is required to save fields.');
  assertCanEdit(db, submissionId, user);
  const snapshot = JSON.parse(db.prepare('select form_snapshot from submissions where id=?').get(submissionId).form_snapshot);
  const labels = new Map(snapshot.map((f) => [f.field_key, f.label]));
  const stmt = db.prepare(`insert into submission_fields (submission_id, field_key, label, value)
    values (?,?,?,?)
    on conflict(submission_id, field_key) do update set value=excluded.value`);
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) stmt.run(submissionId, key, labels.get(key) ?? key, String(value ?? ''));
  });
  tx(Object.entries(values));
}

// A record may only be edited by whoever owns its current stage. Without this,
// any signed-in user could rewrite any record, including one already sitting
// with the engineer for approval.
export function assertCanEdit(db, submissionId, user) {
  const sub = db.prepare('select * from submissions where id=?').get(submissionId);
  if (!sub) throw notFound('Submission not found.');
  assertStageOwnership(sub, user, {
    terminal: 'This record is approved and cannot be changed.',
    role: 'Your role cannot edit this record at its current stage.',
    owner: 'Your role cannot edit another technician\'s record.'
  });
}

export function signAndAdvance(db, { submissionId, user, signaturePng }) {
  if (!signaturePng) throw new Error('A signature is required before submitting.');

  const tx = db.transaction(() => {
    // Re-read state inside the transaction so two concurrent actors cannot
    // both advance the same record.
    const sub = db.prepare('select * from submissions where id=?').get(submissionId);
    if (!sub) throw notFound('Submission not found.');

    const stage = assertStageOwnership(sub, user, {
      terminal: 'This record is approved and cannot be changed.',
      role: 'Your role cannot sign this record at its current stage.',
      owner: 'Only the technician who created this record can submit it.',
      unknownState: (state) => `Unknown state: ${state}`
    });

    const now = new Date().toISOString();
    db.prepare(`insert into signatures (submission_id, stage, user_id, full_name, image_png, signed_at)
      values (?,?,?,?,?,?)`).run(submissionId, stage.actor, user.id, user.full_name ?? user.fullName ?? '', signaturePng, now);
    db.prepare('update submissions set state=?, updated_at=? where id=?').run(stage.next, now, submissionId);
    return db.prepare('select * from submissions where id=?').get(submissionId);
  });
  return tx();
}

export function queueFor(db, user) {
  if (user.role === 'admin') return db.prepare('select * from submissions order by updated_at desc').all();
  const stage = STAGES.find((s) => s.actor === user.role);
  if (user.role === 'technician') {
    return db.prepare('select * from submissions where created_by=? order by updated_at desc').all(user.id);
  }
  return db.prepare('select * from submissions where state=? order by updated_at desc').all(stage.state);
}

// The cumulative interval rule (selecting Y also brings 3M/6M tasks into
// scope) is advisory only — this never blocks anything, it just tells a
// caller what's still outstanding. A task counts as filled when its
// submission_fields value is non-empty after trimming; whitespace-only does
// not count. A falsy frequency (no interval chosen yet) leaves every task in
// scope, matching the un-filtered task list shown elsewhere.
export function completenessFor(db, submissionId, tasks, frequency) {
  const inScopeTasks = frequency ? tasksInScope(tasks, frequency) : tasks;
  const values = db.prepare('select field_key, value from submission_fields where submission_id=?').all(submissionId);
  const filledKeys = new Set(
    values.filter((v) => String(v.value ?? '').trim() !== '').map((v) => v.field_key)
  );
  const inScopeKeys = inScopeTasks.map((t) => `task_${t.row}`);
  const missing = inScopeKeys.filter((k) => !filledKeys.has(k));
  return { inScope: inScopeKeys.length, filled: inScopeKeys.length - missing.length, missing };
}
