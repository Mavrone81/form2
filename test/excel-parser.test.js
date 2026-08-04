import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../server/excel-parser.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const fx = loadFixtures();

// Builds a small synthetic workbook (invented generic text only — never real
// form content) with one task row, writes it to a temp file, and returns its
// path. `headerCells` is a sparse map of {col: text} for the header row;
// `taskCells` is the same shape for the single task row beneath it.
async function writeSyntheticWorkbook(dir, name, headerRowCells, taskRowCells) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const headerRow = ws.getRow(1);
  for (const [col, text] of Object.entries(headerRowCells)) headerRow.getCell(Number(col)).value = text;
  const taskRow = ws.getRow(2);
  for (const [col, text] of Object.entries(taskRowCells)) taskRow.getCell(Number(col)).value = text;
  const path = join(dir, name);
  await wb.xlsx.writeFile(path);
  return path;
}

test('every sample form parses to its expected shape', { skip: fx ? false : SKIP }, async () => {
  for (const f of fx.forms) {
    const def = await parseWorkbook(join(fx.formsDir, f.file));
    assert.equal(def.tasks.length, f.tasks, `${f.id} task count`);
    assert.equal(def.statusColumn, f.statusCol, `${f.id} status column`);
    assert.deepEqual([...new Set(def.tasks.map((t) => t.freq))].sort(), f.freqs, `${f.id} freqs`);
    assert.ok(def.docNumber, `${f.id} has a document number`);
    assert.equal(def.signatures.length, 3, `${f.id} signature blocks`);
  }
});

test('a task row with a blank No is still a task', { skip: fx ? false : SKIP }, async () => {
  // Guards the truncation bug: terminating on a blank No cuts one sample
  // form from 11 tasks to 3.
  const eleven = fx.forms.find((f) => f.tasks === 11);
  assert.ok(eleven, 'expected a fixture with 11 tasks');
  const def = await parseWorkbook(join(fx.formsDir, eleven.file));
  assert.equal(def.tasks.length, 11);
  assert.ok(def.tasks.some((t) => t.no === null), 'expected one unnumbered task');
});

test('frequencies are ordered shortest to longest', { skip: fx ? false : SKIP }, async () => {
  const def = await parseWorkbook(join(fx.formsDir, fx.forms[0].file));
  const idx = def.frequencies.map((f) => ['1M', '3M', '6M', 'Y'].indexOf(f));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});

// Header column detection guards against forms outside the sample set:
// column order in this template is always No < Freq < Instruction < Status,
// so a fuzzy keyword match out of that order must not be trusted. All
// content below is invented/generic — no real form text.

test('a decoy cell that fuzzy-matches "status" before Instruction is ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'excel-parser-test-'));
  try {
    const path = await writeSyntheticWorkbook(
      dir,
      'decoy-status.xlsx',
      { 1: 'No', 2: 'Freq.', 3: 'Status Notes', 4: 'Instruction', 5: 'Status' },
      { 1: 1, 2: '1M', 4: 'Widget check', 5: 'Pass' }
    );
    const def = await parseWorkbook(path);
    assert.equal(def.tasks.length, 1);
    assert.equal(def.tasks[0].instruction, 'Widget check');
    assert.equal(def.statusColumn, 'E', 'should pick the real Status column (E), not the decoy (C)');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a header-keyword row with columns out of ascending order is not treated as the header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'excel-parser-test-'));
  try {
    const path = join(dir, 'out-of-order.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    // Row 1: all three keywords present, but Instruction precedes No/Freq —
    // out of ascending order, so it must be skipped rather than accepted.
    ws.getRow(1).getCell(1).value = 'Instruction';
    ws.getRow(1).getCell(2).value = 'No';
    ws.getRow(1).getCell(3).value = 'Freq.';
    // Row 2: the real, correctly-ordered header.
    ws.getRow(2).getCell(1).value = 'No';
    ws.getRow(2).getCell(2).value = 'Freq.';
    ws.getRow(2).getCell(3).value = 'Instruction';
    // Row 3: the one real task row.
    ws.getRow(3).getCell(1).value = 1;
    ws.getRow(3).getCell(2).value = '1M';
    ws.getRow(3).getCell(3).value = 'Machine A check';
    await wb.xlsx.writeFile(path);

    const def = await parseWorkbook(path);
    assert.equal(def.tasks.length, 1, 'only the genuine task row should be counted');
    assert.equal(def.tasks[0].instruction, 'Machine A check');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a normal synthetic header still parses correctly (happy path unaffected)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'excel-parser-test-'));
  try {
    const path = await writeSyntheticWorkbook(
      dir,
      'happy-path.xlsx',
      { 1: 'No', 2: 'Freq.', 3: 'Instruction', 4: 'Status' },
      { 1: 1, 2: '1M', 3: 'Machine B check', 4: 'Pass' }
    );
    const def = await parseWorkbook(path);
    assert.equal(def.tasks.length, 1);
    assert.equal(def.tasks[0].instruction, 'Machine B check');
    assert.equal(def.tasks[0].freq, '1M');
    assert.equal(def.statusColumn, 'D');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
