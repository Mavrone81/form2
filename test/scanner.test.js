import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { openDb } from '../server/db.js';
import { scanFolder, listForms } from '../server/scanner.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pmforms-'));

// Builds a minimal synthetic workbook the parser accepts: a header row with
// No / Freq. / Instruction / Status, plus the given task rows. Content is
// invented/generic ("Widget check", "Machine A") — never real form text.
async function writeSyntheticWorkbook(path, tasks) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getRow(1).getCell(1).value = 'No';
  ws.getRow(1).getCell(2).value = 'Freq.';
  ws.getRow(1).getCell(3).value = 'Instruction';
  ws.getRow(1).getCell(4).value = 'Status';
  tasks.forEach((instruction, i) => {
    const row = ws.getRow(i + 2);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = '1M';
    row.getCell(3).value = instruction;
  });
  await wb.xlsx.writeFile(path);
  return path;
}

test('a pdf lands as needs_setup and is hidden from technicians', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'guide.pdf'), '%PDF-1.4 test');
  const db = openDb(':memory:');
  const res = await scanFolder(db, dir);
  assert.equal(res.added, 1);
  assert.equal(listForms(db, { includeAll: true })[0].state, 'needs_setup');
  assert.equal(listForms(db).length, 0, 'technicians see no unmapped form');
  rmSync(dir, { recursive: true, force: true });
});

test('an unparseable xlsx is needs_setup, not a crash', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'broken.xlsx'), 'not really a workbook');
  const db = openDb(':memory:');
  const res = await scanFolder(db, dir);
  assert.equal(res.failed, 1);
  const [form] = listForms(db, { includeAll: true });
  assert.equal(form.state, 'needs_setup');
  assert.ok(form.parse_error);
  rmSync(dir, { recursive: true, force: true });
});

test('a removed file goes inactive rather than being deleted', async () => {
  const dir = tmp();
  const file = join(dir, 'gone.pdf');
  writeFileSync(file, '%PDF-1.4');
  const db = openDb(':memory:');
  await scanFolder(db, dir);
  rmSync(file);
  const res = await scanFolder(db, dir);
  assert.equal(res.deactivated, 1);
  const rows = listForms(db, { includeAll: true });
  assert.equal(rows.length, 1, 'catalog row still exists, not deleted');
  assert.equal(rows[0].state, 'inactive');
  rmSync(dir, { recursive: true, force: true });
});

test('a missing folder reports an error without wiping the catalog', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.pdf'), '%PDF-1.4');
  const db = openDb(':memory:');
  await scanFolder(db, dir);
  await assert.rejects(() => scanFolder(db, join(dir, 'nope')));
  assert.equal(listForms(db, { includeAll: true }).length, 1, 'catalog survives');
  rmSync(dir, { recursive: true, force: true });
});

test('excel temp files are ignored', async () => {
  const dir = tmp();
  writeFileSync(join(dir, '~$draft.xlsx'), 'lock file');
  const db = openDb(':memory:');
  const res = await scanFolder(db, dir);
  assert.equal(res.added, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('rescanning an unchanged folder is a no-op', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'guide.pdf'), '%PDF-1.4 test');
  await writeSyntheticWorkbook(join(dir, 'good.xlsx'), ['Widget check']);
  const db = openDb(':memory:');
  await scanFolder(db, dir);
  const res = await scanFolder(db, dir);
  assert.deepEqual(res, { added: 0, updated: 0, deactivated: 0, failed: 0 });
  rmSync(dir, { recursive: true, force: true });
});

test('a file that vanishes and returns with identical content is reactivated', async () => {
  const dir = tmp();
  const file = join(dir, 'gone.pdf');
  const content = '%PDF-1.4 identical bytes';
  writeFileSync(file, content);
  const db = openDb(':memory:');
  await scanFolder(db, dir);

  rmSync(file);
  const mid = await scanFolder(db, dir);
  assert.equal(mid.deactivated, 1);
  assert.equal(listForms(db, { includeAll: true })[0].state, 'inactive');

  // Restore the exact same bytes: content_hash is unchanged, so this is the
  // path most likely to regress (the `existing.state !== 'inactive'` half of
  // the skip-guard must still let it fall through and be reprocessed).
  writeFileSync(file, content);
  const res = await scanFolder(db, dir);
  const rows = listForms(db, { includeAll: true });
  assert.equal(rows.length, 1, 'still a single catalog row');
  assert.notEqual(rows[0].state, 'inactive', 'file back on disk must not stay inactive');
  assert.equal(rows[0].state, 'needs_setup', 'a pdf always needs_setup once reactivated');
  rmSync(dir, { recursive: true, force: true });
});

test('an admin-authored field survives a rescan that regenerates parsed fields', async () => {
  const dir = tmp();
  const path = join(dir, 'form.xlsx');
  await writeSyntheticWorkbook(path, ['Widget check A']);
  const db = openDb(':memory:');
  await scanFolder(db, dir);

  const { id: formId } = db.prepare('select id from form_catalog where file_name = ?').get('form.xlsx');
  // Simulate an admin customizing the auto-generated machine_id field: the
  // key collides with one `fieldsFromDefinition` will regenerate below.
  db.prepare("delete from form_fields where form_id = ? and field_key = 'machine_id'").run(formId);
  db.prepare(`insert into form_fields (form_id, field_key, label, section, kind, sort_order, source)
    values (?, 'machine_id', 'Custom Machine ID (admin)', 'Record', 'text', 0, 'admin')`).run(formId);

  // Change the file's content so the hash differs and a rescan regenerates
  // the parsed fields for this form.
  await writeSyntheticWorkbook(path, ['Widget check A', 'Widget check B']);
  await scanFolder(db, dir);

  const field = db.prepare('select * from form_fields where form_id = ? and field_key = ?')
    .get(formId, 'machine_id');
  assert.ok(field, 'admin field must still exist');
  assert.equal(field.source, 'admin', 'admin field must not be reclaimed as parsed');
  assert.equal(field.label, 'Custom Machine ID (admin)', 'admin label must survive untouched');
  rmSync(dir, { recursive: true, force: true });
});

test('one unparseable xlsx does not block a good file in the same scan', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'broken.xlsx'), 'not really a workbook');
  await writeSyntheticWorkbook(join(dir, 'good.xlsx'), ['Widget check']);
  const db = openDb(':memory:');
  const res = await scanFolder(db, dir);
  assert.equal(res.failed, 1);
  assert.equal(res.added, 2);

  const rows = listForms(db, { includeAll: true });
  assert.equal(rows.length, 2, 'both rows exist');
  const good = rows.find((r) => r.file_name === 'good.xlsx');
  const bad = rows.find((r) => r.file_name === 'broken.xlsx');
  assert.equal(good.state, 'ready');
  assert.equal(bad.state, 'needs_setup');
  assert.ok(bad.parse_error);
  rmSync(dir, { recursive: true, force: true });
});
