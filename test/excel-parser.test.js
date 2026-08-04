import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseWorkbook } from '../server/excel-parser.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const fx = loadFixtures();

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
