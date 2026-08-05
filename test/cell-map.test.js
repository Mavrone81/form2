import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../server/excel-parser.js';
import { buildGrid } from '../server/grid-model.js';
import { cellMapFor, columnNumber, intervalMarksFor } from '../server/cell-map.js';
import { ORDER, findIntervalCodes } from '../server/intervals.js';
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

// --- The frequency band: which printed option this visit's interval is ------
//
// On paper the technician RINGS one option of the band printed above the task
// table, so the preview has to know which run of characters to ring. All the
// prose below is invented: the wording differs between real documents, which
// is precisely why nothing here may match on it.

// Synthetic workbook with a frequency band above the task table. `band` is a
// list of [column, text] pairs on one row, which covers both real shapes —
// one option per cell, or every option inside a single wide cell.
async function writeBandWorkbook(path, { band, freqs = ['1M', '3M', '6M', 'Y'], bandRow = 3 } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getRow(1).getCell(1).value = 'Document Title:';
  ws.getRow(2).getCell(1).value = 'Widget Maintenance Record WX____';
  for (const [col, text] of band) ws.getRow(bandRow).getCell(col).value = text;
  const headerRow = bandRow + 2;
  ws.getRow(headerRow).getCell(1).value = 'No';
  ws.getRow(headerRow).getCell(2).value = 'Freq.';
  ws.getRow(headerRow).getCell(3).value = 'Instruction';
  ws.getRow(headerRow).getCell(4).value = 'Status';
  freqs.forEach((freq, i) => {
    const row = ws.getRow(headerRow + 1 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = freq;
    row.getCell(3).value = `Check the widget assembly, step ${i + 1}`;
  });
  await wb.xlsx.writeFile(path);
  return path;
}

const inTempDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'cellmap-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('a band that prints each option in its own cell resolves to that whole cell (synthetic)', async () => {
  await inTempDir(async (dir) => {
    const path = await writeBandWorkbook(join(dir, 'separate.xlsx'), {
      band: [[4, 'Quarterly (3M)'], [8, 'Half-yearly (6M)'], [12, 'Annual (Y)']],
      freqs: ['3M', '6M', 'Y']
    });
    const def = await parseWorkbook(path);
    const { intervalCells } = cellMapFor(def);

    // Each interval is a DIFFERENT cell, and the whole of that cell is the
    // option — there is nothing else printed in it to leave outside the ring.
    assert.deepEqual(intervalCells['3M'], { row: 3, col: 4, start: 0, end: 14, text: 'Quarterly (3M)' });
    assert.deepEqual(intervalCells['6M'], { row: 3, col: 8, start: 0, end: 16, text: 'Half-yearly (6M)' });
    assert.deepEqual(intervalCells.Y, { row: 3, col: 12, start: 0, end: 10, text: 'Annual (Y)' });
    // Selecting another interval must move the mark to another cell.
    assert.notEqual(intervalCells['3M'].col, intervalCells['6M'].col);
    assert.notEqual(intervalCells['6M'].col, intervalCells.Y.col);
  });
});

test('a band that prints every option in one cell resolves to a range inside it (synthetic)', async () => {
  await inTempDir(async (dir) => {
    const text = 'Monthly (1M)     Quarterly (3M)     Half-yearly (6M)     Annual (Y)';
    const path = await writeBandWorkbook(join(dir, 'merged.xlsx'), { band: [[3, text]] });
    const def = await parseWorkbook(path);
    const { intervalCells } = cellMapFor(def);

    // Every interval is the SAME cell...
    for (const code of ORDER) assert.deepEqual(
      { row: intervalCells[code].row, col: intervalCells[code].col }, { row: 3, col: 3 }, code
    );
    // ...and the range is what tells them apart. Slicing the cell's own text
    // with the range must yield exactly that option and nothing of its
    // neighbours — this is the assertion, not the reported text.
    assert.equal(text.slice(intervalCells['1M'].start, intervalCells['1M'].end), 'Monthly (1M)');
    assert.equal(text.slice(intervalCells['3M'].start, intervalCells['3M'].end), 'Quarterly (3M)');
    assert.equal(text.slice(intervalCells['6M'].start, intervalCells['6M'].end), 'Half-yearly (6M)');
    assert.equal(text.slice(intervalCells.Y.start, intervalCells.Y.end), 'Annual (Y)');
    // The ranges are disjoint, so no two options can ever be ringed together.
    const ranges = ORDER.map((c) => intervalCells[c]).sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i += 1) assert.ok(ranges[i - 1].end <= ranges[i].start);
  });
});

test('a caption printed before the first option is left outside the ring (synthetic)', async () => {
  // An option is separated from what precedes it by a GAP, not by being first
  // in the cell. A cell that opens with a caption must ring the option only —
  // ringing the caption too would put a ring round words the technician is
  // not choosing.
  await inTempDir(async (dir) => {
    const text = 'Frequency:     Monthly (1M)     Quarterly (3M)';
    const path = await writeBandWorkbook(join(dir, 'caption.xlsx'), {
      band: [[3, text]], freqs: ['1M', '3M']
    });
    const { intervalCells } = cellMapFor(await parseWorkbook(path));
    assert.equal(text.slice(intervalCells['1M'].start, intervalCells['1M'].end), 'Monthly (1M)');
    assert.equal(text.slice(intervalCells['3M'].start, intervalCells['3M'].end), 'Quarterly (3M)');
  });
});

test('the match is on the parenthesised code, never on the wording (synthetic)', async () => {
  // Two documents, the same interval, different prose. Both must resolve, and
  // each must ring its OWN wording.
  await inTempDir(async (dir) => {
    const variants = [
      'Monthly (1M)     Quarterly (3M)     Half-yearly (6M)',
      'Monthly (1M)     Trimestral (3M)     Semestral (6M)'
    ];
    const marked = [];
    for (const [i, text] of variants.entries()) {
      const path = await writeBandWorkbook(join(dir, `prose-${i}.xlsx`), {
        band: [[3, text]], freqs: ['1M', '3M', '6M']
      });
      const { intervalCells } = cellMapFor(await parseWorkbook(path));
      assert.ok(intervalCells['3M'], 'the three-monthly option must resolve whatever it is called');
      marked.push(text.slice(intervalCells['3M'].start, intervalCells['3M'].end));
    }
    assert.deepEqual(marked, ['Quarterly (3M)', 'Trimestral (3M)']);
    assert.notEqual(marked[0], marked[1], 'the wording genuinely differs between the two');
  });
});

test('an interval the form does not offer resolves to nothing, and does not throw (synthetic)', async () => {
  await inTempDir(async (dir) => {
    // (a) The band simply does not print a yearly option — the shape one of
    // the twelve real documents has.
    const noYearly = await writeBandWorkbook(join(dir, 'no-yearly.xlsx'), {
      band: [[3, 'Monthly (1M)     Quarterly (3M)     Half-yearly (6M)']],
      freqs: ['1M', '3M', '6M']
    });
    const a = cellMapFor(await parseWorkbook(noYearly)).intervalCells;
    assert.equal(a.Y, undefined, 'no yearly option is printed, so there is no position to report');
    assert.ok(a['6M'], 'the options that ARE printed still resolve');

    // (b) The band prints an option this document has no tasks for. Still
    // nothing: the record can never be scoped to it.
    const notOffered = await writeBandWorkbook(join(dir, 'not-offered.xlsx'), {
      band: [[3, 'Monthly (1M)     Quarterly (3M)     Annual (Y)']],
      freqs: ['1M', '3M']
    });
    const b = cellMapFor(await parseWorkbook(notOffered)).intervalCells;
    assert.equal(b.Y, undefined);
    assert.ok(b['1M'] && b['3M']);

    // (c) A form with no band at all, and a definition with nothing in it,
    // are both answered with an empty map rather than an exception.
    const noBand = await writeSyntheticWorkbook(join(dir, 'no-band.xlsx'));
    assert.deepEqual(cellMapFor(await parseWorkbook(noBand)).intervalCells, {});
    assert.deepEqual(intervalMarksFor(undefined), {});
    assert.deepEqual(intervalMarksFor({}), {});
    assert.deepEqual(intervalMarksFor({ frequencies: ['Y'], cells: {} }), {});
  });
});

test('the band is found by its codes, not by a fixed row or column (synthetic)', async () => {
  // Positions shift between documents, so nothing here may assume row 4 or
  // column 3 — and an earlier row that mentions no code must not be mistaken
  // for the band.
  await inTempDir(async (dir) => {
    const path = await writeBandWorkbook(join(dir, 'shifted.xlsx'), {
      band: [[7, 'Monthly (1M)     Quarterly (3M)']], freqs: ['1M', '3M'], bandRow: 9
    });
    const { intervalCells } = cellMapFor(await parseWorkbook(path));
    assert.deepEqual(
      { row: intervalCells['3M'].row, col: intervalCells['3M'].col }, { row: 9, col: 7 }
    );
  });
});

// --- The same, against the real controlled documents -----------------------

test('every interval a real form offers is ringed on a cell the grid renders, at a range that slices to that option',
  { skip: fx ? false : SKIP }, async () => {
    let separateCellForms = 0, mergedCellForms = 0, bandsShortOfAnOption = 0, printedButNotOffered = 0;

    for (const f of fx.forms) {
      const path = join(fx.formsDir, f.file);
      const def = await parseWorkbook(path);
      const { intervalCells } = cellMapFor(def);
      const grid = await buildGrid(path, def);
      const rendered = new Map();
      for (const row of grid.rows) for (const cell of row.cells) rendered.set(`${row.index}:${cell.col}`, cell.text);

      // What this document's band actually prints, read from the definition
      // rather than assumed, so the two "nothing to report" cases below are
      // measured against the real sheet.
      const printed = new Set(
        (def.cells.frequencyBand ?? []).flatMap((c) => findIntervalCodes(c.text).map((m) => m.code))
      );
      if (printed.size < ORDER.length) bandsShortOfAnOption += 1;
      for (const code of ORDER) {
        if (printed.has(code) && !def.frequencies.includes(code)) {
          printedButNotOffered += 1;
          assert.equal(intervalCells[code], undefined,
            `${f.id} prints ${code} but has no tasks for it, so it must not be markable`);
        }
        if (!printed.has(code)) assert.equal(intervalCells[code], undefined,
          `${f.id} does not print ${code}, so no position may be invented for it`);
      }

      const cells = new Set();
      for (const code of ORDER) {
        const mark = intervalCells[code];
        if (!mark) continue;
        assert.ok(def.frequencies.includes(code), `${f.id} must not mark an interval it does not offer`);
        const coord = `${mark.row}:${mark.col}`;
        // The cell must be one the preview actually draws, or there would be
        // nowhere on screen for the ring to go.
        assert.ok(rendered.has(coord), `${f.id} ${code} -> ${coord} is not a rendered cell`);
        // THE assertion: slicing the text the grid renders with the reported
        // range yields exactly the option, ending in that option's own code.
        const sliced = rendered.get(coord).slice(mark.start, mark.end);
        assert.equal(sliced, mark.text, `${f.id} ${code} range must delimit the reported option`);
        assert.match(sliced, new RegExp(`\\(${code}\\)$`), `${f.id} ${code} range must end at its own code`);
        assert.doesNotMatch(sliced.slice(0, -`(${code})`.length), /\((?:1M|3M|6M|Y)\)/,
          `${f.id} ${code} range must not swallow a neighbouring option`);
        cells.add(coord);
      }

      // Both real shapes must be exercised by this loop, and each form is one
      // or the other: every option in one cell, or each in a cell of its own.
      const marked = ORDER.filter((c) => intervalCells[c]);
      if (marked.length > 1 && cells.size === 1) mergedCellForms += 1;
      if (marked.length > 1 && cells.size === marked.length) {
        separateCellForms += 1;
        // Whole-cell shape: nothing else is printed in the cell, so the range
        // covers all of it.
        for (const code of marked) {
          const mark = intervalCells[code];
          assert.equal(mark.start, 0, `${f.id} ${code} starts at the cell`);
          assert.equal(mark.end, rendered.get(`${mark.row}:${mark.col}`).length, `${f.id} ${code} ends at the cell`);
        }
      }
    }

    assert.ok(mergedCellForms > 0, 'expected forms whose band is one merged cell');
    assert.ok(separateCellForms > 0, 'expected a form whose band is separate cells');
    assert.ok(bandsShortOfAnOption > 0, 'expected a band that does not print all four options');
    assert.ok(printedButNotOffered > 0, 'expected a band printing an option its form has no tasks for');
  });

test('a real form resolves an interval by its code even though the wording differs between documents',
  { skip: fx ? false : SKIP }, async () => {
    // Same code, more than one prose form across the twelve. If matching were
    // on the wording, one of these groups would come back empty.
    const wordings = new Map();
    for (const f of fx.forms) {
      const { intervalCells } = cellMapFor(await parseWorkbook(join(fx.formsDir, f.file)));
      const mark = intervalCells['3M'];
      if (!mark) continue;
      assert.match(mark.text, /\(3M\)$/);
      wordings.set(mark.text, (wordings.get(mark.text) ?? 0) + 1);
    }
    assert.ok(wordings.size >= 2,
      'expected at least two different wordings for the same code, all resolved');
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

// --- The Parts Required table ----------------------------------------------

test('every blank parts row maps its four cells to the columns the sheet prints them in (real forms)',
  { skip: fx ? false : SKIP }, async () => {
    for (const f of fx.forms) {
      const def = await parseWorkbook(join(fx.formsDir, f.file));
      const { cellFor } = cellMapFor(def);
      const { rows, columns } = def.parts;

      const partKeys = Object.keys(cellFor).filter((k) => k.startsWith('part_'));
      assert.equal(partKeys.length, rows.length * 4, `${f.id} maps four cells per parts row`);

      for (const r of rows) {
        assert.deepEqual(cellFor[`part_${r}_no`], { row: r, col: columns.no }, `${f.id} r${r} part no`);
        assert.deepEqual(cellFor[`part_${r}_desc`], { row: r, col: columns.desc }, `${f.id} r${r} description`);
        assert.deepEqual(cellFor[`part_${r}_qty`], { row: r, col: columns.qty }, `${f.id} r${r} qty`);
        assert.deepEqual(cellFor[`part_${r}_remarks`], { row: r, col: columns.remarks }, `${f.id} r${r} remarks`);
      }
    }
  });

test('the reference form maps its parts table to the exact cells the document prints',
  { skip: fx ? false : SKIP }, async () => {
    // Pinned against one real document rather than only against the parser's
    // own report, so a change of column detection cannot move every value four
    // columns left and still agree with itself.
    const ref = fx.forms.find((f) => f.id === 'F01') ?? fx.forms[0];
    const def = await parseWorkbook(join(fx.formsDir, ref.file));
    assert.deepEqual(def.parts.columns, { no: 4, desc: 7, qty: 12, remarks: 13 });
    assert.equal(def.parts.rows.length, 5, 'the reference form prints five ruled parts rows');

    const { cellFor } = cellMapFor(def);
    const first = def.parts.rows[0];
    assert.deepEqual(cellFor[`part_${first}_no`], { row: first, col: 4 });
    assert.deepEqual(cellFor[`part_${first}_qty`], { row: first, col: 12 });
    assert.equal(Object.keys(cellFor).filter((k) => k.startsWith('part_')).length, 20);
  });

test('a form with no parts table maps no parts cells and does not throw', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cellmap-'));
  try {
    const path = await writeSyntheticWorkbook(join(dir, 'no-parts.xlsx'));
    const { cellFor } = cellMapFor(await parseWorkbook(path));
    assert.deepEqual(Object.keys(cellFor).filter((k) => k.startsWith('part_')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cellMapFor tolerates a definition with a malformed parts table', () => {
  // Pure-function guard: a parts table whose rows or columns are not integers
  // must produce no coordinates rather than {row: undefined, col: NaN}.
  const { cellFor } = cellMapFor({
    tasks: [], cells: {},
    parts: { headerRow: 3, columns: { no: 'D', desc: null, qty: 12, remarks: 13 }, rows: [4, 'five', null] }
  });
  assert.deepEqual(Object.keys(cellFor).filter((k) => k.startsWith('part_')), ['part_4_qty', 'part_4_remarks']);
  assert.deepEqual(cellMapFor({ parts: null }).cellFor, {});
});
