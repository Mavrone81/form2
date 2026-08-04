export const STAGES = [
  { state: 'draft', actor: 'technician', next: 'pending_lead' },
  { state: 'pending_lead', actor: 'team_leader', next: 'pending_engineer' },
  { state: 'pending_engineer', actor: 'engineer', next: 'approved' }
];

const stageFor = (state) => STAGES.find((s) => s.state === state);

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

export function saveFields(db, submissionId, values) {
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
  if (!sub) throw new Error('Submission not found.');
  if (sub.state === 'approved') throw new Error('This record is approved and cannot be changed.');
  const stage = stageFor(sub.state);
  if (!stage || stage.actor !== user.role)
    throw new Error('Your role cannot edit this record at its current stage.');
  if (stage.actor === 'technician' && sub.created_by !== user.id)
    throw new Error('Your role cannot edit another technician\'s record.');
}

export function signAndAdvance(db, { submissionId, user, signaturePng }) {
  if (!signaturePng) throw new Error('A signature is required before submitting.');

  const tx = db.transaction(() => {
    // Re-read state inside the transaction so two concurrent actors cannot
    // both advance the same record.
    const sub = db.prepare('select * from submissions where id=?').get(submissionId);
    if (!sub) throw new Error('Submission not found.');
    if (sub.state === 'approved') throw new Error('This record is approved and cannot be changed.');

    const stage = stageFor(sub.state);
    if (!stage) throw new Error(`Unknown state: ${sub.state}`);
    if (stage.actor !== user.role) throw new Error('Your role cannot sign this record at its current stage.');
    if (stage.actor === 'technician' && sub.created_by !== user.id)
      throw new Error('Only the technician who created this record can submit it.');

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
