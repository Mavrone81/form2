import { tasksInScope } from './intervals.js';
import { optionsOf } from './db.js';

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

export function createSubmission(db, { formId, userId, machineId = '', frequency = '', snapshot = null, clientUuid = null }) {
  const now = new Date().toISOString();
  // The controlled document's identity is captured HERE, once, alongside the
  // field snapshot. The catalog row is a live mirror of a file that can be
  // revised, rescanned or deleted at any time; a record signed against Rev E
  // must keep saying Rev E forever, so the archival PDF reads these columns
  // and never the catalog (server/routes.js, the /pdf route).
  const form = db.prepare('select doc_number, revision, content_hash, state, file_type from form_catalog where id=?').get(formId);
  // A record may only be started against a form an admin has actually
  // mapped: `needs_setup` has no field list to snapshot at all, `inactive`
  // is a form withdrawn from use, and a `pdf` form has no fields table
  // entries by construction (server/scanner.js never populates one). Without
  // this, any of those produced a SIGNED, approved-looking record with an
  // empty field snapshot and no document identity — every rule downstream
  // (saveFields, signAndAdvance, the PDF route) would run against it
  // successfully, because none of them re-check the form's own state; they
  // trust the submission that already exists. Checked HERE, in the one
  // function every caller creates a submission through (POST /submissions
  // for the browser, POST /api/sync for the device), so neither can bypass
  // it. A missing formId and an existing-but-not-ready one are reported
  // identically: from the caller's side both mean "you cannot start a record
  // against this form right now."
  if (!form || form.state !== 'ready' || form.file_type !== 'xlsx') {
    const err = new Error('This form is not ready for records — it must be scanned and mapped by an admin first.');
    err.code = 'INVALID';
    throw err;
  }
  const fields = snapshot ??
    db.prepare('select field_key, label, section, kind, options, sort_order from form_fields where form_id=? order by sort_order').all(formId);
  // `clientUuid` is the Android app's offline id for a record created before
  // it ever reached the server — see the client_uuid comment in
  // server/db.js. Null for every browser-created submission, which has no
  // such id at all.
  const info = db.prepare(`insert into submissions
    (form_id, form_snapshot, machine_id, frequency, state, created_by, created_at, updated_at,
     doc_number, revision, content_hash, client_uuid)
    values (?,?,?,?, 'draft', ?,?,?, ?,?,?, ?)`)
    .run(formId, JSON.stringify(fields), machineId, frequency, userId, now, now,
      form?.doc_number ?? '', form?.revision ?? '', form?.content_hash ?? '', clientUuid);
  return db.prepare('select * from submissions where id=?').get(info.lastInsertRowid);
}

// The other half of create-or-find-by-client_uuid: POST /api/sync
// (server/routes.js) calls this first for every record in a batch, so a
// replayed record — the device retrying after a dropped response, or
// genuinely syncing twice — resolves to the SAME submission instead of a
// duplicate. Returns undefined for an id this device has not synced before,
// exactly like better-sqlite3's own `.get()`.
export function findByClientUuid(db, clientUuid) {
  return db.prepare('select * from submissions where client_uuid=?').get(clientUuid);
}

// Closes the one race a check-then-insert pattern cannot close by itself:
// POST /api/sync (server/routes.js) calls findByClientUuid, finds nothing,
// and only THEN calls createSubmission — so two requests for the same
// never-before-seen client_uuid can both pass the check before either has
// inserted, and the loser's insert hits the `idx_sub_uuid` partial unique
// index (server/db.js) and throws instead of succeeding.
//
// This server is a single Node process with one better-sqlite3 connection —
// synchronous, one JS thread — so that interleaving cannot actually happen
// here today; nothing in this codebase can race itself. It is handled anyway
// because the same database file may one day sit behind more than one
// process, and the failure mode if it isn't is bad: the LOSING request's
// insert would surface as a bare, uncoded error, and a device that reads
// that as "try again" would retry the exact same record forever, even
// though the database already has it. The winner's row is the correct
// answer for the loser to report right back, exactly as if it had never
// tried to create anything and had found it on the very first check.
//
// Returns the pre-existing submission when `err` is that unique-constraint
// violation and one truly exists for `clientUuid`; otherwise null, so the
// caller knows to let the original error stand.
export function recoverFromDuplicateClientUuid(db, err, clientUuid) {
  const isUniqueViolation = err?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || /UNIQUE constraint failed/i.test(err?.message ?? '');
  if (!isUniqueViolation || !clientUuid) return null;
  return findByClientUuid(db, clientUuid) ?? null;
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

  // A field the form constrains to a list of answers accepts those answers and
  // nothing else. The Calibration Record's Pass/Fail column is the first such
  // field: the document prints two boxes, so a third answer could not be placed
  // on the sheet at all — it would be stored, shown in the panel, and then be
  // silently missing from the archived record, which is the worst of the three
  // outcomes. Clearing an answer (the empty string) is always allowed: an
  // unanswered measurement is a real state and is how a field is un-set.
  //
  // Enforced HERE, beside assertCanEdit, for the same reason that check is:
  // this is the one door every route writes values through, so no future
  // caller can bypass it. The constraint is read from the submission's OWN
  // snapshot, so revising the source form later cannot retroactively
  // invalidate an answer already recorded against the old one.
  for (const f of snapshot) {
    const allowed = optionsOf(f);
    if (!allowed.length) continue;
    if (!Object.prototype.hasOwnProperty.call(values, f.field_key)) continue;
    const value = String(values[f.field_key] ?? '').trim();
    if (value && !allowed.includes(value)) {
      const err = new Error(`"${f.label}" must be one of: ${allowed.join(', ')}.`);
      err.code = 'INVALID';
      throw err;
    }
  }

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

// Who may read a record's archival PDF. Lives here, beside every other rule
// about who may do what to a record, so the HTTP route is left translating a
// throw into a status code and nothing else -- the same division assertCanEdit
// already establishes.
//
// Three rules, and the technician one is the newest:
//   * an admin may always read it;
//   * a team leader or engineer may read it only once THEIR OWN signature row
//     exists -- proof they have actually signed this record, not merely that
//     they hold the role;
//   * a technician may read the PDF of a record THEY created, in any state.
//     A technician was previously refused in every state, which was wrong in
//     a way the Android app made obvious: a record they filled in and signed
//     is their own work, the app already renders exactly this document
//     on-device before it is synced, and the server's copy is the only
//     renderer available once the record HAS synced (see the preview
//     fallback in the design spec). Another technician's record stays
//     refused -- ownership, not role, is the rule.
export function assertCanViewPdf(db, sub, user) {
  if (user.role === 'admin') return;
  if (user.role === 'technician') {
    if (sub.created_by === user.id) return;
    throw forbidden('Your role cannot view another technician\'s record.');
  }
  const signedStages = db.prepare('select stage from signatures where submission_id=?')
    .all(sub.id).map((s) => s.stage);
  if ((user.role === 'team_leader' || user.role === 'engineer') && signedStages.includes(user.role)) return;
  throw forbidden('Available once you have signed this record.');
}

// A record may only be scoped to an interval the controlled document itself
// defines -- `frequencies` is that document's own list, as parsed from the
// workbook, never a hardcoded set. Shared by PATCH /submissions/:id (a
// browser changing the interval) and POST /api/sync (a device replaying a
// record it created offline) so the two can never disagree about what counts
// as a valid interval, or about the wording a caller is told when it isn't.
//
// INVALID rather than FORBIDDEN: an interval the form does not offer is bad
// input, not a permission failure -- the same distinction saveFields' option
// check and assertValidSignature already make, and what maps this to a 400
// on the browser side and to a per-record INVALID on the device side.
export function assertFrequencyOffered(frequencies, frequency) {
  if (!frequencies.includes(String(frequency))) {
    const err = new Error('That maintenance interval is not one this form offers.');
    err.code = 'INVALID';
    throw err;
  }
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

// INVALID, like saveFields' constrained-option check and createSubmission's
// form-readiness check: a bad signature is the caller's input being
// unusable, not a permission failure, and every one of those three is the
// same kind of thing from a caller's point of view. Marking it lets a route
// map it to 400 (statusFor) without string-matching, and lets a caller like
// POST /api/sync tell it apart from a genuinely internal failure -- see the
// FORBIDDEN/NOT_FOUND/INVALID handling in that route's own catch.
//
// This does NOT change signAndAdvance's own behaviour: it already reads as
// a 400 everywhere it is called (every existing caller's `statusFor(err,
// 400)` fallback already lands there for an uncoded error) -- this only
// gives that same outcome an explicit code instead of an implicit fallback.
function invalidSignature(message) {
  const err = new Error(message);
  err.code = 'INVALID';
  return err;
}

// Exported so that any FUTURE path which stores a signature can apply the
// identical rule. It is not a substitute for calling signAndAdvance: that
// function enforces this itself, for the same reason saveFields enforces
// assertCanEdit rather than trusting its callers to remember.
export function assertValidSignature(signaturePng) {
  if (!signaturePng) throw invalidSignature('A signature is required before submitting.');
  if (typeof signaturePng !== 'string') {
    throw invalidSignature('That signature is not a PNG image and cannot be accepted.');
  }
  if (!signaturePng.startsWith(PNG_DATA_URI_PREFIX)) {
    throw invalidSignature('That signature is not a PNG image and cannot be accepted.');
  }

  const payload = signaturePng.slice(PNG_DATA_URI_PREFIX.length);
  // Length first, before decoding, so an oversized payload is never expanded
  // into memory just to be thrown away.
  if (payload.length > MAX_BASE64_CHARS) {
    throw invalidSignature(`That signature is too large — a signature must be under ${MAX_SIGNATURE_BYTES / 1024} KB.`);
  }
  if (!BASE64_RE.test(payload) || payload.length % 4 !== 0) {
    throw invalidSignature('That signature is not a valid PNG image and cannot be accepted.');
  }

  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length > MAX_SIGNATURE_BYTES) {
    throw invalidSignature(`That signature is too large — a signature must be under ${MAX_SIGNATURE_BYTES / 1024} KB.`);
  }
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw invalidSignature('That signature is not a PNG image and cannot be accepted.');
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
