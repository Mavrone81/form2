import { tasksInScope } from './intervals.js';

// `rejected` is a technician stage, not a fourth step: a rejected record has
// come back to whoever created it, is editable by them again exactly as a
// draft is, and travels the SAME chain upward from there
// (technician -> team leader -> engineer). Expressing it as a row in this
// table rather than as special cases scattered through the module is what
// makes every existing rule — stage ownership, editability, queue placement,
// `approved` is terminal — apply to it automatically and identically.
export const STAGES = [
  { state: 'draft', actor: 'technician', next: 'pending_lead' },
  { state: 'pending_lead', actor: 'team_leader', next: 'pending_engineer' },
  { state: 'pending_engineer', actor: 'engineer', next: 'approved' },
  { state: 'rejected', actor: 'technician', next: 'pending_lead' }
];

// The states a reviewer may reject FROM. Deliberately derived from the two
// review stages rather than written out again: a technician owns `draft` and
// `rejected` and has nothing to reject, and `approved` is terminal.
const REJECTABLE_STATES = new Set(
  STAGES.filter((s) => s.actor !== 'technician').map((s) => s.state)
);

// Every state a technician may be sitting on and still edit. Used only where
// a rule genuinely differs between "the technician holds this record" and
// "which particular technician-held state it is in".
const TECHNICIAN_STATES = new Set(
  STAGES.filter((s) => s.actor === 'technician').map((s) => s.state)
);

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
  // The controlled document's identity is captured HERE, once, alongside the
  // field snapshot. The catalog row is a live mirror of a file that can be
  // revised, rescanned or deleted at any time; a record signed against Rev E
  // must keep saying Rev E forever, so the archival PDF reads these columns
  // and never the catalog (server/routes.js, the /pdf route).
  const form = db.prepare('select doc_number, revision, content_hash from form_catalog where id=?').get(formId);
  const info = db.prepare(`insert into submissions
    (form_id, form_snapshot, machine_id, frequency, state, created_by, created_at, updated_at,
     doc_number, revision, content_hash)
    values (?,?,?,?, 'draft', ?,?,?, ?,?,?)`)
    .run(formId, JSON.stringify(fields), machineId, frequency, userId, now, now,
      form?.doc_number ?? '', form?.revision ?? '', form?.content_hash ?? '');
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
    // The technician types the machine id into the machine_id FIELD — there
    // is no separate control for it. Mirroring it onto the record itself in
    // the same transaction is what makes a queue row, a PDF header and an
    // archive filename able to name the machine at all. Done here rather than
    // in the route so no future caller of saveFields can drift from it.
    if (Object.prototype.hasOwnProperty.call(values, 'machine_id')) {
      db.prepare('update submissions set machine_id=?, updated_at=? where id=?')
        .run(String(values.machine_id ?? ''), new Date().toISOString(), submissionId);
    }
  });
  tx(Object.entries(values));
}

// The maintenance interval decides which tasks are in scope — which work the
// technician actually did. It is part of the record, not a view setting: the
// reviewer must be shown the same scope, and the archived PDF must print it.
// Changing it is therefore an edit of the record, subject to the same stage
// ownership as any other, plus one extra rule: the interval belongs to the
// technician's own draft stage and is frozen the moment the record leaves it.
// A team leader owns the pending_lead stage for editing purposes, but must
// never be able to re-scope work that has already been performed and signed.
export function setFrequency(db, submissionId, frequency, user) {
  assertCanEdit(db, submissionId, user);
  const sub = db.prepare('select state from submissions where id=?').get(submissionId);
  // A rejected record carries NO signatures — rejection clears them all — so
  // the rule this message states is literally true of it: nothing has been
  // signed, and nothing is being re-scoped behind a signer's back. A record
  // sent back because the wrong interval was worked would otherwise be
  // uncorrectable, which is the one thing the send-back exists to prevent.
  if (!TECHNICIAN_STATES.has(sub.state)) {
    throw forbidden('The maintenance interval can no longer be changed — this record has been signed.');
  }
  db.prepare('update submissions set frequency=?, updated_at=? where id=?')
    .run(String(frequency), new Date().toISOString(), submissionId);
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

// A signature is the one thing on this record that attests a named person
// approved it, so what gets stored has to actually BE a signature image.
//
// This is not an XSS defence — the value only ever reaches an <img src>, and
// a browser executes neither `javascript:` nor script inside an SVG loaded
// that way. It is an INTEGRITY defence. Before this, anything truthy was
// accepted, so a record could be "signed" with a string that is not an image
// at all and the workflow would advance it as a valid sign-off; a reviewer
// would open an approved quality record and find a broken image where the
// attestation should be, with no way to tell whether the sign-off ever
// happened.
//
// Two independent things are checked, because the first is only a claim:
//   * the `data:image/png;base64,` prefix — what the caller SAYS it sent;
//   * the PNG magic number in the decoded bytes — EVIDENCE of what it is.
// Declaring image/png costs an attacker nothing, so the declaration alone
// would be no rule at all.
//
// Nothing here repairs or coerces a bad value. A signature that had to be
// corrected before it could be stored is not the mark the signer made, and
// silently storing a fixed-up version is exactly the sort of thing an audit
// of these records exists to catch. Bad input is refused outright.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URI_PREFIX = 'data:image/png;base64,';

// 1 MiB of decoded image. A pad stroke from server/../web/js/signature-pad.js
// is a few tens of KB, so this is orders of magnitude more than a real
// signature needs while still bounding what one row can put in the database.
// The corresponding data URI is ~1.37 MB (base64 costs 4 bytes per 3), which
// sits comfortably under the 4mb express.json limit in server/index.js — so
// an oversized signature is refused HERE, with a message that says what is
// wrong, instead of being cut off by the body parser as a bare 413.
const MAX_SIGNATURE_BYTES = 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_SIGNATURE_BYTES / 3) * 4;

// Buffer.from(s, 'base64') is deliberately lenient: it discards characters
// outside the alphabet rather than failing, so "!!!!" decodes to an empty
// buffer instead of an error and `javascript:alert(1)` decodes to garbage.
// That leniency is the whole reason a decode alone cannot be trusted, so the
// payload is checked against the strict base64 grammar first.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Exported so that any FUTURE path which stores a signature can apply the
// identical rule. It is not a substitute for calling signAndAdvance: that
// function enforces this itself, for the same reason saveFields enforces
// assertCanEdit rather than trusting its callers to remember.
export function assertValidSignature(signaturePng) {
  if (!signaturePng) throw new Error('A signature is required before submitting.');
  if (typeof signaturePng !== 'string') {
    throw new Error('That signature is not a PNG image and cannot be accepted.');
  }
  if (!signaturePng.startsWith(PNG_DATA_URI_PREFIX)) {
    throw new Error('That signature is not a PNG image and cannot be accepted.');
  }

  const payload = signaturePng.slice(PNG_DATA_URI_PREFIX.length);
  // Length first, before decoding, so an oversized payload is never expanded
  // into memory just to be thrown away.
  if (payload.length > MAX_BASE64_CHARS) {
    throw new Error(`That signature is too large — a signature must be under ${MAX_SIGNATURE_BYTES / 1024} KB.`);
  }
  if (!BASE64_RE.test(payload) || payload.length % 4 !== 0) {
    throw new Error('That signature is not a valid PNG image and cannot be accepted.');
  }

  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length > MAX_SIGNATURE_BYTES) {
    throw new Error(`That signature is too large — a signature must be under ${MAX_SIGNATURE_BYTES / 1024} KB.`);
  }
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error('That signature is not a PNG image and cannot be accepted.');
  }
}

export function signAndAdvance(db, { submissionId, user, signaturePng }) {
  // Checked before the transaction opens: the rule reads only the submitted
  // payload, never any record state, so refusing here reveals nothing about
  // whether the record exists or who owns it — the answer is the same 400 for
  // any submission id. A caller who IS entitled to sign still meets the
  // unchanged ownership check inside the transaction below.
  //
  // Thrown WITHOUT the FORBIDDEN marker, so routes map it to 400: the caller
  // may well have been entitled to sign, their input was simply unusable.
  // Exactly the distinction the missing-signature case has always made, and
  // that rejectSubmission makes for a missing reason.
  assertValidSignature(signaturePng);

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

// Send a record back to the technician for correction.
//
// Three decisions are encoded here, and each one is load-bearing:
//
// 1. A rejection ALWAYS returns the record to the technician, never one stage
//    back. Both reviewers can reject; either way the record restarts at the
//    bottom and climbs the same chain again. There is no "back to the team
//    leader" state, because the work being corrected is the technician's.
//
// 2. It clears EVERY signature on the record. A signature is the record's
//    claim that a named person saw exactly this content; the content is about
//    to change, so every such claim would become false. When an engineer
//    rejects, that means the team leader's signature goes too, not only the
//    technician's — the team leader verified answers that are about to be
//    rewritten.
//
// 3. The rejection itself is permanent. Clearing signatures must not erase
//    what happened, so who rejected, from which stage, when and why are
//    written to `rejections` (see server/db.js) before the ink is deleted,
//    with a SERVER timestamp — a client clock must never decide a date on a
//    quality record, exactly as with a signature.
//
// A missing reason is thrown WITHOUT the FORBIDDEN marker, so routes map it
// to 400: the caller was entitled to act, their input was unusable. That is
// the same distinction signAndAdvance already makes for a missing signature.
export function rejectSubmission(db, { submissionId, user, reason }) {
  const text = String(reason ?? '').trim();
  if (!text) throw new Error('A reason is required to reject this record.');

  const tx = db.transaction(() => {
    // Re-read state inside the transaction, exactly as signAndAdvance does,
    // so two reviewers acting at the same moment cannot both reject — the
    // second finds the record already `rejected` (a technician stage) and is
    // refused by the shared ownership rule below.
    const sub = db.prepare('select * from submissions where id=?').get(submissionId);
    if (!sub) throw notFound('Submission not found.');

    // Reuse the one ownership rule rather than writing a parallel one: this
    // is what makes `approved` terminal here for free, and refuses any role
    // that does not own the record's current stage.
    const stage = assertStageOwnership(sub, user, {
      terminal: 'This record is approved and cannot be changed.',
      role: 'Your role cannot reject this record at its current stage.',
      owner: 'Your role cannot reject this record at its current stage.',
      unknownState: (state) => `Unknown state: ${state}`
    });

    // Ownership alone is not enough: a technician legitimately owns `draft`
    // and `rejected`, and has nothing to reject. Only a reviewer awaiting
    // their own review may send a record back.
    if (!REJECTABLE_STATES.has(sub.state)) {
      throw forbidden('Only a reviewer can reject a record, and only while it is awaiting their review.');
    }

    const now = new Date().toISOString();
    // History first, then the ink: within one transaction the order does not
    // change the outcome, but written this way the code reads as what it
    // guarantees — the record of the rejection outlives the signatures it
    // invalidates.
    db.prepare(`insert into rejections (submission_id, rejected_by, full_name, stage, reason, rejected_at)
      values (?,?,?,?,?,?)`)
      .run(submissionId, user.id, user.full_name ?? user.fullName ?? '', stage.actor, text, now);
    db.prepare('delete from signatures where submission_id=?').run(submissionId);
    db.prepare('update submissions set state=?, updated_at=? where id=?').run('rejected', now, submissionId);
    return db.prepare('select * from submissions where id=?').get(submissionId);
  });
  return tx();
}

export function queueFor(db, user) {
  if (user.role === 'admin') return db.prepare('select * from submissions order by updated_at desc').all();
  // A technician sees every record they created, in any state — including a
  // `rejected` one, which is the only place it can be reached and is the
  // whole point of sending it back to them.
  if (user.role === 'technician') {
    return db.prepare('select * from submissions where created_by=? order by updated_at desc').all(user.id);
  }
  // A reviewer sees only records sitting in their own review state, so a
  // record they just rejected leaves their queue immediately rather than
  // lingering there awaiting an action they have already taken.
  const stage = STAGES.find((s) => s.actor === user.role);
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
