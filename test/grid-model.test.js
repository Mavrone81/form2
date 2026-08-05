import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { buildGrid, mergeMap } from '../server/grid-model.js';
import { parseWorkbook } from '../server/excel-parser.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const fx = loadFixtures();

// Every sample form, as { id: 'F01', path }. Only the fixture's own id is ever
// used in an assertion message — never a file name, which is form content.
const samples = () => (fx?.forms ?? []).map((f) => ({ id: f.id, path: join(fx.formsDir, f.file) }));

// buildGrid re-reads and re-parses the workbook, so the whole-corpus tests
// below share one grid per form rather than paying that cost four times over.
const gridCache = new Map();
async function gridFor(sample) {
  if (!gridCache.has(sample.id)) gridCache.set(sample.id, await buildGrid(sample.path));
  return gridCache.get(sample.id);
}

const isFiller = (cell) => cell.filler === true;
const realCells = (row) => row.cells.filter((c) => !isFiller(c));

// Which columns of `row` are already spoken for by a cell anchored in an
// EARLIER row that spans down into this one. A renderer emitting cells in
// order must not re-emit those columns: the rowspan already occupies them,
// so a placeholder there would push the row one column too wide. `carry` is
// accumulated as the caller walks rows in index order.
function claimRow(row, carried, columnCount) {
  const owner = new Map();
  const overlaps = [];
  const claim = (col, what) => {
    if (owner.has(col)) overlaps.push(`col ${col} claimed by both ${owner.get(col)} and ${what}`);
    else owner.set(col, what);
  };
  for (const col of carried) claim(col, 'a rowspan from an earlier row');
  const past = [];
  for (const cell of row.cells) {
    for (let c = cell.col; c < cell.col + cell.span.cols; c++) {
      if (c > columnCount) past.push(c);
      else claim(c, `the cell at col ${cell.col}`);
    }
  }
  const missing = [];
  for (let c = 1; c <= columnCount; c++) if (!owner.has(c)) missing.push(c);
  return { overlaps, missing, past };
}

// Columns each later row inherits from the row-spanning cells of `row`.
function spread(row, carry) {
  for (const cell of row.cells) {
    if (cell.span.rows <= 1) continue;
    for (let r = row.index + 1; r < row.index + cell.span.rows; r++) {
      if (!carry.has(r)) carry.set(r, new Set());
      for (let c = cell.col; c < cell.col + cell.span.cols; c++) carry.get(r).add(c);
    }
  }
}

test('grid carries merges, widths and structural content', { skip: fx ? false : SKIP }, async () => {
  const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
  assert.ok(grid.columns.length > 5);
  assert.ok(grid.rows.length > 20);

  const cells = grid.rows.flatMap((r) => r.cells);
  const colMerged = cells.filter((c) => c.span.cols > 1);
  const rowMerged = cells.filter((c) => c.span.rows > 1);
  assert.ok(colMerged.length > 0, 'expected column-spanning merged cells');
  assert.ok(rowMerged.length > 0, 'expected row-spanning merged cells');

  // Structural shape assertions only — never assert on specific form text,
  // since that would bake sensitive source-form content into a committed test.
  const bold = cells.filter((c) => c.bold);
  assert.ok(bold.length > 0, 'expected at least one bold cell');

  const allSidesBordered = cells.filter((c) => c.borders.t && c.borders.r && c.borders.b && c.borders.l);
  assert.ok(allSidesBordered.length > 0, 'expected at least one fully-bordered cell');

  const nonEmptyText = cells.filter((c) => c.text.length > 0);
  assert.ok(nonEmptyText.length > 20, 'expected a non-trivial number of text-bearing cells');
});

test('no coordinate in the grid is claimed twice, including cells covered by a span', { skip: fx ? false : SKIP }, async () => {
  const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
  const claimed = new Set();
  const duplicates = [];
  for (const row of grid.rows) {
    for (const cell of row.cells) {
      for (let r = row.index; r < row.index + cell.span.rows; r++) {
        for (let c = cell.col; c < cell.col + cell.span.cols; c++) {
          const key = `${r}:${c}`;
          if (claimed.has(key)) duplicates.push(key);
          claimed.add(key);
        }
      }
    }
  }
  assert.deepEqual(duplicates, [], 'expected no coordinate to be claimed by more than one cell/span');
});

test('buildGrid(path) called with a single argument still works, with every row isTask === false', { skip: fx ? false : SKIP }, async () => {
  const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
  assert.ok(grid.rows.length > 0);
  assert.ok(grid.rows.every((r) => r.isTask === false), 'expected isTask === false on every row when no definition is supplied');
});

test('buildGrid(path, definition) marks exactly the task rows from definition.tasks[].row as isTask === true', { skip: fx ? false : SKIP }, async () => {
  const path = join(fx.formsDir, fx.forms[0].file);
  const def = await parseWorkbook(path);
  const grid = await buildGrid(path, def);

  const expectedTaskRows = new Set(def.tasks.map((t) => t.row));
  assert.ok(expectedTaskRows.size > 0, 'expected the fixture form to have at least one task row');

  const actualTaskRows = new Set(grid.rows.filter((r) => r.isTask).map((r) => r.index));
  assert.deepEqual(actualTaskRows, expectedTaskRows, 'expected isTask to be true on exactly the rows listed in definition.tasks[].row, and no others');
});

// THE regression guard for the preview-vs-print mismatch. A consumer that
// appends one cell per emitted cell, in order, only lands each cell in its
// true column if the emitted cells account for EVERY column of the row.
// Before the filler change, rows whose leading columns were blank emitted
// nothing for them, so the whole row packed left and stopped lining up with
// the row above it — 182 rows across the twelve forms did this.
test('every row that emits cells tiles columns 1..N exactly, on every sample form', { skip: fx ? false : SKIP }, async () => {
  const problems = [];
  for (const sample of samples()) {
    const grid = await gridFor(sample);
    const columnCount = grid.columns.length;
    const carry = new Map();
    for (const row of grid.rows) {
      if (row.cells.length === 0) continue; // blank spacer rows emit nothing, by design
      const { overlaps, missing, past } = claimRow(row, carry.get(row.index) ?? new Set(), columnCount);
      if (missing.length) problems.push(`${sample.id} row ${row.index}: columns [${missing}] are accounted for by no cell`);
      for (const o of overlaps) problems.push(`${sample.id} row ${row.index}: ${o}`);
      if (past.length) problems.push(`${sample.id} row ${row.index}: covers column(s) [${past}] past the last column ${columnCount}`);
      spread(row, carry);
    }
  }
  assert.deepEqual(problems.slice(0, 20), [], `${problems.length} row(s) do not tile their columns; first 20 shown`);
});

// The parts table is found structurally, never by its printed text: its data
// rows are the only rows on any of these forms carrying exactly four real
// cells that begin at column 4, and the row directly above them is the
// table's header. Before the fix those data rows emitted nothing for columns
// 1-3, so each one slid three columns left of its own header.
test('the parts-table data rows start at column 1 and cover the same columns as their header row', { skip: fx ? false : SKIP }, async () => {
  for (const sample of samples()) {
    const grid = await gridFor(sample);
    const byIndex = new Map(grid.rows.map((r) => [r.index, r]));
    const dataRows = grid.rows.filter((r) => {
      const real = realCells(r);
      return real.length === 4 && real[0].col === 4;
    });
    assert.ok(dataRows.length > 0, `${sample.id}: expected to find the parts-table data rows`);

    const header = byIndex.get(dataRows[0].index - 1);
    assert.ok(header && realCells(header).length === 5 && realCells(header)[0].col === 1,
      `${sample.id}: expected the parts-table header directly above the first data row`);
    const total = (row) => row.cells.reduce((sum, c) => sum + c.span.cols, 0);

    assert.equal(header.cells[0].col, 1, `${sample.id}: parts header should start at column 1`);
    for (const row of dataRows) {
      assert.equal(row.cells[0].col, 1, `${sample.id} row ${row.index}: parts data row should start at column 1`);
      assert.equal(total(row), total(header),
        `${sample.id} row ${row.index}: parts data row should cover the same number of columns as its header`);
      // The real content is untouched — only padded around.
      assert.equal(realCells(row)[0].col, 4, `${sample.id} row ${row.index}: the row's real content should still begin at column 4`);
    }
  }
});

// Padding must never resurrect a cell a merge hides: the anchor carries the
// span, and a placeholder laid over a covered coordinate would both duplicate
// the column and (once, as a past defect) blank the anchor's content.
test('cells covered by a merge stay omitted, and no row emits the same column twice', { skip: fx ? false : SKIP }, async () => {
  for (const sample of samples()) {
    const grid = await gridFor(sample);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(sample.path);
    const { covered } = mergeMap(wb.worksheets[0]);

    for (const row of grid.rows) {
      const seen = new Set();
      for (const cell of row.cells) {
        assert.ok(!seen.has(cell.col), `${sample.id} row ${row.index}: column ${cell.col} emitted twice`);
        seen.add(cell.col);
        assert.ok(!covered.has(`${row.index}:${cell.col}`),
          `${sample.id}: emitted a cell at ${row.index}:${cell.col}, which a merge covers — the anchor already carries it`);
      }
    }
  }
});

test('placeholders are flagged, and carry no text, weight, borders or span', { skip: fx ? false : SKIP }, async () => {
  let fillers = 0;
  for (const sample of samples()) {
    const grid = await gridFor(sample);
    for (const row of grid.rows) {
      for (const cell of row.cells.filter(isFiller)) {
        fillers++;
        assert.equal(cell.text, '', `${sample.id} ${row.index}:${cell.col}: a placeholder must carry no text`);
        assert.equal(cell.bold, false, `${sample.id} ${row.index}:${cell.col}: a placeholder must not be bold`);
        assert.deepEqual(cell.borders, { t: false, r: false, b: false, l: false },
          `${sample.id} ${row.index}:${cell.col}: a placeholder must carry no borders`);
        assert.deepEqual(cell.span, { rows: 1, cols: 1 }, `${sample.id} ${row.index}:${cell.col}: a placeholder must not span`);
      }
      // The distinction that matters downstream: an empty BORDERED cell is a
      // box the form means someone to write in, and is never a placeholder.
      for (const cell of realCells(row)) {
        const bordered = cell.borders.t || cell.borders.r || cell.borders.b || cell.borders.l;
        assert.ok(cell.text.length > 0 || bordered || cell.span.cols > 1 || cell.span.rows > 1,
          `${sample.id} ${row.index}:${cell.col}: a cell with no text, borders or span should have been flagged as a placeholder`);
      }
    }
  }
  assert.ok(fillers > 0, 'expected the sample forms to need placeholders');
});
