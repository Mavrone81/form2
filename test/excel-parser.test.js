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

// ---------------------------------------------------------------------------
// The Parts Required table
// ---------------------------------------------------------------------------
// Builds a synthetic sheet carrying a parts table above the task table. The
// four column headings are generic table headings, not form content. `boxes`
// is how many rows below the heading get the ruled box the document draws for
// someone to write in; `spacer` adds an unruled blank row after them, which is
// what actually terminates the table on the real documents.
const BOX = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

async function writePartsWorkbook(dir, name, {
  headings = { 4: 'Part No', 7: 'Description', 12: 'Qty', 13: 'Remarks' },
  headingRow = 3,
  anchorRow = 3,
  boxes = 3,
  spacer = true
} = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  if (anchorRow) ws.getRow(anchorRow).getCell(1).value = 'Parts Required:';
  for (const [col, text] of Object.entries(headings)) ws.getRow(headingRow).getCell(Number(col)).value = text;
  for (let i = 0; i < boxes; i++) {
    const row = ws.getRow(headingRow + 1 + i);
    for (const col of Object.keys(headings)) row.getCell(Number(col)).border = { ...BOX };
  }
  const taskHeader = headingRow + 1 + boxes + (spacer ? 1 : 0);
  ws.getRow(taskHeader).getCell(1).value = 'No';
  ws.getRow(taskHeader).getCell(2).value = 'Freq.';
  ws.getRow(taskHeader).getCell(3).value = 'Instruction';
  ws.getRow(taskHeader + 1).getCell(1).value = 1;
  ws.getRow(taskHeader + 1).getCell(2).value = '1M';
  ws.getRow(taskHeader + 1).getCell(3).value = 'Widget check';
  const path = join(dir, name);
  await wb.xlsx.writeFile(path);
  return path;
}

test('a parts table is reported as its header row, its four columns and its blank rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'excel-parser-test-'));
  try {
    const path = await writePartsWorkbook(dir, 'parts.xlsx', { boxes: 3 });
    const def = await parseWorkbook(path);
    assert.ok(def.parts, 'expected a parts table');
    assert.equal(def.parts.headerRow, 3);
    assert.deepEqual(def.parts.columns, { no: 4, desc: 7, qty: 12, remarks: 13 });
    assert.deepEqual(def.parts.rows, [4, 5, 6], 'only the ruled rows are fillable rows');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the unruled spacer row below the parts table is NOT a fillable row', async () => {
  // The row the document leaves blank between the parts table and whatever
  // follows carries no box. Counting it would put a technician's part number
  // in a row the form draws nothing for.
  const dir = await mkdtemp(join(tmpdir(), 'excel-parser-test-'));
  try {
    const path = await writePartsWorkbook(dir, 'spacer.xlsx', { boxes: 2, spacer: true });
    const def = await parseWorkbook(path);
    assert.deepEqual(def.parts.rows, [4, 5]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a form with no parts table reports none and does not throw', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'excel-parser-test-'));
  try {
    const path = await writeSyntheticWorkbook(
      dir,
      'no-parts.xlsx',
      { 1: 'No', 2: 'Freq.', 3: 'Instruction', 4: 'Status' },
      { 1: 1, 2: '1M', 3: 'Machine C check', 4: 'Pass' }
    );
    const def = await parseWorkbook(path);
    assert.equal(def.parts, null);
    assert.equal(def.tasks.length, 1, 'the rest of the definition is unaffected');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parts columns out of ascending order are rejected rather than mapped to the wrong cells', async () => {
  // Fail closed, exactly as the task header does. A layout this parser does
  // not recognise must yield no parts fields at all — never four fields
  // pointing at columns it guessed.
  const dir = await mkdtemp(join(tmpdir(), 'excel-parser-test-'));
  try {
    const path = await writePartsWorkbook(dir, 'parts-order.xlsx', {
      headings: { 4: 'Qty', 7: 'Part No', 12: 'Description', 13: 'Remarks' }
    });
    const def = await parseWorkbook(path);
    assert.equal(def.parts, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a parts table missing one of its four columns is not mapped at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'excel-parser-test-'));
  try {
    const path = await writePartsWorkbook(dir, 'parts-partial.xlsx', {
      headings: { 4: 'Part No', 7: 'Description', 12: 'Qty' }
    });
    const def = await parseWorkbook(path);
    assert.equal(def.parts, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the parts header is found by reading its own cells, not by a fixed offset from the anchor', async () => {
  // On the real documents the column headings sit on the anchor's own row.
  // A document that puts them a row lower must still work, and the columns
  // must come from the heading cells rather than from the anchor's position.
  const dir = await mkdtemp(join(tmpdir(), 'excel-parser-test-'));
  try {
    const path = await writePartsWorkbook(dir, 'parts-offset.xlsx', {
      anchorRow: 3,
      headingRow: 4,
      headings: { 5: 'Part No', 6: 'Description', 9: 'Qty', 11: 'Remarks' },
      boxes: 2
    });
    const def = await parseWorkbook(path);
    assert.equal(def.parts.headerRow, 4);
    assert.deepEqual(def.parts.columns, { no: 5, desc: 6, qty: 9, remarks: 11 });
    assert.deepEqual(def.parts.rows, [5, 6]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every sample form exposes a parts table whose columns ascend and whose rows are ruled', { skip: fx ? false : SKIP }, async () => {
  for (const f of fx.forms) {
    const def = await parseWorkbook(join(fx.formsDir, f.file));
    assert.ok(def.parts, `${f.id} has a parts table`);
    const { no, desc, qty, remarks } = def.parts.columns;
    assert.ok(no < desc && desc < qty && qty < remarks, `${f.id} parts columns ascend`);
    assert.ok(def.parts.rows.length > 0, `${f.id} has at least one fillable parts row`);
    for (const r of def.parts.rows) {
      assert.ok(r > def.parts.headerRow, `${f.id} parts row ${r} sits below its header`);
    }
    // Strictly consecutive: a gap would mean a row was skipped silently.
    const expected = def.parts.rows.map((_, i) => def.parts.headerRow + 1 + i);
    assert.deepEqual(def.parts.rows, expected, `${f.id} parts rows are consecutive`);
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
