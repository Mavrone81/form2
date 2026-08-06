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
// `span` is omitted whenever a cell occupies exactly one row and one column,
// and `borders` whenever no side has one — the model states only what departs
// from the sheet's default (see server/grid-model.js). Every consumer reads
// them through an accessor like these two.
const spanOf = (cell) => cell.span ?? { rows: 1, cols: 1 };
const sidesOf = (cell) => cell.borders ?? {};

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
    for (let c = cell.col; c < cell.col + spanOf(cell).cols; c++) {
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
    if (spanOf(cell).rows <= 1) continue;
    for (let r = row.index + 1; r < row.index + spanOf(cell).rows; r++) {
      if (!carry.has(r)) carry.set(r, new Set());
      for (let c = cell.col; c < cell.col + spanOf(cell).cols; c++) carry.get(r).add(c);
    }
  }
}

test('grid carries merges, widths and structural content', { skip: fx ? false : SKIP }, async () => {
  const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
  assert.ok(grid.columns.length > 5);
  assert.ok(grid.rows.length > 20);

  const cells = grid.rows.flatMap((r) => r.cells);
  const colMerged = cells.filter((c) => spanOf(c).cols > 1);
  const rowMerged = cells.filter((c) => spanOf(c).rows > 1);
  assert.ok(colMerged.length > 0, 'expected column-spanning merged cells');
  assert.ok(rowMerged.length > 0, 'expected row-spanning merged cells');

  // Structural shape assertions only — never assert on specific form text,
  // since that would bake sensitive source-form content into a committed test.
  const bold = cells.filter((c) => c.bold);
  assert.ok(bold.length > 0, 'expected at least one bold cell');

  const allSidesBordered = cells.filter((c) => {
    const b = sidesOf(c);
    return b.t && b.r && b.b && b.l;
  });
  assert.ok(allSidesBordered.length > 0, 'expected at least one fully-bordered cell');

  const nonEmptyText = cells.filter((c) => (c.text ?? '').length > 0);
  assert.ok(nonEmptyText.length > 20, 'expected a non-trivial number of text-bearing cells');
});

test('no coordinate in the grid is claimed twice, including cells covered by a span', { skip: fx ? false : SKIP }, async () => {
  const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
  const claimed = new Set();
  const duplicates = [];
  for (const row of grid.rows) {
    for (const cell of row.cells) {
      for (let r = row.index; r < row.index + spanOf(cell).rows; r++) {
        for (let c = cell.col; c < cell.col + spanOf(cell).cols; c++) {
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

// A sheet's declared column/row count can run past what the form actually
// uses — Excel's print area stops short of it. Rendering the surplus draws a
// dead strip with no content and no border, past which the table's own frame
// still sits: the "warp" a user sees. "Real" is independently recomputed here
// (never delegated to grid-model's own notion of it) so this test cannot pass
// merely because both sides agree with themselves: text, or a border on any
// side, on ANY cell — including one a merge covers, since Excel can still
// write a border on the covered cell that forms the merge's own perimeter.
async function rawExtent(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];
  const side = (b) => (b?.style ? String(b.style) : null);
  let lastCol = 0, lastRow = 0;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = row.getCell(c);
      const text = cell.value == null ? '' : String(cell.text ?? cell.value).trim();
      const b = cell.border ?? {};
      const hasBorder = !!(side(b.top) || side(b.right) || side(b.bottom) || side(b.left));
      if (text || hasBorder) {
        if (c > lastCol) lastCol = c;
        if (r > lastRow) lastRow = r;
      }
    }
  }
  return { lastCol, lastRow };
}

// The author's own print area, read independently of grid-model here for the
// same reason rawExtent is: a test that asks the code under test what it
// thinks the answer is proves nothing.
async function rawPrintArea(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const m = /^\$?([A-Z]+)\$?1:\$?([A-Z]+)\$?(\d+)$/
    .exec(String(wb.worksheets[0].pageSetup?.printArea ?? '').trim().toUpperCase());
  if (!m || m[1] !== 'A') return null;
  const toNum = (s) => [...s].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);
  return { lastCol: toNum(m[2]), lastRow: Number(m[3]) };
}

test('the grid trims to the smaller of the declared print area and the last cell carrying anything real',
  { skip: fx ? false : SKIP }, async () => {
    let declared = 0;
    for (const sample of samples()) {
      const grid = await gridFor(sample);
      const { lastCol, lastRow } = await rawExtent(sample.path);
      const area = await rawPrintArea(sample.path);
      if (area) declared++;

      // Where the author declared a print area it is a STATEMENT of where the
      // form ends and the scan is only a heuristic, so the smaller wins: the
      // declaration trims material the form does not print (one of the twelve
      // keeps ten columns of off-print working notes), and never pads the
      // document out with declared-but-empty columns. Where nothing is
      // declared, the scan still governs exactly, as it always did.
      const expectedCol = area ? Math.min(area.lastCol, lastCol) : lastCol;
      const expectedRow = area ? Math.min(area.lastRow, lastRow) : lastRow;
      assert.equal(grid.columns.length, expectedCol,
        `${sample.id}: expected the grid to end at column ${expectedCol}`);
      assert.equal(grid.rows.length, expectedRow,
        `${sample.id}: expected the grid to end at row ${expectedRow}`);
    }
    assert.ok(declared > 0, 'expected the sample forms to declare print areas — otherwise this asserts nothing new');
  });

// The page setup is the author's own statement about how this document
// prints, and the archived PDF is built on it: fitToWidth/fitToHeight of 1 is
// what says the form is a ONE-PAGE document, and `scale` is the shrink factor
// they chose. It must reach consumers intact, not be re-derived downstream.
test('the author\'s declared page setup travels with the grid', { skip: fx ? false : SKIP }, async () => {
  let withSetup = 0;
  for (const sample of samples()) {
    const grid = await gridFor(sample);
    assert.ok(grid.pageSetup, `${sample.id}: every grid carries a pageSetup, even when the sheet declares nothing`);
    const area = await rawPrintArea(sample.path);
    if (area) {
      withSetup++;
      assert.deepEqual(grid.pageSetup.printArea, { maxCol: area.lastCol, maxRow: area.lastRow },
        `${sample.id}: the declared print area must be reported as declared`);
      assert.equal(grid.pageSetup.orientation, 'portrait',
        `${sample.id}: the forms print portrait — the PDF must not silently turn one landscape`);
      assert.ok(grid.pageSetup.scale > 0 && grid.pageSetup.scale <= 100,
        `${sample.id}: expected the author's own scale factor`);
      assert.equal(grid.pageSetup.fitToHeight, 1,
        `${sample.id}: the form declares itself a one-page document`);
    }
  }
  assert.ok(withSetup >= 11, `expected 11 of the 12 forms to declare a print setup, saw ${withSetup}`);
});

// The cell map is what places a technician's entered value on the sheet. If
// trimming ever removed a column or row a mapped field points at, that field
// would silently stop appearing in the preview with no error anywhere.
test('no coordinate in cellFor falls outside the trimmed grid, on every sample form',
  { skip: fx ? false : SKIP }, async () => {
    const { cellMapFor } = await import('../server/cell-map.js');
    for (const sample of samples()) {
      const grid = await gridFor(sample);
      const def = await parseWorkbook(sample.path);
      const { cellFor, titleCell, intervalCells } = cellMapFor(def);
      const coords = [
        ...Object.entries(cellFor).map(([k, v]) => [k, v]),
        ...Object.entries(intervalCells).map(([code, v]) => [`interval ${code}`, v]),
        ...(titleCell ? [['title', titleCell]] : [])
      ];
      for (const [label, coord] of coords) {
        assert.ok(coord.col >= 1 && coord.col <= grid.columns.length,
          `${sample.id}: ${label} points at column ${coord.col}, outside the trimmed grid's ${grid.columns.length} columns`);
        assert.ok(coord.row >= 1 && coord.row <= grid.rows.length,
          `${sample.id}: ${label} points at row ${coord.row}, outside the trimmed grid's ${grid.rows.length} rows`);
      }
    }
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
    const total = (row) => row.cells.reduce((sum, c) => sum + spanOf(c).cols, 0);

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
        // A placeholder is not a cell of the document: it holds a column open
        // and states NOTHING else, so a renderer has nothing it could draw.
        assert.deepEqual(Object.keys(cell).sort(), ['col', 'filler'],
          `${sample.id} ${row.index}:${cell.col}: a placeholder must carry only its column and the flag`);
        assert.equal(cell.borders, undefined, `${sample.id} ${row.index}:${cell.col}: a placeholder must carry no borders`);
        assert.equal(cell.fill, undefined, `${sample.id} ${row.index}:${cell.col}: a placeholder must carry no fill`);
        assert.equal(cell.span, undefined, `${sample.id} ${row.index}:${cell.col}: a placeholder must not span`);
      }
      // The distinction that matters downstream: an empty BORDERED cell is a
      // box the form means someone to write in, and is never a placeholder.
      for (const cell of realCells(row)) {
        const bordered = Object.keys(sidesOf(cell)).length > 0;
        assert.ok(cell.text.length > 0 || bordered || spanOf(cell).cols > 1 || spanOf(cell).rows > 1,
          `${sample.id} ${row.index}:${cell.col}: a cell with no text, borders or span should have been flagged as a placeholder`);
      }
    }
  }
  assert.ok(fillers > 0, 'expected the sample forms to need placeholders');
});

// ---------------------------------------------------------------------------
// The document's styling, and the payload discipline that keeps it affordable
// ---------------------------------------------------------------------------
// The preview did not look like the print partly because the model threw this
// away: it reduced a border to a boolean, so the medium frames that separate
// the sections of the form and the thin gridlines inside them arrived
// indistinguishable, and it carried no size, family, fill, vertical alignment
// or wrapping at all.
test('a border keeps its WEIGHT per side, and a side with none says nothing', { skip: fx ? false : SKIP }, async () => {
  const weights = new Set();
  let framed = 0, open = 0;
  for (const sample of samples()) {
    const grid = await gridFor(sample);
    for (const row of grid.rows) {
      for (const cell of row.cells) {
        if (!cell.borders) { open++; continue; }
        for (const [key, style] of Object.entries(cell.borders)) {
          assert.ok(['t', 'r', 'b', 'l'].includes(key), `${sample.id}: unexpected border side "${key}"`);
          assert.equal(typeof style, 'string',
            `${sample.id} ${row.index}:${cell.col}: a border side must name its Excel style, never a boolean`);
          assert.ok(style.length > 0, `${sample.id} ${row.index}:${cell.col}: an empty style is not a border`);
          weights.add(style);
        }
        if (Object.values(cell.borders).includes('medium')) framed++;
      }
    }
  }
  // The documents frame their sections in `medium` against `thin` gridlines.
  // Both must survive, as different values — that contrast IS the hierarchy.
  assert.ok(weights.has('thin'), 'expected thin gridlines to survive');
  assert.ok(weights.has('medium'), 'expected medium section framing to survive');
  assert.ok(framed > 0, 'expected cells framed with a medium border');
  assert.ok(open > 0, 'expected cells the documents leave unbordered to carry no borders key');
});

test('size, family, fill, vertical alignment and wrapping are present where the sheet sets them and absent where it does not',
  { skip: fx ? false : SKIP }, async () => {
    const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
    const cells = grid.rows.flatMap((r) => r.cells).filter((c) => !isFiller(c));

    assert.equal(typeof grid.defaults?.size, 'number', 'the grid must state the sheet\'s own default size');
    assert.equal(typeof grid.defaults?.font, 'string', 'the grid must state the sheet\'s own default family');

    // Present where the document departs from its own baseline...
    const sized = cells.filter((c) => typeof c.size === 'number');
    assert.ok(sized.length > 0, 'expected cells set at a size other than the sheet default');
    assert.ok(sized.every((c) => c.size !== grid.defaults.size),
      'a cell that merely agrees with the sheet default must not repeat it');
    assert.ok(cells.some((c) => typeof c.font === 'string'), 'expected a cell in another family');
    assert.ok(cells.some((c) => c.valign === 'middle' || c.valign === 'top'), 'expected vertical alignment');
    assert.ok(cells.some((c) => c.wrap === true), 'expected wrapped cells');

    // ...and absent everywhere else. `false`/`null` placeholders would defeat
    // the whole point, so absence has to mean absence.
    for (const cell of cells) {
      for (const key of ['size', 'font', 'fill', 'valign', 'wrap', 'bold', 'align', 'span', 'borders']) {
        if (key in cell) {
          assert.notEqual(cell[key], false, `${key} must be omitted rather than written as false`);
          assert.notEqual(cell[key], null, `${key} must be omitted rather than written as null`);
        }
      }
      if ('align' in cell) assert.notEqual(cell.align, 'left', 'the default alignment must be omitted');
      if ('bold' in cell) assert.equal(cell.bold, true, 'only bold cells say so');
    }

    // Every fill in the twelve controlled documents is white — the sheet's own
    // paper. Reporting those would paint an opaque white box over the
    // out-of-scope row tint, so "no shading" is reported as no shading.
    assert.ok(cells.every((c) => c.fill === undefined || c.fill.toUpperCase() !== '#FFFFFF'),
      'white is the paper, not a fill');
  });

test('shading is reported when a sheet genuinely has some', { skip: fx ? false : SKIP }, async () => {
  // Built here rather than taken from a controlled document: none of the
  // twelve shades anything, and this must still be pinned so a form that does
  // is not silently rendered blank. No form content is used.
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'grid-fill-'));
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.getCell('A1').value = 'shaded';
    ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    ws.getCell('B1').value = 'plain';
    ws.getCell('C1').value = 'white';
    ws.getCell('C1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const path = join(dir, 'fill.xlsx');
    await wb.xlsx.writeFile(path);

    const grid = await buildGrid(path);
    const byCol = new Map(grid.rows[0].cells.map((c) => [c.col, c]));
    assert.equal(byCol.get(1).fill, '#D9D9D9', 'a real shade must survive');
    assert.equal(byCol.get(2).fill, undefined, 'an unshaded cell must carry no fill');
    assert.equal(byCol.get(3).fill, undefined, 'white is the paper, not a fill');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- The embedded logo -----------------------------------------------------
//
// Every one of the twelve controlled documents embeds exactly one image, and on
// the printed form it fills the framed box at the top-left of the header. The
// archived record was leaving that box empty, because nothing read the image at
// all. These build their own workbooks — the real logo is form content and is
// never committed here.

const withTempDir = async (prefix, fn) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// A 2x1 PNG, written byte by byte so nothing has to be vendored for a test.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGMQVDJetfsMAAYjApjF8PQBAAAAAElFTkSuQmCC',
  'base64');

test('the one image a form embeds travels with the grid, anchored where the sheet puts it', async () => {
  await withTempDir('grid-image-', async (dir) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.getColumn(1).width = 10;
    ws.getColumn(2).width = 10;
    ws.getRow(1).height = 20;
    ws.getRow(2).height = 40;
    ws.getCell('A1').value = 'header';
    ws.getCell('C3').value = 'body';
    const id = wb.addImage({ buffer: TINY_PNG, extension: 'png' });
    // Anchored across the first two columns and the first two rows, the shape
    // the header box has on all twelve.
    ws.addImage(id, { tl: { col: 0, row: 0 }, br: { col: 2, row: 2 } });
    const path = join(dir, 'logo.xlsx');
    await wb.xlsx.writeFile(path);

    const grid = await buildGrid(path);
    assert.ok(grid.image, 'the grid must carry the embedded image');
    assert.equal(grid.image.mime, 'image/png');
    // The bytes must be the image itself, not a path or a promise of one: the
    // archived PDF has to embed them and the preview has to show them.
    assert.equal(Buffer.from(grid.image.data, 'base64').toString('latin1'), TINY_PNG.toString('latin1'));
    // One-based fractional grid coordinates, so a renderer can interpolate the
    // box straight from the column widths and row heights it already has.
    assert.deepEqual(grid.image.from, { col: 1, row: 1 });
    assert.deepEqual(grid.image.to, { col: 3, row: 3 });
  });
});

test('a form with no image reports none, and buildGrid does not throw', async () => {
  await withTempDir('grid-noimage-', async (dir) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.getCell('A1').value = 'no logo here';
    const path = join(dir, 'plain.xlsx');
    await wb.xlsx.writeFile(path);
    const grid = await buildGrid(path);
    assert.equal(grid.image, null, 'a form with no image must report none, never an empty object');
  });
});

test('every real controlled form carries its logo, anchored inside the grid it is drawn on',
  { skip: fx ? false : SKIP }, async () => {
    for (const sample of samples()) {
      const grid = await gridFor(sample);
      assert.ok(grid.image, `${sample.id} embeds an image and the grid must carry it`);
      assert.match(grid.image.mime, /^image\//, `${sample.id} must report a raster mime type`);
      assert.ok(Buffer.from(grid.image.data, 'base64').length > 0, `${sample.id} must carry real bytes`);
      // The anchor must land on the grid that is actually rendered — an image
      // anchored past the trimmed extent would be drawn off the form.
      const { from, to } = grid.image;
      assert.ok(from.col >= 1 && to.col <= grid.columns.length + 1,
        `${sample.id} image columns ${from.col}..${to.col} must lie inside 1..${grid.columns.length + 1}`);
      assert.ok(from.row >= 1 && to.row <= grid.rows.length + 1,
        `${sample.id} image rows ${from.row}..${to.row} must lie inside 1..${grid.rows.length + 1}`);
      assert.ok(to.col > from.col && to.row > from.row, `${sample.id} image box must have area`);
    }
  });

// --- A merged box's frame --------------------------------------------------

test('a merged box takes its frame from the whole perimeter, not from its anchor alone',
  { skip: fx ? false : SKIP }, async () => {
    // Excel does not keep a merge's outline on its anchor: each covered cell
    // carries the segment of the perimeter along its own edge. The header box
    // that holds the logo on all twelve real documents is exactly this shape —
    // the anchor declares a top and a left, the cell below carries the bottom
    // and the cell beside it the right — so reading the anchor alone drew that
    // box with two of its four sides missing and the record's header did not
    // close on the archived PDF.
    //
    // This is measured on the real forms deliberately: ExcelJS writes ONE style
    // across a whole merge, so a workbook built here cannot express the shape
    // at all (measured — every covered cell comes back with the same border).
    // Only a file Excel itself wrote carries it, and all twelve do. No form
    // content is used: border styles and the box's own geometry, nothing else.
    let boxes = 0;
    for (const sample of samples()) {
      const grid = await gridFor(sample);
      for (const row of grid.rows) {
        for (const cell of realCells(row)) {
          const span = spanOf(cell);
          if (span.rows < 2 || span.cols < 2) continue;
          const sides = sidesOf(cell);
          if (Object.keys(sides).length === 0) continue;
          boxes += 1;
          // A merged box the sheet frames must be framed on ALL FOUR sides.
          // Half a box is not a lighter box; it is a box that does not close.
          assert.deepEqual(Object.keys(sides).sort(), ['b', 'l', 'r', 't'],
            `${sample.id}: the merged box at row ${row.index} col ${cell.col} must report all four sides, got ${JSON.stringify(sides)}`);
        }
      }
    }
    assert.ok(boxes > 0, 'expected the real forms to carry at least one framed merged box');
  });

test('an ordinary cell still reports only its own four sides', async () => {
  await withTempDir('grid-single-', async (dir) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.getCell('A1').value = 'boxed';
    ws.getCell('A1').border = { top: { style: 'thin' }, left: { style: 'medium' } };
    // A neighbour's borders must never leak into it.
    ws.getCell('B1').value = 'next';
    ws.getCell('B1').border = { right: { style: 'thick' }, bottom: { style: 'double' } };
    const path = join(dir, 'single.xlsx');
    await wb.xlsx.writeFile(path);

    const grid = await buildGrid(path);
    const byCol = new Map(grid.rows[0].cells.map((c) => [c.col, c]));
    assert.deepEqual(sidesOf(byCol.get(1)), { t: 'thin', l: 'medium' });
    assert.deepEqual(sidesOf(byCol.get(2)), { r: 'thick', b: 'double' });
  });
});
