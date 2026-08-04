import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { scanFolder, listForms } from '../server/scanner.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pmforms-'));

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
