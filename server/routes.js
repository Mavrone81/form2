import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { authenticate, requireRole, createUser, ROLES } from './auth.js';
import { issueDeviceToken, revokeUserTokens, validateDeviceToken } from './device-tokens.js';
import { listForms, scanFolder } from './scanner.js';
import { buildGrid } from './grid-model.js';
import { parseWorkbook } from './excel-parser.js';
import { tasksInScope, scopeSummary } from './intervals.js';
import { cellMapFor } from './cell-map.js';
import { createSubmission, saveFields, signAndAdvance, rejectSubmission, queueFor, assertCanEdit, completenessFor, setFrequency, STAGES } from './workflow.js';
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
// contain absolute filesystem paths) reach the client.
function unreadableForm(res, formId, err) {
  console.error(`Could not read form ${formId} from disk:`, err);
  res.status(500).json({ error: 'This form could not be read. Ask an admin to rescan.' });
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
  r.post('/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
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
    const fields = db.prepare('select * from form_fields where form_id=? order by sort_order').all(form.id);
    let tasks = [], frequencies = [];
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
      let def;
      try {
        def = await parseWorkbook(form.file_path);
      } catch (err) {
        return unreadableForm(res, form.id, err);
      }
      tasks = def.tasks; frequencies = def.frequencies;
      ({ cellFor, titleCell, intervalCells, calibrationCells } = cellMapFor(def));
    }
    const selected = String(req.query.frequency ?? '');
    const response = {
      form, fields, frequencies, tasks, cellFor, titleCell, intervalCells, calibrationCells,
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

  r.post('/submissions', requireRole('technician'), (req, res) => {
    const { formId, machineId, frequency } = req.body ?? {};
    res.json(createSubmission(db, { formId, userId: req.session.user.id, machineId, frequency }));
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
      if (!frequencies.includes(String(body.frequency))) {
        return res.status(400).json({ error: 'That maintenance interval is not one this form offers.' });
      }
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
  // server-side, not merely by hiding the button in the UI: a technician is
  // refused in every state (they are never a party to the reviewed record's
  // PDF); a team leader or engineer may only see it once THEIR OWN signature
  // row exists (proof they have signed this record); an admin may always
  // preview. Awaits renderRecordPdf, so — per the asyncRoute contract at the
  // top of this file — it MUST be wrapped, or a form whose file has moved
  // since the last scan (parseWorkbook/buildGrid rejecting) becomes an
  // unhandled rejection that kills the whole process for every signed-in
  // user, not just this request.
  r.get('/submissions/:id/pdf', signedIn, asyncRoute(async (req, res) => {
    const sub = db.prepare('select * from submissions where id=?').get(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Record not found.' });

    const user = req.session.user;
    const signedStages = db.prepare('select stage from signatures where submission_id=?')
      .all(sub.id).map((s) => s.stage);
    const allowed = user.role === 'admin'
      || ((user.role === 'team_leader' || user.role === 'engineer') && signedStages.includes(user.role));
    if (!allowed) return res.status(403).json({ error: 'Available once you have signed this record.' });

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
