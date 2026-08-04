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
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { db, server, call };
}

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
