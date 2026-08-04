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

// This suite covers the interaction between two previously-separate fixes:
//   1. scanner.js skips regenerating any field_key already owned by
//      source='admin', so a rescan never destroys hand-authored work.
//   2. PUT /admin/forms/:id/fields used to write every field it received
//      with a hardcoded source='admin' — including auto-parsed fields the
//      mapper client merely displayed and never touched.
// Combined, opening a form in the mapper and saving once permanently froze
// its parsed fields: they'd all become 'admin'-owned and (1) would then
// skip regenerating them forever, even after the underlying document
// changed and was rescanned.
//
// Content here is invented and generic ("Widget check", "Machine A") —
// never real form/document text.

// Same minimal synthetic-workbook shape used in test/api.test.js.
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

function fieldsOf(db, formId) {
  return db.prepare('select * from form_fields where form_id=? order by sort_order').all(formId);
}

async function loginAdmin(call) {
  const res = await call('POST', '/api/login', { username: 'admin', password: 'admin' });
  assert.equal(res.status, 200);
}

test('regression: saving an unchanged field list through the mapper keeps parsed fields parsed, and they still regenerate on a later rescan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-admin-fields-'));
  let server;
  try {
    const path = join(dir, 'form.xlsx');
    await writeSyntheticWorkbook(path, [
      ['1M', 'Widget check A'],
      ['3M', 'Widget check B']
    ]);
    const booted = await boot();
    server = booted.server;
    const { db, call } = booted;

    await scanFolder(db, dir);
    const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
    assert.equal(form.state, 'ready');

    const before = fieldsOf(db, form.id);
    assert.ok(before.length > 0);
    assert.ok(before.every((f) => f.source === 'parsed'), 'every scanned field should start as parsed');

    // The mapper client reads the current field list and PUTs it straight
    // back unmodified — exactly what happens when an admin opens a form
    // just to look at it (or reopens an already-ready form) and saves.
    await loginAdmin(call);
    const payload = before.map((f) => ({
      field_key: f.field_key, label: f.label, section: f.section, kind: f.kind
    }));
    const save = await call('PUT', `/api/admin/forms/${form.id}/fields`, { fields: payload });
    assert.equal(save.status, 200);

    const afterSave = fieldsOf(db, form.id);
    assert.equal(afterSave.length, before.length);
    assert.ok(
      afterSave.every((f) => f.source === 'parsed'),
      `unchanged fields must stay source='parsed', got: ${afterSave.map((f) => f.source).join(',')}`
    );

    // Now the controlled document is revised and the folder rescanned. If
    // the fields above were wrongly flipped to 'admin', scanner.js's
    // (correct, untouched) admin-skip logic would leave the stale task list
    // in place forever. Change the workbook content, force a rescan by
    // invalidating the cached hash, and confirm the parsed fields DO
    // regenerate to reflect the new content.
    await writeSyntheticWorkbook(path, [
      ['1M', 'Widget check A - revised'],
      ['3M', 'Widget check B'],
      ['6M', 'Widget check C - new task']
    ]);
    db.prepare("update form_catalog set content_hash='stale' where id=?").run(form.id);
    await scanFolder(db, dir);

    const afterRescan = fieldsOf(db, form.id);
    const taskLabels = afterRescan.filter((f) => f.section === 'Tasks').map((f) => f.label);
    assert.ok(taskLabels.includes('Widget check A - revised'), 'revised task text must appear after rescan');
    assert.ok(taskLabels.includes('Widget check C - new task'), 'newly added task must appear after rescan');
    assert.equal(taskLabels.includes('Widget check A'), false, 'stale pre-revision text must be gone');
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editing a parsed field label marks only that field admin-owned; siblings stay parsed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-admin-fields-'));
  let server;
  try {
    const path = join(dir, 'form.xlsx');
    await writeSyntheticWorkbook(path, [
      ['1M', 'Widget check A'],
      ['3M', 'Widget check B']
    ]);
    const booted = await boot();
    server = booted.server;
    const { db, call } = booted;

    await scanFolder(db, dir);
    const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
    const before = fieldsOf(db, form.id);

    await loginAdmin(call);
    const payload = before.map((f) => ({
      field_key: f.field_key,
      label: f.field_key === 'task_2' ? 'Widget check A - clarified' : f.label,
      section: f.section,
      kind: f.kind
    }));
    const save = await call('PUT', `/api/admin/forms/${form.id}/fields`, { fields: payload });
    assert.equal(save.status, 200);

    const after = fieldsOf(db, form.id);
    const byKey = Object.fromEntries(after.map((f) => [f.field_key, f]));
    assert.equal(byKey.task_2.source, 'admin');
    assert.equal(byKey.task_2.label, 'Widget check A - clarified');
    for (const f of after) {
      if (f.field_key !== 'task_2') assert.equal(f.source, 'parsed', `${f.field_key} should remain parsed`);
    }
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely new field submitted through the mapper is admin-owned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-admin-fields-'));
  let server;
  try {
    const path = join(dir, 'form.xlsx');
    await writeSyntheticWorkbook(path, [['1M', 'Widget check A']]);
    const booted = await boot();
    server = booted.server;
    const { db, call } = booted;

    await scanFolder(db, dir);
    const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
    const before = fieldsOf(db, form.id);

    await loginAdmin(call);
    const payload = [
      ...before.map((f) => ({ field_key: f.field_key, label: f.label, section: f.section, kind: f.kind })),
      { field_key: 'notes_extra', label: 'Additional notes', section: 'Record', kind: 'text' }
    ];
    const save = await call('PUT', `/api/admin/forms/${form.id}/fields`, { fields: payload });
    assert.equal(save.status, 200);

    const after = fieldsOf(db, form.id);
    const added = after.find((f) => f.field_key === 'notes_extra');
    assert.ok(added);
    assert.equal(added.source, 'admin');
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reordering fields without editing them changes no source value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-admin-fields-'));
  let server;
  try {
    const path = join(dir, 'form.xlsx');
    await writeSyntheticWorkbook(path, [
      ['1M', 'Widget check A'],
      ['3M', 'Widget check B'],
      ['6M', 'Widget check C']
    ]);
    const booted = await boot();
    server = booted.server;
    const { db, call } = booted;

    await scanFolder(db, dir);
    const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
    const before = fieldsOf(db, form.id);

    await loginAdmin(call);
    // Reverse the order — same content, different sort_order only.
    const reversed = [...before].reverse();
    const payload = reversed.map((f) => ({ field_key: f.field_key, label: f.label, section: f.section, kind: f.kind }));
    const save = await call('PUT', `/api/admin/forms/${form.id}/fields`, { fields: payload });
    assert.equal(save.status, 200);

    const after = fieldsOf(db, form.id);
    assert.ok(after.every((f) => f.source === 'parsed'), 'reordering alone must not flip any source to admin');

    // Sort order must actually have changed, proving the reorder took effect.
    const afterKeysInOrder = after.map((f) => f.field_key);
    assert.deepEqual(afterKeysInOrder, reversed.map((f) => f.field_key));
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a field that is already admin-owned stays admin-owned after a save', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-admin-fields-'));
  let server;
  try {
    const path = join(dir, 'form.xlsx');
    await writeSyntheticWorkbook(path, [['1M', 'Widget check A']]);
    const booted = await boot();
    server = booted.server;
    const { db, call } = booted;

    await scanFolder(db, dir);
    const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
    const before = fieldsOf(db, form.id);

    await loginAdmin(call);

    // First save turns task_2's label into an admin override.
    const firstPayload = before.map((f) => ({
      field_key: f.field_key,
      label: f.field_key === 'task_2' ? 'Machine A widget check' : f.label,
      section: f.section,
      kind: f.kind
    }));
    await call('PUT', `/api/admin/forms/${form.id}/fields`, { fields: firstPayload });
    const afterFirst = fieldsOf(db, form.id);
    const task2First = afterFirst.find((f) => f.field_key === 'task_2');
    assert.equal(task2First.source, 'admin');

    // Second save resubmits the same (already admin) label unchanged.
    const secondPayload = afterFirst.map((f) => ({ field_key: f.field_key, label: f.label, section: f.section, kind: f.kind }));
    const save2 = await call('PUT', `/api/admin/forms/${form.id}/fields`, { fields: secondPayload });
    assert.equal(save2.status, 200);

    const afterSecond = fieldsOf(db, form.id);
    const task2Second = afterSecond.find((f) => f.field_key === 'task_2');
    assert.equal(task2Second.source, 'admin', 'an already-admin field must remain admin');
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
