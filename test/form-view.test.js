// Behavioural tests for the one part of the left-pane renderer that is pure:
// filling the machine ID into the blank the printed title leaves for it.
//
// web/js/form-view.js touches `document` only inside function bodies, so it
// imports cleanly under node:test without a DOM harness (this project has
// none, deliberately — no build step, no framework). The rendering itself is
// still covered only by the static guard in form-view.static.test.js plus
// hand verification in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillTitleBlank } from '../web/js/form-view.js';

test('a machine ID fills the blank the title leaves for it', () => {
  assert.equal(
    fillTitleBlank('Widget Maintenance Record WX____', '03'),
    'Widget Maintenance Record WX03'
  );
});

test('a machine ID that repeats the code before the blank does not double it', () => {
  // A technician typing the whole machine ID must not produce "WXWX03".
  assert.equal(
    fillTitleBlank('Widget Maintenance Record WX____', 'WX03'),
    'Widget Maintenance Record WX03'
  );
  // Case and punctuation in the typed value are not required to match.
  assert.equal(
    fillTitleBlank('Widget Maintenance Record WX____', 'wx-03'),
    'Widget Maintenance Record wx-03'
  );
});

test('a title with no blank is left exactly as printed', () => {
  // Four of the twelve controlled documents name the machine in the title
  // outright. A title that does not ask for a machine ID must never grow
  // one appended to the end.
  const printed = 'Widget Maintenance Record WX01';
  assert.equal(fillTitleBlank(printed, 'WX07'), printed);
  assert.equal(fillTitleBlank('Widget Maintenance Record', 'WX07'), 'Widget Maintenance Record');
});

test('a blank stays a blank until a machine ID is entered', () => {
  const printed = 'Widget Maintenance Record WX____';
  assert.equal(fillTitleBlank(printed, ''), printed);
  assert.equal(fillTitleBlank(printed, '   '), printed);
  assert.equal(fillTitleBlank(printed, null), printed);
  assert.equal(fillTitleBlank(printed, undefined), printed);
});

test('blanks of any length are filled, and a lone underscore is not treated as one', () => {
  assert.equal(fillTitleBlank('Record KW___', '5'), 'Record KW5');
  assert.equal(fillTitleBlank('Record MB_____', '5'), 'Record MB5');
  assert.equal(fillTitleBlank('Record______', '5'), 'Record5');
  // A single underscore is far more likely to be part of a name than a
  // ruled blank, so it is left alone.
  assert.equal(fillTitleBlank('Record WX_1', '5'), 'Record WX_1');
});

test('a whole word before the blank is never swallowed', () => {
  // Only a short code (up to four non-space characters) may be dropped as a
  // repeated prefix. "Record" must survive whatever is typed.
  assert.equal(fillTitleBlank('E-Test Maintenance Record______', 'MB03.1'),
    'E-Test Maintenance RecordMB03.1');
  assert.equal(fillTitleBlank('E-Test Maintenance Record______', 'Recorder 9'),
    'E-Test Maintenance RecordRecorder 9');
});

test('text after the blank is preserved', () => {
  assert.equal(fillTitleBlank('Record ED____ (line 2)', '04'), 'Record ED04 (line 2)');
});

test('the printed title is never mutated, only the returned copy', () => {
  const printed = 'Record ED____';
  const filled = fillTitleBlank(printed, '04');
  assert.equal(printed, 'Record ED____');
  assert.notEqual(filled, printed);
});
