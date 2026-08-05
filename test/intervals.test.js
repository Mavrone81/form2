import test from 'node:test';
import assert from 'node:assert/strict';
import { covers, tasksInScope, scopeSummary, ORDER } from '../server/intervals.js';

const T = (no, freq) => ({ no, freq, instruction: `task ${no}`, row: no + 10 });
// Shape of sample form F01: 14 x 3M, 3 x 6M, 1 x Y.
const F01 = [...Array(14)].map((_, i) => T(i + 1, '3M'))
  .concat([T(15, '6M'), T(16, '6M'), T(17, '6M'), T(18, 'Y')]);

test('order runs shortest to longest', () => {
  assert.deepEqual(ORDER, ['1M', '3M', '6M', 'Y']);
});

test('an interval covers itself and every shorter one', () => {
  assert.equal(covers('Y', '3M'), true);
  assert.equal(covers('Y', 'Y'), true);
  assert.equal(covers('6M', '3M'), true);
  assert.equal(covers('3M', '6M'), false);
  assert.equal(covers('1M', '3M'), false);
});

test('a yearly service pulls in the 3M and 6M work', () => {
  // The regression this whole module exists to prevent: a plain filter
  // would return 1 task and drop 17 required checks off a signed record.
  assert.equal(tasksInScope(F01, 'Y').length, 18);
  assert.equal(tasksInScope(F01, '6M').length, 17);
  assert.equal(tasksInScope(F01, '3M').length, 14);
  assert.equal(tasksInScope(F01, '1M').length, 0);
});

test('scope summary breaks the total down by frequency', () => {
  assert.deepEqual(scopeSummary(F01, '6M'), {
    total: 17, byFreq: { '3M': 14, '6M': 3 }
  });
});

test('unknown frequency values are excluded rather than throwing', () => {
  assert.equal(tasksInScope([T(1, 'WEEKLY')], 'Y').length, 0);
});
