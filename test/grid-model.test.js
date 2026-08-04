import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildGrid } from '../server/grid-model.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const fx = loadFixtures();

test('grid carries merges, widths and text', { skip: fx ? false : SKIP }, async () => {
  const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
  assert.ok(grid.columns.length > 5);
  assert.ok(grid.rows.length > 20);
  const merged = grid.rows.flatMap((r) => r.cells).filter((c) => c.span.cols > 1);
  assert.ok(merged.length > 0, 'expected merged cells');
  const allText = grid.rows.flatMap((r) => r.cells).map((c) => c.text).join(' ');
  assert.match(allText, /Instruction/);
});

test('cells hidden by a merge are omitted', { skip: fx ? false : SKIP }, async () => {
  const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
  for (const row of grid.rows) {
    const cols = row.cells.map((c) => c.col);
    assert.deepEqual(cols, [...new Set(cols)], 'no duplicate columns in a row');
  }
});
