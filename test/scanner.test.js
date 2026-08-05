import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { openDb } from '../server/db.js';
import { scanFolder, listForms, FIELDS_VERSION } from '../server/scanner.js';

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

// --- The Parts Required table ----------------------------------------------

// Same synthetic sheet as above plus the parts table above the task table.
// `boxes` is how many rows get the ruled box the document draws for someone
// to write in. All content is generic table headings, never form text.
const PARTS_BOX = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

async function writePartsWorkbook(path, { boxes = 3 } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getRow(1).getCell(1).value = 'Parts Required:';
  const headings = { 4: 'Part No', 7: 'Description', 12: 'Qty', 13: 'Remarks' };
  for (const [col, text] of Object.entries(headings)) ws.getRow(1).getCell(Number(col)).value = text;
  for (let i = 0; i < boxes; i++) {
    const row = ws.getRow(2 + i);
    for (const col of Object.keys(headings)) row.getCell(Number(col)).border = { ...PARTS_BOX };
  }
  const header = 2 + boxes + 1;
  ws.getRow(header).getCell(1).value = 'No';
  ws.getRow(header).getCell(2).value = 'Freq.';
  ws.getRow(header).getCell(3).value = 'Instruction';
  ws.getRow(header).getCell(4).value = 'Status';
  ws.getRow(header + 1).getCell(1).value = 1;
  ws.getRow(header + 1).getCell(2).value = '1M';
  ws.getRow(header + 1).getCell(3).value = 'Widget check';
  await wb.xlsx.writeFile(path);
  return path;
}

const fieldsOf = (db) =>
  db.prepare('select field_key, label, section, kind, sort_order from form_fields order by sort_order').all();

test('a form with a parts table generates exactly four fields per blank parts row', async () => {
  const dir = tmp();
  await writePartsWorkbook(join(dir, 'parts.xlsx'), { boxes: 3 });
  const db = openDb(':memory:');
  await scanFolder(db, dir);

  const parts = fieldsOf(db).filter((f) => f.field_key.startsWith('part_'));
  assert.equal(parts.length, 12, 'three ruled rows x four columns');
  assert.deepEqual(parts.map((f) => f.field_key), [
    'part_2_no', 'part_2_desc', 'part_2_qty', 'part_2_remarks',
    'part_3_no', 'part_3_desc', 'part_3_qty', 'part_3_remarks',
    'part_4_no', 'part_4_desc', 'part_4_qty', 'part_4_remarks'
  ]);
  // Keyed by the SHEET row, so each field maps to a cell without a lookup
  // table, exactly as task_<row> already does.
  for (const f of parts) {
    assert.equal(f.section, 'Parts required');
    assert.equal(f.kind, 'text');
  }
  assert.deepEqual(parts.slice(0, 4).map((f) => f.label), ['Part No', 'Description', 'Qty', 'Remarks']);
  rmSync(dir, { recursive: true, force: true });
});

test('the parts fields sit between the record fields and the tasks, as the document prints them', async () => {
  const dir = tmp();
  await writePartsWorkbook(join(dir, 'parts-order.xlsx'), { boxes: 2 });
  const db = openDb(':memory:');
  await scanFolder(db, dir);

  const keys = fieldsOf(db).map((f) => f.field_key);
  const firstPart = keys.findIndex((k) => k.startsWith('part_'));
  const firstTask = keys.findIndex((k) => k.startsWith('task_'));
  assert.ok(firstPart > keys.indexOf('special_tools'), 'parts come after the record fields');
  assert.ok(firstPart < firstTask, 'parts come before the tasks');
  rmSync(dir, { recursive: true, force: true });
});

test('a form with no parts table generates no parts fields and does not error', async () => {
  const dir = tmp();
  await writeSyntheticWorkbook(join(dir, 'no-parts.xlsx'), ['Widget check']);
  const db = openDb(':memory:');
  const res = await scanFolder(db, dir);
  assert.equal(res.failed, 0);
  assert.equal(listForms(db, { includeAll: true })[0].state, 'ready');
  assert.deepEqual(fieldsOf(db).filter((f) => f.field_key.startsWith('part_')), []);
  rmSync(dir, { recursive: true, force: true });
});

test('a rescan regenerates fields when the extractor has moved on, without touching the file', async () => {
  // The defect this guards: a rescan skips any file whose bytes are unchanged.
  // Teaching the parser to read something new (the parts table was the first
  // case) is not a change to any source document, so without a generation
  // marker every already-catalogued form would keep its old field list for
  // ever and the new fields would never appear on a new record.
  const dir = tmp();
  await writePartsWorkbook(join(dir, 'parts.xlsx'), { boxes: 2 });
  const db = openDb(':memory:');
  await scanFolder(db, dir);
  const [form] = listForms(db, { includeAll: true });
  assert.equal(form.fields_version, FIELDS_VERSION);

  // Simulate a catalog written by an older extractor: same bytes, older fields.
  db.prepare('update form_catalog set fields_version = 1 where id = ?').run(form.id);
  db.prepare("delete from form_fields where form_id = ? and field_key like 'part_%'").run(form.id);
  assert.deepEqual(fieldsOf(db).filter((f) => f.field_key.startsWith('part_')), []);

  const res = await scanFolder(db, dir);
  assert.equal(res.updated, 1, 'the stale form is re-read even though the file is identical');
  assert.equal(fieldsOf(db).filter((f) => f.field_key.startsWith('part_')).length, 8);
  assert.equal(listForms(db, { includeAll: true })[0].fields_version, FIELDS_VERSION);

  // ...and it is now a genuine no-op, so this is not a permanent re-parse.
  assert.deepEqual(await scanFolder(db, dir), { added: 0, updated: 0, deactivated: 0, failed: 0 });
  rmSync(dir, { recursive: true, force: true });
});

test('the source-document-changed signal is not disturbed by a field regeneration', async () => {
  // content_hash is copied onto every submission and is what tells a reader
  // whether the controlled document itself changed since the record was
  // signed. Regenerating fields must never move it, or every existing record
  // would start claiming its source document had changed.
  const dir = tmp();
  await writePartsWorkbook(join(dir, 'parts.xlsx'), { boxes: 2 });
  const db = openDb(':memory:');
  await scanFolder(db, dir);
  const before = listForms(db, { includeAll: true })[0].content_hash;

  db.prepare('update form_catalog set fields_version = 1').run();
  await scanFolder(db, dir);
  assert.equal(listForms(db, { includeAll: true })[0].content_hash, before,
    'the file did not change, so its content hash must not change either');
  rmSync(dir, { recursive: true, force: true });
});

test('a pdf and an unparseable xlsx are still skipped on the next scan', async () => {
  // fields_version marks which extractor PROCESSED a row, not whether that
  // row yielded any fields. A pdf never yields any and an unparseable xlsx
  // is deliberately left alone until its bytes change; marking them
  // unprocessed would make every scan re-read them for ever.
  const dir = tmp();
  writeFileSync(join(dir, 'guide.pdf'), '%PDF-1.4 test');
  writeFileSync(join(dir, 'broken.xlsx'), 'not really a workbook');
  const db = openDb(':memory:');
  await scanFolder(db, dir);
  assert.deepEqual(await scanFolder(db, dir), { added: 0, updated: 0, deactivated: 0, failed: 0 });
  rmSync(dir, { recursive: true, force: true });
});
