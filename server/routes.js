import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { authenticate, requireRole, createUser, ROLES } from './auth.js';
import { listForms, scanFolder } from './scanner.js';
import { buildGrid } from './grid-model.js';
import { parseWorkbook } from './excel-parser.js';
import { tasksInScope, scopeSummary } from './intervals.js';
import { createSubmission, saveFields, signAndAdvance, queueFor, assertCanEdit, completenessFor } from './workflow.js';
import { renderRecordPdf } from './pdf-record.js';

const signedIn = requireRole(...ROLES);

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
const statusFor = (err, fallback) =>
  err.code === 'FORBIDDEN' ? 403 : err.code === 'NOT_FOUND' ? 404 : fallback;

export function makeRoutes(db) {
  const r = Router();
  const setting = (k) => db.prepare('select value from settings where key=?').get(k)?.value ?? '';

  r.post('/login', (req, res) => {
    const user = authenticate(db, req.body?.username ?? '', req.body?.password ?? '');
    if (!user) return res.status(401).json({ error: 'Username or password is incorrect.' });
    req.session.user = user;
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
    if (form.file_type === 'xlsx' && form.state === 'ready') {
      let def;
      try {
        def = await parseWorkbook(form.file_path);
      } catch (err) {
        return unreadableForm(res, form.id, err);
      }
      tasks = def.tasks; frequencies = def.frequencies;
    }
    const selected = String(req.query.frequency ?? '');
    const response = {
      form, fields, frequencies, tasks,
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
      signatures: db.prepare('select stage, full_name, image_png, signed_at from signatures where submission_id=?').all(sub.id)
    });
  });

  r.patch('/submissions/:id', signedIn, (req, res) => {
    try {
      assertCanEdit(db, Number(req.params.id), req.session.user);
      saveFields(db, Number(req.params.id), req.body?.values ?? {}, req.session.user);
      res.json({ ok: true });
    } catch (err) { res.status(statusFor(err, 403)).json({ error: err.message }); }
  });

  r.post('/submissions/:id/sign', signedIn, (req, res) => {
    try {
      res.json(signAndAdvance(db, {
        submissionId: Number(req.params.id),
        user: req.session.user,
        signaturePng: req.body?.signaturePng ?? ''
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

    const form = db.prepare('select * from form_catalog where id=?').get(sub.form_id);
    if (!form) return res.status(404).json({ error: 'Record not found.' });

    let grid = null;
    if (form.file_type === 'xlsx') {
      try {
        const def = await parseWorkbook(form.file_path);
        grid = await buildGrid(form.file_path, def);
      } catch (err) {
        return unreadableForm(res, form.id, err);
      }
    }

    const snapshot = JSON.parse(sub.form_snapshot);
    const values = db.prepare('select field_key, value from submission_fields where submission_id=?').all(sub.id);
    const signatures = db.prepare('select stage, full_name, image_png, signed_at from signatures where submission_id=?').all(sub.id);

    const buffer = await renderRecordPdf({ form, submission: sub, snapshot, values, signatures, grid });

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
