import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { authenticate, requireRole, createUser, ROLES } from './auth.js';
import { listForms, scanFolder } from './scanner.js';
import { buildGrid } from './grid-model.js';
import { parseWorkbook } from './excel-parser.js';
import { tasksInScope, scopeSummary } from './intervals.js';
import { createSubmission, saveFields, signAndAdvance, queueFor, assertCanEdit } from './workflow.js';

const signedIn = requireRole(...ROLES);

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

  r.get('/forms/:id/grid', signedIn, async (req, res) => {
    const form = db.prepare('select * from form_catalog where id=?').get(req.params.id);
    if (!form || form.file_type !== 'xlsx') return res.status(404).json({ error: 'No grid for this form.' });
    res.json(await buildGrid(form.file_path));
  });

  r.get('/forms/:id/file', signedIn, (req, res) => {
    const form = db.prepare('select * from form_catalog where id=?').get(req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    res.type(form.file_type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(readFileSync(form.file_path));
  });

  r.get('/forms/:id/fields', signedIn, async (req, res) => {
    const form = db.prepare('select * from form_catalog where id=?').get(req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    const fields = db.prepare('select * from form_fields where form_id=? order by sort_order').all(form.id);
    let tasks = [], frequencies = [];
    if (form.file_type === 'xlsx' && form.state === 'ready') {
      const def = await parseWorkbook(form.file_path);
      tasks = def.tasks; frequencies = def.frequencies;
    }
    const selected = String(req.query.frequency ?? '');
    const inScopeTasks = selected ? tasksInScope(tasks, selected) : tasks;
    const response = {
      form, fields, frequencies, tasks,
      inScope: inScopeTasks.map((t) => t.row),
      summary: selected ? scopeSummary(tasks, selected) : null
    };

    // Advisory-only completeness check: the cumulative interval rule (Y also
    // pulls in 3M/6M tasks) is a warning, never a block — signAndAdvance is
    // untouched and still succeeds with in-scope tasks left blank. This just
    // tells the UI what's still outstanding when a submissionId is supplied.
    const submissionId = req.query.submissionId ? Number(req.query.submissionId) : null;
    if (submissionId) {
      const values = db.prepare('select field_key, value from submission_fields where submission_id=?').all(submissionId);
      const filledKeys = new Set(values.filter((v) => String(v.value ?? '').trim() !== '').map((v) => v.field_key));
      const inScopeKeys = inScopeTasks.map((t) => `task_${t.row}`);
      const missing = inScopeKeys.filter((k) => !filledKeys.has(k));
      response.completeness = { inScope: inScopeKeys.length, filled: inScopeKeys.length - missing.length, missing };
    }

    res.json(response);
  });

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
    } catch (err) { res.status(403).json({ error: err.message }); }
  });

  r.post('/submissions/:id/sign', signedIn, (req, res) => {
    try {
      res.json(signAndAdvance(db, {
        submissionId: Number(req.params.id),
        user: req.session.user,
        signaturePng: req.body?.signaturePng ?? ''
      }));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ---- admin ----
  const admin = requireRole('admin');
  r.get('/admin/settings', admin, (_req, res) => res.json({ formsFolder: setting('forms_folder') }));

  r.put('/admin/settings', admin, async (req, res) => {
    const folder = String(req.body?.formsFolder ?? '').trim();
    try {
      const result = await scanFolder(db, folder);
      db.prepare('insert into settings (key,value) values (?,?) on conflict(key) do update set value=excluded.value')
        .run('forms_folder', folder);
      res.json({ formsFolder: folder, ...result });
    } catch (err) {
      res.status(400).json({ error: `Could not read that folder: ${err.message}` });
    }
  });

  r.post('/admin/rescan', admin, async (_req, res) => {
    try { res.json(await scanFolder(db, setting('forms_folder'))); }
    catch (err) { res.status(400).json({ error: `Could not read that folder: ${err.message}` }); }
  });

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
      db.prepare('delete from form_fields where form_id=? and source=?').run(formId, 'admin');
      const ins = db.prepare(`insert or replace into form_fields
        (form_id, field_key, label, section, kind, sort_order, source) values (?,?,?,?,?,?,'admin')`);
      fields.forEach((f, i) => ins.run(formId, f.field_key, f.label, f.section ?? '', f.kind ?? 'text', i));
      if (fields.length) db.prepare("update form_catalog set state='ready' where id=?").run(formId);
    });
    tx();
    res.json({ ok: true });
  });

  return r;
}
