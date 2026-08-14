import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { authenticate, requireRole, createUser, ROLES } from './auth.js';
import { issueDeviceToken, revokeDeviceToken, revokeUserTokens, validateDeviceToken } from './device-tokens.js';
import { listForms, scanFolder } from './scanner.js';
import { buildGrid } from './grid-model.js';
import { parseWorkbook } from './excel-parser.js';
import { tasksInScope, scopeSummary } from './intervals.js';
import { cellMapFor } from './cell-map.js';
import { createSubmission, findByClientUuid, recoverFromDuplicateClientUuid, saveFields, signAndAdvance, rejectSubmission, queueFor, assertCanEdit, assertCanViewPdf, assertFrequencyOffered, completenessFor, setFrequency, STAGES } from './workflow.js';
import { renderRecordPdf } from './pdf-record.js';
import { createLoginThrottle } from './login-throttle.js';

const signedIn = requireRole(...ROLES);

// Bearer-token counterpart to `signedIn`, for the Android app: accepts
// either an existing signed-in session (same rule `signedIn` applies) or a
// device's `Authorization: Bearer <token>` header. A factory rather than a
// plain middleware -- like `requireRole`'s returned function needs no `db`,
// this one does, to look the token up -- so a route wires it up as
// `tokenOrSession(db)` inside makeRoutes, where `db` is in scope.
//
// The token branch never reads or touches `req.session`. A bearer-authed
// request is not a login: a shared shop-floor browser must never come away
// signed in as whoever's phone last called this route with a token, and a
// device that only ever sends a token must never accumulate server-side
// session state on its behalf. `validateDeviceToken` itself stamps
// `last_used_at` on every successful lookup, so this middleware does not
// repeat that write.
//
// Precedence when a request carries BOTH a well-formed `Bearer` header and a
// valid session cookie: the token is checked first and, if well-formed,
// decides the request outright -- an INVALID token gets 401 even though a
// valid session sits right there, rather than silently falling back to it.
// This is deliberate, not an oversight: presenting a token is the client
// asking to be judged as a device, and a fallback to the session would let a
// revoked or expired device token keep working for as long as the browser
// tab that issued it (or an admin's shared kiosk session) stays signed in --
// exactly the hole `revokeUserTokens` exists to close. Failing closed here
// keeps that guarantee regardless of what else is sitting in the cookie jar.
function tokenOrSession(db) {
  return (req, res, next) => {
    // toLowerCase(): RFC 7235 auth-scheme tokens are case-insensitive, and
    // nothing in the HTTP spec requires a client to send exactly `Bearer`.
    const [scheme, token] = String(req.get('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) {
      const user = validateDeviceToken(db, token);
      if (!user) return res.status(401).json({ error: 'Invalid or expired device token.' });
      req.deviceUser = user;
      req.authVia = 'token';
      return next();
    }
    if (!req.session?.user) return res.status(401).json({ error: 'Sign in to continue.' });
    req.authVia = 'session';
    next();
  };
}

// The identity behind a tokenOrSession-guarded request, however it
// authenticated -- the device user a bearer token resolved to, or the
// session user -- so a route reads one thing instead of branching on
// req.authVia itself just to find out who is acting.
const actingUser = (req) => req.deviceUser ?? req.session?.user ?? null;

// POST /api/sync's own guard -- deliberately NOT tokenOrSession. Sync exists
// for the Android app replaying its offline queue, and only for that: a
// browser tab's session cookie must never be accepted here, even a valid
// one, because a shared shop-floor browser silently syncing "whoever is
// signed in"'s offline queue is not a thing that can happen -- there is no
// offline queue in the browser. Presenting no Authorization header, or a
// session with no token, is refused with the same 401 an invalid token gets;
// there is no session fallback to have a precedence rule about.
function deviceTokenOnly(db) {
  return (req, res, next) => {
    const [scheme, token] = String(req.get('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return res.status(401).json({ error: 'A device token is required.' });
    }
    const user = validateDeviceToken(db, token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired device token.' });
    req.deviceUser = user;
    req.authVia = 'token';
    next();
  };
}

// client_uuid is the Android app's own offline id for a record, minted
// before the record ever reaches the server -- see the column comment in
// server/db.js. Validated as UUID-shaped (36 chars: 8-4-4-4-12 hex, RFC 4122
// layout) before it is ever used as a lookup key or stored: an unvalidated
// string reaching a WHERE client_uuid=? clause is harmless in itself, but a
// malformed or empty value from a buggy client must be refused loudly rather
// than silently colliding with another record's id one day.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function syncError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The generic message a device sees for anything that is not one of the
// FORBIDDEN/NOT_FOUND/INVALID vocabulary's own (user-facing, deliberately
// worded) messages. An uncoded throw can be anything from better-sqlite3's
// own wording to a bug elsewhere in the request path -- it may name a
// filesystem path or a SQL fragment -- and none of that belongs on a
// device's screen. The real error is still logged server-side, with the
// record's client_uuid, so it stays diagnosable.
const SYNC_GENERIC_ERROR = 'This record could not be synced. Please try again.';

// One record of a sync batch. Every failure -- a bad uuid, someone else's
// uuid, an unknown form, an invalid answer, a bad signature -- is caught
// HERE and turned into this record's own `error`, never allowed to escape
// and abort the records after it: a phone replaying twenty offline records
// must not lose the other nineteen because one had a stale formId.
//
// `frequencies` is the batch-wide Map built by frequenciesForBatch: formId ->
// the interval list that form offers, or null when it could not be
// determined. Passed in rather than looked up here so this function stays
// synchronous (no workbook parse inside the per-record loop) and so one
// form's file is read once per BATCH, not once per record naming it.
function syncOneRecord(db, user, record, frequencies) {
  // The device's own casing is echoed straight back in `out` unchanged, so
  // it always sees exactly what it sent -- normalization below is an
  // internal lookup/storage detail, not something the caller needs to know
  // about.
  const rawUuid = record?.client_uuid;
  const out = { client_uuid: rawUuid, submissionId: null, state: null };
  // Tracked outside the try so a failure partway through (e.g. an invalid
  // field value AFTER the submission was created-or-found) can still report
  // the id and state it reached, rather than the caller losing track of a
  // draft that genuinely exists and just needs a corrected retry.
  let sub = null;
  try {
    if (typeof rawUuid !== 'string' || !UUID_RE.test(rawUuid)) {
      throw syncError('INVALID', 'client_uuid must be a UUID.');
    }
    // SQLite's default BINARY collation is case-sensitive, so "2FAE..." and
    // "2fae..." are two different keys for what RFC 4122 (and any sane
    // device) considers the SAME uuid. Left unnormalized, that let a replay
    // with different casing create a SECOND submission for one job, and let
    // one user reach ANOTHER user's record by upcasing its uuid past the
    // FORBIDDEN check just below. Every lookup and every stored value from
    // here on uses this single lowercased form.
    const clientUuid = rawUuid.toLowerCase();

    // `values` is optional (absent means no field changes this sync), but
    // if present it must be a plain object -- an array, string or number
    // here would reach saveFields' `Object.entries`/`hasOwnProperty` calls
    // and either silently do nothing useful or throw a confusing,
    // uncoded error. Caught here, before any create-or-find work, as its
    // own clearly-worded INVALID.
    const values = record?.values;
    if (values !== undefined && (typeof values !== 'object' || values === null || Array.isArray(values))) {
      throw syncError('INVALID', 'values must be an object of field values.');
    }

    sub = findByClientUuid(db, clientUuid);
    // A uuid that exists but was created by someone else must not leak
    // anything about that record -- not its id, not its state, not even
    // that saveFields or signAndAdvance would have refused it for some
    // OTHER reason too. FORBIDDEN and nothing else, exactly as a stranger
    // guessing a uuid at random would get -- hence clearing `sub` back to
    // null rather than leaving it set for the assignment below.
    if (sub && sub.created_by !== user.id) {
      sub = null;
      throw syncError('FORBIDDEN', 'This record belongs to another user.');
    }

    if (!sub) {
      const form = db.prepare('select id from form_catalog where id=?').get(record?.formId);
      if (!form) throw syncError('NOT_FOUND', 'Form not found.');
      // The interval is validated HERE, on the create path, because this is
      // the only place a device's `frequency` is ever consumed: a record
      // that already exists keeps the interval it was created with (the
      // replay branch below re-applies nothing), so re-checking it on a
      // replay could only turn a record the server already holds into a
      // permanent error. An absent/empty frequency is left alone -- an
      // un-scoped record is a real state the browser allows too -- and a
      // null entry means the form's own list could not be read (see
      // frequenciesForBatch), in which case nothing is claimed either way.
      const frequency = String(record?.frequency ?? '');
      const offered = frequencies?.get(record?.formId) ?? null;
      if (frequency && offered) assertFrequencyOffered(offered, frequency);
      try {
        sub = createSubmission(db, {
          formId: record.formId,
          userId: user.id,
          machineId: record?.machineId ?? '',
          frequency: record?.frequency ?? '',
          clientUuid
        });
      } catch (err) {
        // See recoverFromDuplicateClientUuid (server/workflow.js) for why
        // this exists even though this single process cannot race itself
        // today: it recovers the row a genuinely concurrent winner already
        // created, rather than surfacing a bare error for a record the
        // database already has.
        const recovered = recoverFromDuplicateClientUuid(db, err, clientUuid);
        if (!recovered) throw err;
        sub = recovered;
      }
    }

    // Idempotent replay: a record already advanced past `draft` carries the
    // first sync's saveFields + signature already, so applying either again
    // would be wrong (saveFields would throw -- assertCanEdit's stage
    // ownership no longer names this technician as the owner of e.g.
    // pending_lead -- and re-signing would mean two sign-offs for one
    // submit). Only `draft` -- a fresh create above, or a previous sync that
    // inserted the row but was cut off before signing -- gets the remaining
    // steps applied. `rejected` is deliberately excluded even though a
    // technician owns it too: a record sent back for correction needs a
    // person to look at it and resubmit deliberately, not to be silently
    // re-applied by a device replaying its old queue.
    //
    // signedAtDevice is accepted in the request shape and never read here:
    // signAndAdvance stamps signed_at from the SERVER clock, exactly as it
    // does for a browser sign-off, because a device's clock is not trusted
    // on a records system any more than its camera is trusted for the
    // signature ink itself.
    if (sub.state === 'draft') {
      saveFields(db, sub.id, values ?? {}, user);
      sub = signAndAdvance(db, {
        submissionId: sub.id,
        user,
        signaturePng: record?.signaturePng ?? ''
      });
    }
  } catch (err) {
    // The FORBIDDEN/NOT_FOUND/INVALID vocabulary is written for a caller to
    // read -- pass those messages through unchanged. Anything else is an
    // internal failure (a SQLite message, a bug) that must never reach the
    // device verbatim; log the real thing, with the uuid to correlate it
    // against server logs, and answer with a fixed, generic message instead.
    if (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND' || err.code === 'INVALID') {
      out.error = { code: err.code, message: err.message };
    } else {
      console.error(`Sync: record ${rawUuid ?? '(missing client_uuid)'} failed:`, err);
      out.error = { code: 'ERROR', message: SYNC_GENERIC_ERROR };
    }
  }
  if (sub) { out.submissionId = sub.id; out.state = sub.state; }
  return out;
}

// Signatures must be read back in the workflow's own order — technician,
// then team leader, then engineer — because drawSignatures lays block i at
// column i, so this ordering IS the printed order on the archival record.
// With no ORDER BY, SQLite served them from the (submission_id, stage) unique
// index, i.e. alphabetically: engineer, team_leader, technician — printing
// every record's sign-off inverted. Built from STAGES so it can never drift
// from the workflow it claims to mirror; the values are module constants,
// never request input.
// Deduplicated by actor: STAGES gained a second technician-actor row when
// `rejected` was added (a rejected record is back with its technician), and
// a stage actor must appear exactly once in this CASE. Set preserves first
// insertion order, so the sign-off order technician -> team_leader ->
// engineer is still read straight off the workflow table.
const SIGNING_ACTORS = [...new Set(STAGES.map((s) => s.actor))];
const STAGE_ORDER_SQL = `case stage ${SIGNING_ACTORS.map((a, i) => `when '${a}' then ${i}`).join(' ')} else ${SIGNING_ACTORS.length} end`;
const SIGNATURES_SQL =
  `select stage, full_name, image_png, signed_at from signatures where submission_id=? order by ${STAGE_ORDER_SQL}`;

// Rejection history, oldest first. A technician who cannot see WHY their
// record came back cannot act on it, so this travels with the record itself
// rather than sitting behind a separate, easily-forgotten call. There is no
// ink here to withhold — only attribution and the reviewer's own words — so
// unlike signatures it is returned in full to every reader entitled to read
// the record at all.
const REJECTIONS_SQL =
  'select stage, full_name, reason, rejected_at from rejections where submission_id=? order by id';

// Signature ink is replayable: an image lifted from one record could be
// pasted onto another. Attribution (who signed, when) stays legible to every
// signed-in reader, but the image itself is returned only to the stage that
// drew it and to an admin — mirroring the PDF route's own rule rather than
// leaving a second, laxer path to the same evidence.
const visibleSignatures = (rows, user) => rows.map(({ image_png, ...rest }) =>
  (user.role === 'admin' || rest.stage === user.role) ? { ...rest, image_png } : rest);

// Express 4 does not catch a rejected promise thrown by an async handler —
// it becomes an unhandled rejection, and Node 22's default
// --unhandled-rejections=throw kills the whole process. Wrapping every async
// handler funnels any escaping error into Express's error pipeline (via
// next(err)) instead, where the error-handling middleware in index.js turns
// it into a clean response. Hand-written per-handler try/catch is exactly
// what let two routes slip through before this existed.
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// A form's cataloged state only reflects the last scan — the file itself may
// have been deleted, renamed, or corrupted since. Any route that reads it
// off disk must treat that as an ordinary, expected failure: log the real
// error server-side, and never let the underlying message (which can
// contain absolute filesystem paths) reach the client. Shared by every route
// that surfaces this failure to a caller, single- or multi-form alike, so
// the wording never drifts between them.
const UNREADABLE_FORM_MESSAGE = 'This form could not be read. Ask an admin to rescan.';

function unreadableForm(res, formId, err) {
  console.error(`Could not read form ${formId} from disk:`, err);
  res.status(500).json({ error: UNREADABLE_FORM_MESSAGE });
}

// The permission rules in workflow.js mark their errors with `code` so a
// route never has to string-match a message to pick a status code.
// FORBIDDEN is always a 403; anything else falls back to whatever this
// specific route already used for a non-permission failure.
//
// INVALID is a 400 wherever it is thrown: a value the form does not accept is
// a bad request, not a permission failure. Without it the field-save route's
// own 403 fallback would answer "forbidden" to a technician who simply picked
// an answer the document has no box for — which reads as "you may not edit
// this record" and sends them looking for the wrong problem.
const statusFor = (err, fallback) =>
  err.code === 'FORBIDDEN' ? 403 : err.code === 'NOT_FOUND' ? 404 : err.code === 'INVALID' ? 400 : fallback;

// The request-independent half of a form's definition: everything
// /forms/:id/fields and GET /bundle both need, and nothing either of them
// derives from its own query string. (inScope/summary/completeness are NOT
// here — they are computed against a `frequency`/`submissionId` a caller
// supplies, which the bundle route has no such thing to supply on any one
// form's behalf, so they stay in that route alone.)
//
// Also returns `def`, the raw parseWorkbook() result -- an internal detail
// callers that only want the /forms/:id/fields-shaped payload must strip
// back out before responding (see its one destructuring use below), but
// which GET /bundle needs so it can feed the SAME parse into buildGrid
// instead of paying for a second one. Threading it through here is what
// keeps parseWorkbook called exactly once per form per bundle request:
// calling it again for buildGrid used to mean two full reads and XLSX
// parses of the same file per form (and a window where the two could
// observe different content if a rescan/write raced mid-request) in the one
// endpoint whose entire point is a single bulk sync call.
//
// Throws (never catches) when the file cannot be parsed — parseWorkbook's
// own rejection propagates straight out — so each caller decides for itself
// what a parse failure means for ITS response: one form's fields route turns
// it into a 500, while the bundle route sets that one form aside in
// `skipped` and keeps going for every other form.
async function formSpec(db, form) {
  const fields = db.prepare('select * from form_fields where form_id=? order by sort_order').all(form.id);
  let tasks = [], frequencies = [], def = null;
  // Where each entered value belongs on the reproduced sheet, so the left
  // pane can show the record as it will look on paper instead of a blank
  // form. Derived from the parsed definition, never guessed: a field with
  // no determinate cell (e.g. every task status on the two forms that have
  // no Status column) is simply absent, and the client renders only what it
  // is told. Both default to an empty/absent map so a pdf form, or one that
  // is not `ready`, still returns a valid payload.
  // ...and which printed option of the frequency band each interval is, so
  // the preview can ring the selected one the way a technician rings it on
  // paper. Absent for an interval the form does not offer.
  let cellFor = {}, titleCell = null, intervalCells = {}, calibrationCells = {};
  if (form.file_type === 'xlsx' && form.state === 'ready') {
    def = await parseWorkbook(form.file_path);
    tasks = def.tasks; frequencies = def.frequencies;
    ({ cellFor, titleCell, intervalCells, calibrationCells } = cellMapFor(def));
  }
  return { form, fields, frequencies, tasks, cellFor, titleCell, intervalCells, calibrationCells, def };
}

// form_catalog columns that are server-internal bookkeeping and must not
// travel to a device in GET /bundle.
//
//  * file_path is the absolute path of the controlled document on the
//    server's filesystem. A phone has no possible use for it, and a bundle
//    is cached on the device (and readable by anything that gets at that
//    cache), so shipping the server's directory layout to every paired
//    handset is a free gift to anyone who ends up holding one.
//  * parse_error is an internal diagnostic written by the scanner. It can
//    quote a filesystem path or a parser internal, it is meant for the
//    admin screen in the browser, and a bundled form is `ready` anyway --
//    so it is never useful here and can only leak.
//
// Deliberately KEPT: content_hash (the record's document identity -- the
// same value createSubmission stamps onto a submission, so a device holding
// it can tell that its cached form is the one a record was signed against),
// plus title/doc_number/revision/file_name/state/file_type, which are what
// the app actually displays. last_scanned_at stays too: it is a plain
// timestamp with nothing sensitive in it, and it is the only signal a device
// has for how fresh the server's own view of the form is.
//
// Applied ONLY to the bundle route, not to GET /forms/:id/fields: that route
// answers a signed-in browser (the same audience as the admin screens, which
// already read parse_error off GET /forms -- see web/js/admin.js), its
// response shape is pinned by existing tests, and narrowing it here would be
// a change to the web client's contract for no gain on the device side.
const BUNDLE_INTERNAL_FORM_COLUMNS = ['file_path', 'parse_error'];

function bundleFormRow(form) {
  const out = { ...form };
  for (const column of BUNDLE_INTERNAL_FORM_COLUMNS) delete out[column];
  return out;
}

// Every distinct formId in one sync batch, mapped to the interval list that
// form's own workbook offers -- parsed ONCE per form for the whole batch,
// however many records name it, and never at all for a batch that names none.
//
// A form whose file cannot be read (moved, corrupted, deleted since the last
// scan) maps to null, meaning "unknown -- do not validate": a device must not
// have a record refused because of a server-side file problem it can neither
// see nor fix, and every other rule about that record (createSubmission's own
// readiness check, saveFields, the signature) still applies untouched.
// A pdf or not-ready form maps to null for the same reason -- createSubmission
// refuses those on its own, with a message about the form rather than a
// confusing one about the interval.
async function frequenciesForBatch(db, records) {
  const byFormId = new Map();
  for (const record of records) {
    const formId = record?.formId;
    if (formId === undefined || formId === null || byFormId.has(formId)) continue;
    const form = db.prepare('select id, file_path, file_type, state from form_catalog where id=?').get(formId);
    if (!form || form.file_type !== 'xlsx' || form.state !== 'ready') {
      byFormId.set(formId, null);
      continue;
    }
    try {
      const { frequencies } = await parseWorkbook(form.file_path);
      byFormId.set(formId, frequencies);
    } catch (err) {
      console.error(`Sync: form ${form.id} could not be read; skipping interval validation for it:`, err);
      byFormId.set(formId, null);
    }
  }
  return byFormId;
}

export { tokenOrSession, actingUser };

export function makeRoutes(db) {
  const r = Router();
  // Per-app-instance counters, so one test's failures never leak into another.
  const loginThrottle = createLoginThrottle();
  const setting = (k) => db.prepare('select value from settings where key=?').get(k)?.value ?? '';

  r.post('/login', (req, res) => {
    // 5 failed attempts per (username, IP) per 15 minutes. `req.ip` rather than
    // the first X-Forwarded-For entry: nginx builds that header with
    // $proxy_add_x_forwarded_for, which APPENDS the real peer to whatever the
    // caller sent, so the first entry is attacker-supplied and a throttle keyed
    // on it can be walked straight through. `trust proxy` is set in index.js and
    // the app port is published on loopback only, so nginx is the sole path in.
    const username = req.body?.username ?? '';
    loginThrottle.sweep();
    const throttleKey = loginThrottle.key(username, req.ip);
    if (loginThrottle.blocked(throttleKey)) {
      return res.status(429).json({ error: 'Too many failed attempts. Please try again in 15 minutes.' });
    }
    const user = authenticate(db, username, req.body?.password ?? '');
    if (!user) {
      loginThrottle.fail(throttleKey);
      return res.status(401).json({ error: 'Username or password is incorrect.' });
    }
    loginThrottle.clear(throttleKey);
    req.session.user = user;
    // The Android app has no browser cookie jar to hold a session, so it
    // opts in to a long-lived bearer token on the same login call instead of
    // a second round trip. The web client never sends this flag, so its
    // response shape is unchanged.
    if (req.body?.wantDeviceToken === true) {
      const { token, expires_at } = issueDeviceToken(db, user.id);
      return res.json({ ...user, device_token: token, device_token_expires_at: expires_at });
    }
    res.json(user);
  });
  // Signs out both credentials this app can be holding at once, each only if
  // it is actually present:
  //  * the browser-style session, destroyed exactly as before;
  //  * the device token, IF the request presents one -- "sign out" on a
  //    phone must actually surrender the long-lived credential, not just the
  //    session cookie it barely uses. Without this a signed-out handset kept
  //    a working bearer token for up to 30 more days, and the only ways to
  //    kill it were an admin deactivating the whole account or waiting out
  //    the expiry.
  // A session-only logout (every browser call) is unchanged: no
  // Authorization header, nothing revoked. Only the row for the presented
  // token is deleted, so this user's OTHER paired devices keep working (see
  // revokeDeviceToken's own comment).
  r.post('/logout', (req, res) => {
    const [scheme, token] = String(req.get('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) revokeDeviceToken(db, token);
    req.session.destroy(() => res.json({ ok: true }));
  });
  r.get('/me', (req, res) => res.json(req.session?.user ?? null));

  r.get('/forms', signedIn, (req, res) =>
    res.json(listForms(db, { includeAll: req.session.user.role === 'admin' })));

  r.get('/forms/:id/grid', signedIn, asyncRoute(async (req, res) => {
    const form = db.prepare('select * from form_catalog where id=?').get(req.params.id);
    if (!form || form.file_type !== 'xlsx') return res.status(404).json({ error: 'No grid for this form.' });
    let grid;
    try {
      const def = await parseWorkbook(form.file_path);
      grid = await buildGrid(form.file_path, def);
    } catch (err) {
      return unreadableForm(res, form.id, err);
    }
    res.json(grid);
  }));

  r.get('/forms/:id/file', signedIn, (req, res) => {
    const form = db.prepare('select * from form_catalog where id=?').get(req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    let data;
    try {
      data = readFileSync(form.file_path);
    } catch (err) {
      return unreadableForm(res, form.id, err);
    }
    res.type(form.file_type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(data);
  });

  r.get('/forms/:id/fields', signedIn, asyncRoute(async (req, res) => {
    const form = db.prepare('select * from form_catalog where id=?').get(req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    let spec;
    try {
      spec = await formSpec(db, form);
    } catch (err) {
      return unreadableForm(res, form.id, err);
    }
    // `def` is formSpec's internal handoff to the bundle route (see the
    // comment on formSpec) — never part of this route's own response shape,
    // which existing tests pin exactly as it was before that handoff existed.
    const { def: _def, ...rest } = spec;
    const { tasks } = rest;
    const selected = String(req.query.frequency ?? '');
    const response = {
      ...rest,
      inScope: (selected ? tasksInScope(tasks, selected) : tasks).map((t) => t.row),
      summary: selected ? scopeSummary(tasks, selected) : null
    };

    // Advisory-only completeness check: the cumulative interval rule (Y also
    // pulls in 3M/6M tasks) is a warning, never a block — signAndAdvance is
    // untouched and still succeeds with in-scope tasks left blank. This just
    // tells the UI what's still outstanding when a submissionId is supplied.
    // The rule itself lives in workflow.js so it's testable without HTTP.
    const submissionId = req.query.submissionId ? Number(req.query.submissionId) : null;
    if (submissionId) {
      response.completeness = completenessFor(db, submissionId, tasks, selected);
    }

    res.json(response);
  }));

  // Every ready xlsx form's full definition in one payload, for the Android
  // app's offline cache — one request at sync time instead of a fields call
  // per form. Per-form: exactly what /forms/:id/fields returns (minus the
  // request-scoped inScope/summary/completeness, which only mean something
  // against a frequency or submission the app does not have yet) plus the
  // grid /forms/:id/grid returns, so the device can render the sheet without
  // a second round trip. tokenOrSession, not signedIn: this is the one route
  // the paired device calls with its own bearer token instead of a browser
  // session.
  //
  // A form whose file cannot be read (moved, corrupted, deleted since the
  // last scan) must never fail the WHOLE bundle for every other form and
  // every other device — it is set aside in `skipped` instead, exactly the
  // per-form failure the single-form routes turn into a 500 for.
  r.get('/bundle', tokenOrSession(db), asyncRoute(async (_req, res) => {
    const readyForms = db.prepare("select * from form_catalog where state='ready' and file_type='xlsx'").all();
    const forms = [];
    const skipped = [];
    for (const form of readyForms) {
      try {
        const spec = await formSpec(db, form);
        // spec.def is the SAME parseWorkbook() result formSpec already
        // computed above -- reused here rather than parsed a second time,
        // so this form's file is read once, not twice, on its way into the
        // bundle. (buildGrid does its own separate, structurally distinct
        // read of the same path for its own ExcelJS.Workbook -- see the
        // comment on formSpec -- which is pre-existing behaviour shared
        // with GET /forms/:id/grid and unaffected by this.)
        const { def, ...rest } = spec;
        const grid = await buildGrid(form.file_path, def);
        // bundleFormRow, not `rest.form` verbatim: the catalog row carries
        // server-internal columns (chiefly the document's absolute path on
        // the server) that have no business being cached on a phone -- see
        // BUNDLE_INTERNAL_FORM_COLUMNS.
        forms.push({ ...rest, form: bundleFormRow(rest.form), grid });
      } catch (err) {
        console.error(`Bundle: form ${form.id} could not be read; skipping:`, err);
        skipped.push({ id: form.id, error: UNREADABLE_FORM_MESSAGE });
      }
    }
    res.json({ generated_at: new Date().toISOString(), forms, skipped });
  }));

  // Replays a device's offline queue: one or more records the Android app
  // recorded while disconnected, each carrying its own client-minted
  // client_uuid. deviceTokenOnly, not tokenOrSession: this route exists
  // exclusively for a paired device's own bearer token (see the guard's own
  // comment above) -- a browser session, however valid, gets 401 here, and a
  // non-technician device token gets 403, because every record in a batch is
  // necessarily a technician's own draft-and-sign.
  //
  // asyncRoute-wrapped, per the contract at the top of this file: the
  // per-record work in syncOneRecord is still entirely synchronous
  // better-sqlite3, but the batch now awaits frequenciesForBatch first (one
  // workbook parse per distinct form, to learn which intervals each form
  // actually offers). Without the wrapper a form file that has moved since
  // the last scan would reject inside an async handler and take the whole
  // process down.
  r.post('/sync', deviceTokenOnly(db), asyncRoute(async (req, res) => {
    const user = req.deviceUser;
    if (user.role !== 'technician') {
      return res.status(403).json({ error: 'Your role cannot sync records.' });
    }
    // A missing or malformed `records` is the WHOLE request being malformed,
    // not a per-record problem -- answering 200 with an empty result set
    // would read to a buggy client as "nothing to sync, safe to flush the
    // offline queue," which is exactly backwards.
    if (!Array.isArray(req.body?.records)) {
      return res.status(400).json({ error: 'records must be an array.' });
    }
    // One parse per distinct form for the WHOLE batch (see
    // frequenciesForBatch), computed before the loop so the loop itself
    // stays synchronous and a twenty-record batch against one form reads
    // that form's file once, not twenty times.
    const frequencies = await frequenciesForBatch(db, req.body.records);
    // Every record is independent from here on: syncOneRecord catches its
    // own failures, so one bad record in a batch of twenty can never abort
    // the other nineteen, and the batch itself always answers 200 -- per-
    // record success or failure is carried in each result's own `error`,
    // never in the HTTP status of the call as a whole.
    res.json({ results: req.body.records.map((record) => syncOneRecord(db, user, record, frequencies)) });
  }));

  r.post('/submissions', requireRole('technician'), (req, res) => {
    const { formId, machineId, frequency } = req.body ?? {};
    // createSubmission (server/workflow.js) throws an INVALID-coded error for
    // a formId that is missing or not a ready, mapped xlsx -- without this
    // try/catch that escaped straight to the generic error middleware as an
    // opaque 500, exactly the failure POST /api/sync's own try/catch around
    // the same call already guards against. statusFor's INVALID branch maps
    // it to 400, matching every other route (PATCH /submissions/:id,
    // /sign, /reject) that surfaces a workflow.js error this way.
    try {
      res.json(createSubmission(db, { formId, userId: req.session.user.id, machineId, frequency }));
    } catch (err) { res.status(statusFor(err, 400)).json({ error: err.message }); }
  });

  r.get('/submissions', signedIn, (req, res) => res.json(queueFor(db, req.session.user)));

  r.get('/submissions/:id', signedIn, (req, res) => {
    const sub = db.prepare('select * from submissions where id=?').get(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Record not found.' });
    res.json({
      submission: sub,
      snapshot: JSON.parse(sub.form_snapshot),
      values: db.prepare('select field_key, value from submission_fields where submission_id=?').all(sub.id),
      signatures: visibleSignatures(db.prepare(SIGNATURES_SQL).all(sub.id), req.session.user),
      rejections: db.prepare(REJECTIONS_SQL).all(sub.id)
    });
  });

  // Accepts the record's field values AND its maintenance interval, because
  // the interval is part of the record (see setFrequency in workflow.js), not
  // a client-side view setting. Permission is unchanged: assertCanEdit still
  // gates everything, and setFrequency additionally refuses once the record
  // has left the technician's draft stage.
  //
  // Awaits parseWorkbook (to learn which intervals this form actually
  // offers), so it MUST be asyncRoute-wrapped — see the contract at the top
  // of this file.
  r.patch('/submissions/:id', signedIn, asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const user = req.session.user;
    const body = req.body ?? {};

    // Permission first, always — nothing below may reveal or change anything
    // about a record the caller does not currently own.
    try { assertCanEdit(db, id, user); }
    catch (err) { return res.status(statusFor(err, 403)).json({ error: err.message }); }

    // A record may only be scoped to an interval the controlled document
    // itself defines, so the offered intervals come from the form, not from a
    // hardcoded list.
    if (body.frequency !== undefined) {
      const { form_id: formId } = db.prepare('select form_id from submissions where id=?').get(id);
      const form = db.prepare('select * from form_catalog where id=?').get(formId);
      let frequencies = [];
      if (form?.file_type === 'xlsx') {
        try { ({ frequencies } = await parseWorkbook(form.file_path)); }
        catch (err) { return unreadableForm(res, formId, err); }
      }
      // The rule itself lives in workflow.js (assertFrequencyOffered), shared
      // with POST /api/sync so a browser and a phone are told the same thing
      // about the same interval. Its INVALID code maps to the same 400 this
      // route always answered here.
      try { assertFrequencyOffered(frequencies, body.frequency); }
      catch (err) { return res.status(statusFor(err, 400)).json({ error: err.message }); }
    }

    try {
      saveFields(db, id, body.values ?? {}, user);
      if (body.frequency !== undefined) setFrequency(db, id, String(body.frequency), user);
      res.json({ ok: true });
    } catch (err) { res.status(statusFor(err, 403)).json({ error: err.message }); }
  }));

  r.post('/submissions/:id/sign', signedIn, (req, res) => {
    try {
      res.json(signAndAdvance(db, {
        submissionId: Number(req.params.id),
        user: req.session.user,
        signaturePng: req.body?.signaturePng ?? ''
      }));
    } catch (err) { res.status(statusFor(err, 400)).json({ error: err.message }); }
  });

  // Send a record back to the technician. Every rule about who may do this,
  // and when, lives in rejectSubmission (server/workflow.js) — this route
  // only translates its two failure shapes into status codes, exactly as the
  // sign route above does: a FORBIDDEN throw is a 403, and anything else
  // (here, a missing reason) falls back to 400. Deliberately NOT wrapped in
  // asyncRoute: this handler awaits nothing, so like /sign it is fully
  // synchronous and cannot produce an unhandled rejection. The moment
  // anything in here becomes async it MUST gain the wrapper — see the
  // asyncRoute contract at the top of this file. Only `err.message`, which
  // is workflow.js's own operator-facing wording, ever reaches the client.
  r.post('/submissions/:id/reject', signedIn, (req, res) => {
    try {
      res.json(rejectSubmission(db, {
        submissionId: Number(req.params.id),
        user: req.session.user,
        reason: req.body?.reason ?? ''
      }));
    } catch (err) { res.status(statusFor(err, 400)).json({ error: err.message }); }
  });

  // Preview/download the record as an archival PDF. Access is enforced here,
  // server-side, not merely by hiding the button in the UI — and the rule
  // itself lives in workflow.js (assertCanViewPdf), beside every other rule
  // about who may act on a record, so no future route can reach this
  // document by a laxer path. In short: a technician may read their OWN
  // record in any state and no one else's; a team leader or engineer only
  // once their own signature row exists; an admin always.
  // Awaits renderRecordPdf, so — per the asyncRoute contract at the
  // top of this file — it MUST be wrapped, or a form whose file has moved
  // since the last scan (parseWorkbook/buildGrid rejecting) becomes an
  // unhandled rejection that kills the whole process for every signed-in
  // user, not just this request.
  r.get('/submissions/:id/pdf', signedIn, asyncRoute(async (req, res) => {
    const sub = db.prepare('select * from submissions where id=?').get(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Record not found.' });

    const user = req.session.user;
    try { assertCanViewPdf(db, sub, user); }
    catch (err) { return res.status(statusFor(err, 403)).json({ error: err.message }); }

    // A signed record is evidence, and evidence must stay retrievable and
    // unchanged. Its document identity (doc number, revision) comes from the
    // columns stamped on the submission when it was created — never from the
    // catalog row, which tracks a live file that may since have been revised,
    // rescanned or deleted. Older records created before those columns
    // existed have nothing stored, so they fall back to the catalog.
    const form = db.prepare('select * from form_catalog where id=?').get(sub.form_id) ?? null;
    const identity = {
      title: form?.title || form?.file_name || '',
      doc_number: sub.doc_number || form?.doc_number || '',
      revision: sub.revision || form?.revision || ''
    };

    // The grid (the form's own printed instructions) can only come from the
    // live file — it is not snapshotted. When that file cannot be read, the
    // record is still produced from its stored snapshot rather than failing:
    // an approved record must never become unobtainable. When the file IS
    // readable but is no longer the one this record was signed against, the
    // record still renders, and says so on its face.
    let grid = null;
    let cellMap = null;
    let notice = '';
    if (form?.file_type === 'xlsx') {
      try {
        const def = await parseWorkbook(form.file_path);
        grid = await buildGrid(form.file_path, def);
        // The same map the live preview uses to place a value in the box the
        // document prints for it. Passing it here is what makes the archived
        // record show the record ON THE FORM rather than as a list beside it —
        // one mapping, so the preview and the archive cannot disagree about
        // where a technician's entry belongs.
        cellMap = cellMapFor(def);
      } catch (err) {
        console.error(`Record ${sub.id}: form ${form.id} could not be read; rendering from the stored snapshot instead:`, err);
        notice = 'SOURCE FORM COULD NOT BE READ — RENDERED FROM THE STORED RECORD';
      }
    }
    if (!notice && sub.content_hash && form?.content_hash && sub.content_hash !== form.content_hash) {
      console.warn(`Record ${sub.id}: form ${form.id} has changed on disk since this record was signed ` +
        `(recorded ${sub.content_hash.slice(0, 12)}, current ${form.content_hash.slice(0, 12)}).`);
      notice = 'SOURCE FORM HAS BEEN REVISED SINCE THIS RECORD WAS SIGNED';
    }

    const snapshot = JSON.parse(sub.form_snapshot);
    const values = db.prepare('select field_key, value from submission_fields where submission_id=?').all(sub.id);
    const signatures = db.prepare(SIGNATURES_SQL).all(sub.id);
    // A rejection is part of what happened to this record, so the archived
    // document says so. The signatures it invalidated are gone; the fact that
    // it was sent back, by whom and why, is not.
    const rejections = db.prepare(REJECTIONS_SQL).all(sub.id);

    const buffer = await renderRecordPdf({
      form, submission: sub, snapshot, values, signatures, rejections, grid, identity, notice,
      cellFor: cellMap?.cellFor ?? null, titleCell: cellMap?.titleCell ?? null,
      // The printed frequency band, so the archived record carries the same
      // ticked checkboxes the live preview shows.
      intervalCells: cellMap?.intervalCells ?? null,
      calibrationCells: cellMap?.calibrationCells ?? null
    });

    // A machine id typed into a spreadsheet cell is untrusted input reaching
    // an HTTP response header — strip everything but alphanumerics, dash,
    // dot and underscore so it cannot inject header content (e.g. CRLF or a
    // stray quote breaking out of the filename parameter).
    const safeMachineId = String(sub.machine_id ?? '').replace(/[^A-Za-z0-9._-]/g, '');
    const filename = `${safeMachineId || `record-${sub.id}`}.pdf`;
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';

    res.type('application/pdf');
    res.set('Content-Disposition', `${disposition}; filename="${filename}"`);
    res.send(buffer);
  }));

  // ---- admin ----
  const admin = requireRole('admin');
  r.get('/admin/settings', admin, (_req, res) => res.json({ formsFolder: setting('forms_folder') }));

  r.put('/admin/settings', admin, asyncRoute(async (req, res) => {
    const folder = String(req.body?.formsFolder ?? '').trim();
    try {
      const result = await scanFolder(db, folder);
      db.prepare('insert into settings (key,value) values (?,?) on conflict(key) do update set value=excluded.value')
        .run('forms_folder', folder);
      res.json({ formsFolder: folder, ...result });
    } catch (err) {
      res.status(400).json({ error: `Could not read that folder: ${err.message}` });
    }
  }));

  r.post('/admin/rescan', admin, asyncRoute(async (_req, res) => {
    try { res.json(await scanFolder(db, setting('forms_folder'))); }
    catch (err) { res.status(400).json({ error: `Could not read that folder: ${err.message}` }); }
  }));

  r.get('/admin/users', admin, (_req, res) =>
    res.json(db.prepare('select id, username, full_name, role, active from users order by username').all()));

  r.post('/admin/users', admin, (req, res) => {
    try {
      const u = createUser(db, req.body ?? {});
      const { password_hash, ...safe } = u;
      res.json(safe);
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  r.patch('/admin/users/:id', admin, (req, res) => {
    const { fullName, role, active } = req.body ?? {};
    db.prepare('update users set full_name=coalesce(?,full_name), role=coalesce(?,role), active=coalesce(?,active) where id=?')
      .run(fullName ?? null, role ?? null, active ?? null, req.params.id);
    // A deactivated account must not keep working from an already-paired
    // phone just because that token has not hit its 30-day expiry yet.
    if (active === 0 || active === false) revokeUserTokens(db, req.params.id);
    res.json({ ok: true });
  });

  r.put('/admin/forms/:id/fields', admin, (req, res) => {
    const formId = Number(req.params.id);
    const fields = req.body?.fields ?? [];
    const tx = db.transaction(() => {
      // The mapper client sends the WHOLE field list back on every save,
      // including parsed rows it only displayed and never touched. A field
      // must become source='admin' only when an admin actually authored or
      // changed it — otherwise every save silently adopts every parsed
      // field, and scanner.js's (correct, deliberate) admin-skip logic then
      // refuses to ever regenerate them again, freezing the form's task
      // list even after the underlying document is revised and rescanned.
      const existingByKey = new Map(
        db.prepare('select field_key, label, section, kind, source from form_fields where form_id=?')
          .all(formId)
          .map((row) => [row.field_key, row])
      );

      // Only drop admin-owned rows the admin actually removed from this
      // payload. Parsed rows are never deleted here — they are either
      // reinserted (unchanged or overridden) below, or, if genuinely absent
      // from the payload, simply left alone. This is deliberately narrower
      // than "delete admin rows, then re-insert everything as admin": that
      // shape is what let an unedited parsed field get silently reinserted
      // over its own row with a hardcoded source='admin' the first time an
      // admin merely opened and saved a form.
      const incomingKeys = new Set(fields.map((f) => f.field_key));
      const del = db.prepare('delete from form_fields where form_id=? and field_key=? and source=?');
      for (const row of existingByKey.values()) {
        if (row.source === 'admin' && !incomingKeys.has(row.field_key)) del.run(formId, row.field_key, 'admin');
      }

      // Upsert by (form_id, field_key) rather than "insert or replace":
      // that unique index means a plain replace can clobber a row across
      // sources by rowid, which is exactly the data-loss shape the
      // delete-then-insert split was originally introduced to avoid.
      //
      // `options` is deliberately absent from both halves. The mapper does not
      // edit which answers a field accepts, so it does not send them; leaving
      // the column out of the update clause is what PRESERVES the ones the
      // parser set. Adding it here — even as `options=excluded.options` — would
      // blank the Calibration Record's Pass/Fail answers the first time an
      // admin opened a wire-bond form and pressed Save.
      const ins = db.prepare(`insert into form_fields
        (form_id, field_key, label, section, kind, sort_order, source) values (?,?,?,?,?,?,?)
        on conflict(form_id, field_key) do update set
          label=excluded.label, section=excluded.section, kind=excluded.kind,
          sort_order=excluded.sort_order, source=excluded.source`);

      fields.forEach((f, i) => {
        const label = f.label;
        const section = f.section ?? '';
        const kind = f.kind ?? 'text';
        const prior = existingByKey.get(f.field_key);
        let source;
        if (!prior) {
          source = 'admin'; // new field: admin-authored
        } else if (prior.source === 'admin') {
          source = 'admin'; // already admin-owned: stays admin-owned
        } else {
          // prior.source === 'parsed': only an actual content change (not
          // sort_order — reordering must never freeze a field) makes this
          // an admin override.
          const unchanged = prior.label === label && prior.section === section && prior.kind === kind;
          source = unchanged ? 'parsed' : 'admin';
        }
        ins.run(formId, f.field_key, label, section, kind, i, source);
      });

      if (fields.length) db.prepare("update form_catalog set state='ready' where id=?").run(formId);
    });
    tx();
    res.json({ ok: true });
  });

  return r;
}
