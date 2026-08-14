import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { seedDemoUsers } from '../server/seed.js';
import { scanFolder } from '../server/scanner.js';
import { tokenOrSession, actingUser } from '../server/routes.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

// Builds a minimal synthetic workbook the parser accepts, with tasks at
// several distinct frequencies so the cumulative interval rule has
// something to bring into scope. Content is invented/generic — never real
// form text.
async function writeSyntheticWorkbook(path, tasksByFreq) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getRow(1).getCell(1).value = 'No';
  ws.getRow(1).getCell(2).value = 'Freq.';
  ws.getRow(1).getCell(3).value = 'Instruction';
  ws.getRow(1).getCell(4).value = 'Status';
  tasksByFreq.forEach(([freq, instruction], i) => {
    const row = ws.getRow(i + 2);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = freq;
    row.getCell(3).value = instruction;
  });
  await wb.xlsx.writeFile(path);
  return path;
}

async function boot() {
  const db = openDb(':memory:');
  seedDemoUsers(db, { silent: true });
  const app = createApp({ db });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  let setCookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) { setCookie = set; cookie = set.split(';')[0]; }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { db, server, call, app, lastSetCookie: () => setCookie };
}

test('login locks after 5 failures for that username, and only that username', async () => {
  const { server, call } = await boot();
  // Five wrong passwords for one user -> the sixth attempt is refused outright.
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'no' + i })).status, 401);
  }
  assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'no5' })).status, 429,
    'sixth failed attempt must be rate limited');
  // Even the CORRECT password is refused while locked.
  assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'tech' })).status, 429,
    'correct password is still refused while locked');
  // A different account from the same place is unaffected: otherwise five wrong
  // guesses at a known username lock out everyone else in the building.
  assert.equal((await call('POST', '/api/login', { username: 'lead', password: 'lead' })).status, 200,
    'a different username must not be collaterally locked');
  server.close();
});

test('a successful login clears the failure count', async () => {
  const { server, call } = await boot();
  for (let i = 0; i < 4; i++) {
    assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'no' + i })).status, 401);
  }
  assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'tech' })).status, 200);
  // Four more failures must not trip the limit, because the counter was reset.
  for (let i = 0; i < 4; i++) {
    assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'x' + i })).status, 401,
      'counter was not cleared by the successful login');
  }
  server.close();
});

test('unauthenticated requests are refused', async () => {
  const { server, call } = await boot();
  assert.equal((await call('GET', '/api/forms')).status, 401);
  server.close();
});

test('a technician can sign in and is told who they are', async () => {
  const { server, call } = await boot();
  assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'tech' })).status, 200);
  const me = await call('GET', '/api/me');
  assert.equal(me.body.role, 'technician');
  server.close();
});

test('a technician cannot reach admin settings', async () => {
  const { server, call } = await boot();
  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  assert.equal((await call('GET', '/api/admin/settings')).status, 403);
  server.close();
});

test('tokenOrSession accepts an existing browser session with no Bearer token', async () => {
  // No production route uses tokenOrSession yet (that lands with the form
  // bundle route in a later task), so this attaches a private test-only
  // route to the same app/session instance /api/login already uses here —
  // proving the session branch of the middleware, alongside the token
  // branch covered end-to-end in test/device-tokens.test.js.
  const { db, server, call, app } = await boot();
  app.get('/__test/whoami', tokenOrSession(db), (req, res) => {
    res.json({ authVia: req.authVia, user: actingUser(req) });
  });
  try {
    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    const res = await call('GET', '/__test/whoami');
    assert.equal(res.status, 200);
    assert.equal(res.body.authVia, 'session');
    assert.equal(res.body.user.role, 'technician');
  } finally {
    server.close();
  }
});

test('a bad password is refused', async () => {
  const { server, call } = await boot();
  assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'no' })).status, 401);
  server.close();
});

// --- Additional tests beyond the brief ---

test('signed-out requests to the grid and file endpoints are refused', async () => {
  const { server, call } = await boot();
  assert.equal((await call('GET', '/api/forms/1/grid')).status, 401);
  assert.equal((await call('GET', '/api/forms/1/file')).status, 401);
  server.close();
});

test('PATCH /api/submissions/:id returns 403 when the caller is not the current stage owner', async () => {
  const { db, server, call } = await boot();
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();

  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  const sub = (await call('POST', '/api/submissions', { formId: 1, machineId: 'ED04', frequency: 'Y' })).body;
  assert.equal(sub.state, 'draft');

  // The draft belongs to the technician's stage — a team leader may not
  // touch it yet. This proves assertCanEdit is actually wired into the
  // route, not merely present in workflow.js.
  await call('POST', '/api/login', { username: 'lead', password: 'lead' });
  const patch = await call('PATCH', `/api/submissions/${sub.id}`, { values: { remarks: 'sneaky edit' } });
  assert.equal(patch.status, 403);
  server.close();
});

test('POST /api/submissions for a needs_setup form is a 400 with an actionable message, not an opaque 500', async () => {
  const { db, server, call } = await boot();
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/needs-setup.xlsx','needs-setup.xlsx','xlsx','needs_setup')`).run();
  const { id: formId } = db.prepare("select id from form_catalog where file_name='needs-setup.xlsx'").get();

  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  // createSubmission (server/workflow.js) throws an INVALID-coded error for
  // a form that is not a ready, mapped xlsx -- this route must catch it and
  // map it to 400 (statusFor), exactly like PATCH /submissions/:id, /sign
  // and /reject already do for their own workflow.js errors, rather than
  // letting it fall through to the generic error middleware's opaque 500.
  const res = await call('POST', '/api/submissions', { formId, machineId: 'ED04', frequency: 'Y' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not ready/i);

  // And a normal create against a ready, mapped form is unaffected by this
  // route now having a try/catch around it.
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();
  const { id: readyFormId } = db.prepare("select id from form_catalog where file_name='f.xlsx'").get();
  const ok = await call('POST', '/api/submissions', { formId: readyFormId, machineId: 'ED04', frequency: 'Y' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, 'draft');
  server.close();
});

test('admin user-list responses never include password_hash', async () => {
  const { server, call } = await boot();
  await call('POST', '/api/login', { username: 'admin', password: 'admin' });
  const res = await call('GET', '/api/admin/users');
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0);
  for (const u of res.body) assert.equal('password_hash' in u, false, 'response must not leak password_hash');
  server.close();
});

test('completeness warns about unfilled in-scope tasks but never blocks signing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-api-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form.xlsx'), [
      ['1M', 'Widget check A'],
      ['3M', 'Widget check B'],
      ['6M', 'Widget check C'],
      ['Y', 'Widget check D']
    ]);
    const { db, server, call } = await boot();
    await scanFolder(db, dir);
    const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
    assert.equal(form.state, 'ready');

    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    const sub = (await call('POST', '/api/submissions', { formId: form.id, machineId: 'ED04', frequency: 'Y' })).body;

    // Rows: header is row 1, so tasks land on rows 2-5 in the order above.
    // Selecting 'Y' brings every shorter interval into scope too (the
    // cumulative rule), so all four tasks are in scope. Fill only two.
    const patch = await call('PATCH', `/api/submissions/${sub.id}`, {
      values: { task_3: 'Done', task_5: 'Done' }
    });
    assert.equal(patch.status, 200);

    const fields = await call('GET', `/api/forms/${form.id}/fields?frequency=Y&submissionId=${sub.id}`);
    assert.equal(fields.status, 200);
    assert.deepEqual(fields.body.completeness, {
      inScope: 4,
      filled: 2,
      missing: ['task_2', 'task_4']
    });

    // The cumulative-interval warning is advisory only: signing must still
    // succeed with in-scope tasks left blank.
    const signed = await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    assert.equal(signed.status, 200);
    assert.equal(signed.body.state, 'pending_lead');

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fix round 1 ---

test('a form whose file has gone missing since the last scan returns a clean 500, not a crash, from grid/fields/file', async () => {
  const { db, server, call } = await boot();
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/nonexistent/gone.xlsx','gone.xlsx','xlsx','ready')`).run();
  const { id } = db.prepare("select id from form_catalog where file_name='gone.xlsx'").get();

  await call('POST', '/api/login', { username: 'tech', password: 'tech' });

  const grid = await call('GET', `/api/forms/${id}/grid`);
  assert.equal(grid.status, 500);
  assert.equal(grid.body.error, 'This form could not be read. Ask an admin to rescan.');

  const fields = await call('GET', `/api/forms/${id}/fields`);
  assert.equal(fields.status, 500);
  assert.equal(fields.body.error, 'This form could not be read. Ask an admin to rescan.');

  const file = await call('GET', `/api/forms/${id}/file`);
  assert.equal(file.status, 500);
  assert.equal(file.body.error, 'This form could not be read. Ask an admin to rescan.');

  // The whole point: the process must have survived all three failures.
  // Prove it by making one more ordinary request on the same server.
  const me = await call('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'technician');

  server.close();
});

test('a failed form-file request never leaks a stack trace or an absolute filesystem path', async () => {
  const { db, server, call } = await boot();
  const path = '/nonexistent/very/specific/gone.xlsx';
  db.prepare('insert into form_catalog (file_path,file_name,file_type,state) values (?,?,?,?)')
    .run(path, 'gone.xlsx', 'xlsx', 'ready');
  const { id } = db.prepare("select id from form_catalog where file_name='gone.xlsx'").get();

  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  const res = await call('GET', `/api/forms/${id}/file`);
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes(path), 'response must not contain the absolute file path');
  assert.ok(!/\bat\s+\S+\s*\(/.test(raw), 'response must not contain stack-trace frames');
  server.close();
});

// --- Final review fixes ---

// Finding 1: the interval the technician actually worked to must be the one
// stored on the record — every downstream reader (the reviewer's scope, the
// completeness warning, the archived PDF header) reads it from there.
test('the maintenance interval is persisted by PATCH, validated against the form, and frozen once the record leaves the technician', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-freq-'));
  let close;
  try {
    await writeSyntheticWorkbook(join(dir, 'form.xlsx'), [
      ['3M', 'Widget check A'],
      ['Y', 'Widget check B']
    ]);
    const { db, server, call } = await boot();
    close = () => server.close();
    await scanFolder(db, dir);
    const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();

    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    // The UI opens a new record on the broadest interval the form offers.
    const sub = (await call('POST', '/api/submissions', { formId: form.id, machineId: '', frequency: 'Y' })).body;
    const storedFrequency = () => db.prepare('select frequency from submissions where id=?').get(sub.id).frequency;
    assert.equal(storedFrequency(), 'Y');

    // The technician taps 3M: that choice must reach the database.
    const patch = await call('PATCH', `/api/submissions/${sub.id}`, { frequency: '3M' });
    assert.equal(patch.status, 200);
    assert.equal(storedFrequency(), '3M');
    assert.equal((await call('GET', `/api/submissions/${sub.id}`)).body.submission.frequency, '3M');

    // An interval this form does not offer is refused outright — the stored
    // value is never replaced by something the form cannot be worked to.
    const bogus = await call('PATCH', `/api/submissions/${sub.id}`, { frequency: '6M' });
    assert.equal(bogus.status, 400);
    assert.equal(storedFrequency(), '3M');

    // Once signed off, the scope the technician worked to is part of the
    // record's history — the team leader now owning the stage may not rewrite it.
    assert.equal((await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG })).status, 200);
    await call('POST', '/api/login', { username: 'lead', password: 'lead' });
    const late = await call('PATCH', `/api/submissions/${sub.id}`, { frequency: 'Y' });
    assert.equal(late.status, 403);
    assert.equal(storedFrequency(), '3M');
  } finally {
    close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 4: the technician types the machine id into the machine_id FIELD —
// which used to land only in submission_fields, leaving submissions.machine_id
// empty and every queue row, PDF header and archive filename anonymous.
test('saving the machine_id field also stamps it on the record itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-machine-'));
  let close;
  try {
    await writeSyntheticWorkbook(join(dir, 'form.xlsx'), [['Y', 'Widget check A']]);
    const { db, server, call } = await boot();
    close = () => server.close();
    await scanFolder(db, dir);
    const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();

    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    const sub = (await call('POST', '/api/submissions', { formId: form.id, machineId: '', frequency: 'Y' })).body;
    assert.equal(sub.machine_id, '');

    const patch = await call('PATCH', `/api/submissions/${sub.id}`, { values: { machine_id: 'ED04' } });
    assert.equal(patch.status, 200);
    assert.equal(db.prepare('select machine_id from submissions where id=?').get(sub.id).machine_id, 'ED04');
    assert.equal((await call('GET', `/api/submissions/${sub.id}`)).body.submission.machine_id, 'ED04');
  } finally {
    close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 8: signature ink is replayable evidence. Attribution stays legible
// to everyone; the image itself is returned only to the stage that drew it,
// and to an admin.
test('signature ink is returned only for a stage the caller is entitled to see', async () => {
  const { db, server, call } = await boot();
  try {
    db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
      values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();

    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    const sub = (await call('POST', '/api/submissions', { formId: 1, machineId: 'ED04', frequency: 'Y' })).body;
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    await call('POST', '/api/login', { username: 'lead', password: 'lead' });
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });

    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    const asTech = (await call('GET', `/api/submissions/${sub.id}`)).body.signatures;
    const techOwn = asTech.find((s) => s.stage === 'technician');
    const techOther = asTech.find((s) => s.stage === 'team_leader');
    assert.equal(techOwn.image_png, PNG, 'a signer always gets their own ink back');
    assert.equal('image_png' in techOther, false, 'another stage\'s ink must not be returned');
    // Attribution stays visible even when the ink is withheld.
    assert.ok(techOther.full_name);
    assert.ok(techOther.signed_at);

    await call('POST', '/api/login', { username: 'eng', password: 'eng' });
    const asEngineer = (await call('GET', `/api/submissions/${sub.id}`)).body.signatures;
    for (const s of asEngineer) assert.equal('image_png' in s, false, 'an engineer who has not signed sees no ink at all');

    await call('POST', '/api/login', { username: 'admin', password: 'admin' });
    const asAdmin = (await call('GET', `/api/submissions/${sub.id}`)).body.signatures;
    assert.equal(asAdmin.length, 2);
    for (const s of asAdmin) assert.equal(s.image_png, PNG, 'an admin sees every stage\'s ink');
  } finally { server.close(); }
});

// Finding 5, at the JSON seam that feeds the PDF: drawSignatures lays block i
// at column i, so this order IS the printed order.
test('signatures are returned in workflow stage order, not index order', async () => {
  const { db, server, call } = await boot();
  try {
    db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
      values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();

    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    const sub = (await call('POST', '/api/submissions', { formId: 1, machineId: 'ED04', frequency: 'Y' })).body;
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    await call('POST', '/api/login', { username: 'lead', password: 'lead' });
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    await call('POST', '/api/login', { username: 'eng', password: 'eng' });
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });

    await call('POST', '/api/login', { username: 'admin', password: 'admin' });
    const stages = (await call('GET', `/api/submissions/${sub.id}`)).body.signatures.map((s) => s.stage);
    assert.deepEqual(stages, ['technician', 'team_leader', 'engineer']);
  } finally { server.close(); }
});

// Finding 2: a shop-floor tablet must not stay signed in as the first user
// forever — the session cookie expires, and signing out really ends it.
test('the session cookie expires and POST /api/logout ends the session', async () => {
  const { server, call, lastSetCookie } = await boot();
  try {
    const login = await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    assert.equal(login.status, 200);

    // express-session serialises a maxAge as an absolute Expires date, so the
    // lifetime is asserted rather than the spelling of the attribute.
    const setCookie = lastSetCookie() ?? '';
    const expires = /expires=([^;]+)/i.exec(setCookie);
    assert.ok(expires, `the session cookie must expire, got "${setCookie}"`);
    const lifetimeMs = new Date(expires[1]).getTime() - Date.now();
    assert.ok(lifetimeMs > 0, 'the session cookie must have a future expiry');
    assert.ok(lifetimeMs <= 24 * 60 * 60 * 1000, 'a session must not outlive a working day');

    assert.equal((await call('POST', '/api/logout')).status, 200);
    assert.equal((await call('GET', '/api/forms')).status, 401, 'the session must be gone after signing out');
  } finally { server.close(); }
});

// Finding 6: behind the documented nginx/TLS deployment the cookie must be
// marked Secure — and must NOT be locally, where plain HTTP would drop it.
test('the session cookie is marked Secure only where the connection is TLS-terminated', async () => {
  const db = openDb(':memory:');
  seedDemoUsers(db, { silent: true });
  const app = createApp({ db, secureCookies: true });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(app.get('trust proxy'), 1, 'X-Forwarded-Proto is only believable with trust proxy set');
    const behindTls = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ username: 'tech', password: 'tech' })
    });
    assert.match(behindTls.headers.get('set-cookie') ?? '', /;\s*Secure/i);
  } finally { server.close(); }

  // The in-process tests (and local development) speak plain HTTP: a Secure
  // cookie would never be stored there, so it must stay off.
  const plainDb = openDb(':memory:');
  seedDemoUsers(plainDb, { silent: true });
  const plain = createApp({ db: plainDb });
  const plainServer = plain.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${plainServer.address().port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tech', password: 'tech' })
    });
    assert.doesNotMatch(res.headers.get('set-cookie') ?? '', /;\s*Secure/i);
  } finally { plainServer.close(); }
});

test('signing with the wrong role returns 403, matching PATCH\'s status for the same kind of failure', async () => {
  const { db, server, call } = await boot();
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();

  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  const sub = (await call('POST', '/api/submissions', { formId: 1, machineId: 'ED04', frequency: 'Y' })).body;

  // The record is in draft — only the technician who created it may sign it
  // right now. An engineer signing is a permission failure, exactly like the
  // PATCH 403 case above, and must return the same status code, not 400.
  await call('POST', '/api/login', { username: 'eng', password: 'eng' });
  const wrongRole = await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
  assert.equal(wrongRole.status, 403);

  // A genuine input problem (no signature) is not a permission failure and
  // must still be a 400.
  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  const noSignature = await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: '' });
  assert.equal(noSignature.status, 400);

  server.close();
});

// --- Reject / send-back over HTTP ----------------------------------------
//
// The workflow rules themselves are pinned in test/workflow.test.js; these
// prove the ROUTE maps them onto the right status codes — a permission
// failure is a 403 and a missing reason is a 400, never the other way round.

async function bootWithDraft() {
  const { db, server, call } = await boot();
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();
  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  const sub = (await call('POST', '/api/submissions', { formId: 1, machineId: 'ED04', frequency: 'Y' })).body;
  return { db, server, call, sub };
}

test('POST /api/submissions/:id/reject sends a pending_lead record back to the technician', async () => {
  const { db, server, call, sub } = await bootWithDraft();
  try {
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    await call('POST', '/api/login', { username: 'lead', password: 'lead' });

    const res = await call('POST', `/api/submissions/${sub.id}/reject`, { reason: 'Torque values missing.' });
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'rejected');

    assert.equal(db.prepare('select count(*) as c from signatures where submission_id=?').get(sub.id).c, 0);
    const rejections = db.prepare('select * from rejections where submission_id=?').all(sub.id);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].reason, 'Torque values missing.');

    // The technician can see WHY: the reason, who rejected it and when are
    // returned with the record, or the UI cannot show them.
    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    const detail = (await call('GET', `/api/submissions/${sub.id}`)).body;
    assert.equal(detail.submission.state, 'rejected');
    assert.equal(detail.rejections.length, 1);
    assert.equal(detail.rejections[0].reason, 'Torque values missing.');
    assert.ok(detail.rejections[0].full_name);
    assert.ok(detail.rejections[0].rejected_at);
    assert.equal(detail.rejections[0].stage, 'team_leader');
  } finally { server.close(); }
});

test('rejecting with an empty or whitespace-only reason is a 400 and changes nothing', async () => {
  const { db, server, call, sub } = await bootWithDraft();
  try {
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    await call('POST', '/api/login', { username: 'lead', password: 'lead' });

    for (const body of [{ reason: '' }, { reason: '   ' }, {}]) {
      const res = await call('POST', `/api/submissions/${sub.id}/reject`, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
      assert.match(res.body.error, /reason/i);
      assert.ok(!/\bat\s+\S+\s*\(/.test(JSON.stringify(res.body)), 'no stack frames may reach the client');
    }

    assert.equal(db.prepare('select state from submissions where id=?').get(sub.id).state, 'pending_lead');
    assert.equal(db.prepare('select count(*) as c from signatures where submission_id=?').get(sub.id).c, 1);
    assert.equal(db.prepare('select count(*) as c from rejections where submission_id=?').get(sub.id).c, 0);
  } finally { server.close(); }
});

test('a technician, and a reviewer whose stage it is not, are refused with 403', async () => {
  const { db, server, call, sub } = await bootWithDraft();
  try {
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });

    // Still signed in as the technician who created it.
    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    assert.equal((await call('POST', `/api/submissions/${sub.id}/reject`, { reason: 'x' })).status, 403);

    // The engineer's stage has not arrived yet.
    await call('POST', '/api/login', { username: 'eng', password: 'eng' });
    assert.equal((await call('POST', `/api/submissions/${sub.id}/reject`, { reason: 'x' })).status, 403);

    assert.equal(db.prepare('select state from submissions where id=?').get(sub.id).state, 'pending_lead');
    assert.equal(db.prepare('select count(*) as c from rejections where submission_id=?').get(sub.id).c, 0);
  } finally { server.close(); }
});

test('an approved record can never be rejected — 403, state unchanged', async () => {
  const { db, server, call, sub } = await bootWithDraft();
  try {
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    await call('POST', '/api/login', { username: 'lead', password: 'lead' });
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    await call('POST', '/api/login', { username: 'eng', password: 'eng' });
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    assert.equal(db.prepare('select state from submissions where id=?').get(sub.id).state, 'approved');

    assert.equal((await call('POST', `/api/submissions/${sub.id}/reject`, { reason: 'too late' })).status, 403);
    await call('POST', '/api/login', { username: 'lead', password: 'lead' });
    assert.equal((await call('POST', `/api/submissions/${sub.id}/reject`, { reason: 'too late' })).status, 403);

    assert.equal(db.prepare('select state from submissions where id=?').get(sub.id).state, 'approved');
    assert.equal(db.prepare('select count(*) as c from signatures where submission_id=?').get(sub.id).c, 3);
    assert.equal(db.prepare('select count(*) as c from rejections where submission_id=?').get(sub.id).c, 0);
  } finally { server.close(); }
});

test('an engineer rejecting clears the team leader signature, and the record walks the chain again', async () => {
  const { db, server, call, sub } = await bootWithDraft();
  try {
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    await call('POST', '/api/login', { username: 'lead', password: 'lead' });
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    assert.equal(db.prepare('select count(*) as c from signatures where submission_id=?').get(sub.id).c, 2);

    await call('POST', '/api/login', { username: 'eng', password: 'eng' });
    assert.equal((await call('POST', `/api/submissions/${sub.id}/reject`, { reason: 'Wrong interval.' })).status, 200);
    assert.equal(db.prepare('select count(*) as c from signatures where submission_id=?').get(sub.id).c, 0,
      'the team leader signed content that is about to change — their signature must be cleared too');

    // The technician owns it again and can edit, re-sign and resubmit.
    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    assert.equal((await call('PATCH', `/api/submissions/${sub.id}`, { values: { remarks: 'corrected' } })).status, 200);
    const resigned = await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    assert.equal(resigned.status, 200);
    assert.equal(resigned.body.state, 'pending_lead');
  } finally { server.close(); }
});

// --- The fields payload tells the client where each value belongs ---------
//
// Without this the left-hand pane can only ever render a BLANK form: it has
// the sheet and it has the values, but nothing connecting the two. Every
// coordinate here is derived from the parsed definition — none is guessed.

test('GET /forms/:id/fields says which cell each task status belongs in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cellfor-'));
  try {
    // Header on row 1 (Status in column D = 4), tasks on rows 2 and 3.
    await writeSyntheticWorkbook(join(dir, 'form.xlsx'), [
      ['3M', 'Widget check A'],
      ['Y', 'Widget check B']
    ]);
    const { db, server, call } = await boot();
    try {
      await scanFolder(db, dir);
      const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
      await call('POST', '/api/login', { username: 'tech', password: 'tech' });

      const res = await call('GET', `/api/forms/${form.id}/fields?frequency=`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.cellFor.task_2, { row: 2, col: 4 });
      assert.deepEqual(res.body.cellFor.task_3, { row: 3, col: 4 });
    } finally { server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GET /forms/:id/fields says which printed option of the frequency band each interval is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cellfor-'));
  try {
    // A band above the task table, all its options in one cell — the shape
    // eleven of the twelve real documents have. Invented wording: the payload
    // must be usable without the client knowing any of it.
    const band = 'Monthly (1M)     Quarterly (3M)     Annual (Y)';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getRow(1).getCell(2).value = band;
    ws.getRow(3).getCell(1).value = 'No';
    ws.getRow(3).getCell(2).value = 'Freq.';
    ws.getRow(3).getCell(3).value = 'Instruction';
    ws.getRow(3).getCell(4).value = 'Status';
    [['1M', 'Widget check A'], ['3M', 'Widget check B']].forEach(([freq, instruction], i) => {
      const row = ws.getRow(i + 4);
      row.getCell(1).value = i + 1;
      row.getCell(2).value = freq;
      row.getCell(3).value = instruction;
    });
    await wb.xlsx.writeFile(join(dir, 'form.xlsx'));

    const { db, server, call } = await boot();
    try {
      await scanFolder(db, dir);
      const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
      await call('POST', '/api/login', { username: 'tech', password: 'tech' });

      const res = await call('GET', `/api/forms/${form.id}/fields?frequency=3M`);
      assert.equal(res.status, 200);
      const marks = res.body.intervalCells;
      assert.ok(marks, 'the payload must carry the frequency-band positions');
      // The client draws a checkbox against exactly what this range delimits,
      // so the range has to slice the band text back to the option itself.
      assert.deepEqual(
        { row: marks['3M'].row, col: marks['3M'].col }, { row: 1, col: 2 });
      assert.equal(band.slice(marks['3M'].start, marks['3M'].end), 'Quarterly (3M)');
      assert.equal(band.slice(marks['1M'].start, marks['1M'].end), 'Monthly (1M)');
      // The band prints a yearly option this form has no tasks for. The printed
      // form still draws a box beside it, so it is still placed — but no visit
      // this document can be scoped to may tick it.
      assert.ok(marks.Y, 'an option the form prints must still be placeable');
      assert.deepEqual(marks.Y.tickedBy.filter((c) => res.body.frequencies.includes(c)), []);
      // EXACTLY ONE box is ticked: the interval of this visit. Four of the
      // customer's archived records were checked directly and every one
      // carries a single tick. Cumulative scope decides which TASKS a visit
      // covers, not how many boxes the band shows ticked.
      assert.deepEqual(marks['1M'].tickedBy, ['1M']);
      assert.deepEqual(marks['3M'].tickedBy, ['3M']);
      assert.equal(marks['3M'].tickedBy.includes('1M'), false);
      assert.equal(marks['1M'].tickedBy.includes('3M'), false);
    } finally { server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a form with no status column omits task statuses and still returns a valid payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cellfor-'));
  try {
    // Same workbook shape, minus the Status header cell. Two of the twelve
    // real controlled documents are exactly this shape: their task statuses
    // have nowhere on the sheet to go, and the preview must render without
    // them rather than throwing or picking a neighbouring column.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getRow(1).getCell(1).value = 'No';
    ws.getRow(1).getCell(2).value = 'Freq.';
    ws.getRow(1).getCell(3).value = 'Instruction';
    ws.getRow(2).getCell(1).value = 1;
    ws.getRow(2).getCell(2).value = '3M';
    ws.getRow(2).getCell(3).value = 'Widget check A';
    await wb.xlsx.writeFile(join(dir, 'form.xlsx'));

    const { db, server, call } = await boot();
    try {
      await scanFolder(db, dir);
      const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
      await call('POST', '/api/login', { username: 'tech', password: 'tech' });

      const res = await call('GET', `/api/forms/${form.id}/fields?frequency=`);
      assert.equal(res.status, 200);
      assert.ok(res.body.cellFor, 'cellFor is still present');
      assert.deepEqual(Object.keys(res.body.cellFor).filter((k) => k.startsWith('task_')), []);
      // The rest of the payload is unaffected — the form is still usable.
      assert.equal(res.body.tasks.length, 1);
      assert.ok(res.body.fields.some((f) => f.field_key === 'task_2'),
        'the task is still a field in the right-hand panel; only its sheet cell is unknown');
    } finally { server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Answers the document constrains
// ---------------------------------------------------------------------------
test('an answer the form does not offer is a 400, not a 403', async () => {
  // A 403 would tell a technician they may not edit this record, which is both
  // untrue and sends them looking for the wrong problem. The field-save route
  // falls back to 403 because most of its failures ARE permission failures, so
  // this asserts the exception is real.
  const { db, server, call } = await boot();
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/c.xlsx','c.xlsx','xlsx','ready')`).run();
  const formId = db.prepare('select id from form_catalog where file_path=?').get('/c.xlsx').id;
  db.prepare(`insert into form_fields (form_id, field_key, label, section, kind, sort_order, source, options)
    values (?,'cal_54_result','Generic measurement A','Calibration record','text',0,'parsed','Pass\nFail')`)
    .run(formId);

  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  const created = await call('POST', '/api/submissions', { formId, frequency: '' });

  const bad = await call('PATCH', `/api/submissions/${created.body.id}`, { values: { cal_54_result: 'Marginal' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /must be one of: Pass, Fail/);

  const good = await call('PATCH', `/api/submissions/${created.body.id}`, { values: { cal_54_result: 'Fail' } });
  assert.equal(good.status, 200);

  // ...and a caller with no right to the record still gets 403, not 400: the
  // permission check runs first and is not weakened by any of this.
  await call('POST', '/api/login', { username: 'lead', password: 'lead' });
  const forbidden = await call('PATCH', `/api/submissions/${created.body.id}`, { values: { cal_54_result: 'Marginal' } });
  assert.equal(forbidden.status, 403);

  server.close();
});
