import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../server/excel-parser.js';
import { buildGrid } from '../server/grid-model.js';
import { cellMapFor, columnNumber } from '../server/cell-map.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const fx = loadFixtures();

// Synthetic workbook — invented, generic content only, never real form text.
// `status` false omits the Status column entirely, which is the shape two of
// the twelve real controlled documents actually have.
async function writeSyntheticWorkbook(path, { status = true, title = 'Widget Maintenance Record WX____' } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getRow(1).getCell(1).value = 'Document Title:';
  ws.getRow(2).getCell(1).value = title;
  ws.getRow(1).getCell(5).value = 'Document Number:';
  ws.getRow(2).getCell(5).value = 'XX 00 000 00 00';
  ws.getRow(3).getCell(1).value = 'Special Tools Required:';
  ws.getRow(3).getCell(3).value = '____________________';
  ws.getRow(5).getCell(1).value = 'No';
  ws.getRow(5).getCell(2).value = 'Freq.';
  ws.getRow(5).getCell(3).value = 'Instruction';
  if (status) ws.getRow(5).getCell(4).value = 'Status';
  [['3M', 'Check the widget mounting'], ['Y', 'Replace the widget filter']].forEach(([freq, instruction], i) => {
    const row = ws.getRow(i + 6);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = freq;
    row.getCell(3).value = instruction;
  });
  ws.getRow(9).getCell(1).value = 'Maintenance Performed by:';
  ws.getRow(10).getCell(2).value = '__________________';
  await wb.xlsx.writeFile(path);
  return path;
}

test('columnNumber converts a column letter, and reports null for "no column"', () => {
  assert.equal(columnNumber('A'), 1);
  assert.equal(columnNumber('M'), 13);
  assert.equal(columnNumber('O'), 15);
  assert.equal(columnNumber('AA'), 27);
  // The parser reports null for a form with no Status column at all.
  assert.equal(columnNumber(null), null);
  assert.equal(columnNumber(''), null);
  assert.equal(columnNumber('3'), null);
});

// --- Requirement 1: a real form WITH a status column -----------------------

test('every task status maps to its own sheet row in the status column (real form)',
  { skip: fx ? false : SKIP }, async () => {
    const withStatus = fx.forms.filter((f) => f.statusCol);
    assert.ok(withStatus.length, 'expected at least one fixture form with a status column');

    for (const f of withStatus) {
      const def = await parseWorkbook(join(fx.formsDir, f.file));
      const { cellFor } = cellMapFor(def);
      const expectedCol = columnNumber(f.statusCol);

      // Exactly one entry per task, keyed by the task's own sheet row — the
      // same convention server/scanner.js uses to name the field.
      const taskKeys = Object.keys(cellFor).filter((k) => k.startsWith('task_'));
      assert.equal(taskKeys.length, def.tasks.length, `${f.id} maps every task`);
      for (const t of def.tasks) {
        assert.deepEqual(cellFor[`task_${t.row}`], { row: t.row, col: expectedCol },
          `${f.id} task at sheet row ${t.row}`);
      }
    }
  });

test('every mapped cell is one the rendered grid actually contains (real forms)',
  { skip: fx ? false : SKIP }, async () => {
    // A coordinate the grid does not render is worse than no coordinate: the
    // value would be silently dropped with nothing to show for it. This is
    // the property that makes "determinate" mean something.
    for (const f of fx.forms) {
      const path = join(fx.formsDir, f.file);
      const def = await parseWorkbook(path);
      const { cellFor, titleCell } = cellMapFor(def);
      const grid = await buildGrid(path, def);
      const rendered = new Set();
      for (const row of grid.rows) for (const cell of row.cells) rendered.add(`${row.index}:${cell.col}`);

      assert.ok(titleCell, `${f.id} has a title cell`);
      assert.ok(rendered.has(`${titleCell.row}:${titleCell.col}`), `${f.id} title cell is rendered`);
      for (const [key, cell] of Object.entries(cellFor)) {
        assert.ok(rendered.has(`${cell.row}:${cell.col}`),
          `${f.id} ${key} -> ${cell.row}:${cell.col} is not a rendered cell`);
      }
    }
  });

// --- Requirement 2: a real form with NO status column ----------------------

test('a form with no status column omits task statuses but still maps everything else (real form)',
  { skip: fx ? false : SKIP }, async () => {
    const noStatus = fx.forms.filter((f) => f.statusCol === null);
    assert.ok(noStatus.length, 'expected at least one fixture form with no status column');

    for (const f of noStatus) {
      const def = await parseWorkbook(join(fx.formsDir, f.file));
      assert.ok(def.tasks.length, `${f.id} still has tasks`);
      const { cellFor, titleCell } = cellMapFor(def);

      // No task may be given a cell — there is no column on the sheet for it,
      // and a neighbouring column would print the status under the wrong
      // heading.
      assert.deepEqual(Object.keys(cellFor).filter((k) => k.startsWith('task_')), [],
        `${f.id} must not place any task status`);
      // ...and the payload is still useful: the rest of the form maps.
      assert.ok(titleCell, `${f.id} still has a title cell`);
      assert.ok(cellFor.special_tools, `${f.id} still maps special tools`);
    }
  });

test('a form with no status column omits task statuses (synthetic)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cellmap-'));
  try {
    const def = await parseWorkbook(await writeSyntheticWorkbook(join(dir, 'no-status.xlsx'), { status: false }));
    assert.equal(def.statusColumn, null);
    assert.equal(def.tasks.length, 2);
    const { cellFor, titleCell } = cellMapFor(def);
    assert.deepEqual(Object.keys(cellFor).filter((k) => k.startsWith('task_')), []);
    assert.deepEqual(titleCell, { row: 2, col: 1 });
    assert.deepEqual(cellFor.special_tools, { row: 3, col: 3 });
    assert.deepEqual(cellFor.sig_technician, { row: 10, col: 2 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a form with a status column maps each task to it (synthetic)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cellmap-'));
  try {
    const def = await parseWorkbook(await writeSyntheticWorkbook(join(dir, 'with-status.xlsx')));
    assert.equal(def.statusColumn, 'D');
    const { cellFor } = cellMapFor(def);
    assert.deepEqual(cellFor.task_6, { row: 6, col: 4 });
    assert.deepEqual(cellFor.task_7, { row: 7, col: 4 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a field the document has no blank for is omitted, never invented', async () => {
  // Only cells the sheet genuinely prints a blank for may appear. A label
  // with no blank beside it (here, Remarks) must produce no entry at all
  // rather than a nearby cell that happens to be free.
  const dir = await mkdtemp(join(tmpdir(), 'cellmap-'));
  try {
    const path = join(dir, 'no-remarks-blank.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getRow(1).getCell(1).value = 'No';
    ws.getRow(1).getCell(2).value = 'Freq.';
    ws.getRow(1).getCell(3).value = 'Instruction';
    ws.getRow(1).getCell(4).value = 'Status';
    ws.getRow(2).getCell(1).value = 1;
    ws.getRow(2).getCell(2).value = '3M';
    ws.getRow(2).getCell(3).value = 'Check the widget mounting';
    ws.getRow(4).getCell(1).value = 'Remarks: this line is printed guidance, not a blank';
    await wb.xlsx.writeFile(path);

    const { cellFor } = cellMapFor(await parseWorkbook(path));
    assert.equal(cellFor.remarks, undefined, 'remarks has no printed blank, so it must be omitted');
    assert.equal(cellFor.special_tools, undefined, 'no special-tools label at all, so it must be omitted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
