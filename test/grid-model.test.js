import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildGrid } from '../server/grid-model.js';
import { parseWorkbook } from '../server/excel-parser.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const fx = loadFixtures();

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
