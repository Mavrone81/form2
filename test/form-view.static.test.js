// STATIC GUARD ONLY — not a behavioural test.
//
// There is no DOM simulation harness in this project, and this task must
// not add one as a dependency. So instead of exercising renderForm() at
// runtime, this test reads web/js/form-view.js as plain text and asserts
// that it uses textContent (never innerHTML/insertAdjacentHTML/outerHTML/
// document.write) to place cell text. Cell text comes straight from
// spreadsheet files supplied by whoever set up the forms folder and must
// never be interpreted as markup. Passing this test proves the right code
// shape exists in the source; it does NOT prove the table renders correctly
// in a real browser. Verify that by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/js/form-view.js', import.meta.url), 'utf8');

test('form-view.js sets cell text via textContent and never touches innerHTML, insertAdjacentHTML, outerHTML or document.write', () => {
  assert.match(src, /\.textContent\s*=/, 'expected at least one textContent assignment');
  assert.doesNotMatch(src, /\.innerHTML\b/, 'must never use innerHTML on content sourced from spreadsheet files');
  assert.doesNotMatch(src, /insertAdjacentHTML/, 'must never use insertAdjacentHTML on content sourced from spreadsheet files');
  assert.doesNotMatch(src, /\.outerHTML\b/, 'must never use outerHTML on content sourced from spreadsheet files');
  assert.doesNotMatch(src, /document\.write\(/, 'must never use document.write on content sourced from spreadsheet files');
});

test('renderForm receives the record\'s values and where they belong, not just the blank sheet', () => {
  // The reported gap: renderForm rendered the BLANK form, so a machine ID or
  // task status the technician had entered appeared nowhere on the left pane.
  // It must take the entered values AND the server-computed cell map.
  const signature = /export function renderForm\(container,\s*form,\s*\{([\s\S]*?)\}\s*=\s*\{\}\s*\)/.exec(src);
  assert.ok(signature, 'expected renderForm to destructure a named options object');
  for (const opt of ['grid', 'inScopeRows', 'values', 'cellFor', 'titleCell', 'machineId', 'signatures',
    'intervalCells', 'selectedInterval']) {
    assert.match(signature[1], new RegExp(`\\b${opt}\\b`), `renderForm must accept \`${opt}\``);
  }
});

test('an entered value is written as text, never as markup', () => {
  // Entered values are as untrusted as the spreadsheet text around them —
  // both must reach the DOM only through textContent. (The no-unsafe-API
  // assertions above cover the whole file; this pins the specific path that
  // places a value into a cell.)
  const paint = /function paintCell\([\s\S]*?\n\}/.exec(src);
  assert.ok(paint, 'expected a helper that paints a value into a cell');
  assert.match(paint[0], /\.textContent\s*=/, 'the cell painter must assign textContent');
  assert.doesNotMatch(paint[0], /innerHTML|insertAdjacentHTML|outerHTML|document\.write/,
    'the cell painter must never build markup');
});

test('a single field update never re-renders the grid', () => {
  // Typing must not rebuild a 71-row sheet on every keystroke. The live
  // update path must touch one cell and must not call renderForm.
  const update = /export function updatePreviewField\([\s\S]*$/.exec(src);
  assert.ok(update, 'expected an exported single-cell update function');
  assert.doesNotMatch(update[0], /renderForm\(/, 'the live update must not re-render the whole form');
  assert.match(update[0], /paintCell\(/, 'the live update must go through the same cell painter');
});

test('the frequency band is rebuilt from nodes, never from markup', () => {
  // The band gets split into "printed text / a checkbox / the option / more
  // printed text". Splitting a string into parts is exactly where a renderer is
  // tempted to reach for markup, so this pins the one path that does it:
  // elements and text nodes only, and none of the four unsafe DOM APIs
  // anywhere in it.
  const build = /function buildBand\([\s\S]*?\n\}/.exec(src);
  assert.ok(build, 'expected a helper that rebuilds the frequency band with its boxes');
  assert.doesNotMatch(build[0], /\.innerHTML\b/, 'must never use innerHTML');
  assert.doesNotMatch(build[0], /insertAdjacentHTML/, 'must never use insertAdjacentHTML');
  assert.doesNotMatch(build[0], /\.outerHTML\b/, 'must never use outerHTML');
  assert.doesNotMatch(build[0], /document\.write\(/, 'must never use document.write');
  assert.match(build[0], /createTextNode\(/, 'the printed runs must be text nodes');
  const box = /function checkbox\(\)[\s\S]*?\n\}/.exec(src);
  assert.ok(box, 'expected a helper that builds one checkbox');
  assert.match(box[0], /createElement\(/, 'the box itself must be a created element');
  assert.match(box[0], /createElementNS\(/, 'the tick must be a created SVG element, never markup');
});

test('a box is only drawn where the server\'s range still delimits the server\'s option', () => {
  const build = /function buildBand\([\s\S]*?\n\}/.exec(src);
  assert.ok(build, 'expected the frequency-band builder');
  // The reported range must still delimit the reported option in the text this
  // cell actually renders, or nothing is planted over a controlled document.
  assert.match(build[0], /printed\.slice\(start,\s*end\)\s*!==\s*option\.text/,
    'the reported range must be verified against the rendered text before drawing');
});

test('the ticks follow the record\'s interval, and every other box is cleared', () => {
  const mark = /function markInterval\([\s\S]*?\n\}/.exec(src);
  assert.ok(mark, 'expected the frequency-band marker');
  // Every box is visited on every change, so the previous visit's ticks can
  // never be left behind claiming work that was not done on this one.
  assert.match(mark[0], /for \(const \[code, box\] of state\.boxes\)/,
    'the marker must visit every box, not only the one being ticked');
  assert.match(mark[0], /classList\.toggle\('on', on\)/,
    'a box that is not covered by this visit must be cleared, not merely left');
  // Which boxes a visit ticks is the SERVER's answer (cumulative interval
  // scope), never a rule this file works out for itself.
  assert.match(mark[0], /tickedBy\b[\s\S]*?\.includes\(interval\)/,
    'coverage must come from the band the server sent');
});

test('changing the interval never re-renders the grid', () => {
  // Same rule as a single field update: re-ticking the band is a class toggle
  // on boxes that already exist, not a rebuild of a 71-row sheet.
  const update = /export function updatePreviewInterval\([\s\S]*?\n\}/.exec(src);
  assert.ok(update, 'expected an exported single-cell interval update function');
  assert.doesNotMatch(update[0], /renderForm\(/, 'moving the ticks must not re-render the whole form');
  assert.doesNotMatch(update[0], /buildBand\(/, 'moving the ticks must not rebuild the band either');
  assert.match(update[0], /markInterval\(/, 'it must go through the same marker the first render uses');
});

test('nothing in the left pane is an editable control', () => {
  // The left pane reproduces a controlled document. It shows values; it never
  // collects them — which is also what makes an approved (read-only) record
  // render identically to a draft, with no editable surface at all.
  assert.doesNotMatch(src, /createElement\(\s*['"](input|textarea|select|button)['"]\s*\)/i,
    'the left pane must never create an editable control');
  assert.doesNotMatch(src, /contentEditable/i, 'the left pane must never be contenteditable');
});

test('the Pass/Fail mark is resolved by the shared module, not by a second copy of the rule', () => {
  // The preview and the archived PDF must tick the SAME box. Both import
  // calibrationTicks from web/js/sheet-layout.js; a renderer that grew its own
  // answer-to-box rule is exactly how the two would drift apart.
  const pdfSrc = readFileSync(new URL('../server/pdf-record.js', import.meta.url), 'utf8');
  for (const [name, source] of [['form-view.js', src], ['pdf-record.js', pdfSrc]]) {
    assert.match(source, /import \{[^}]*calibrationTicks[^}]*\} from ['"][^'"]*sheet-layout\.js['"]/,
      `${name} imports calibrationTicks from the shared module`);
  }
});

test('a calibration row is cleared before it is marked', () => {
  // An answer changed from Pass to Fail must not leave two ticks behind, which
  // would state that one measurement both passed and failed.
  const fn = /function markCalibrationRow\(state, row\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'markCalibrationRow exists');
  const body = fn[0];
  const clearAt = body.indexOf('replaceChildren()');
  const markAt = body.indexOf('tickMark()');
  assert.ok(clearAt !== -1, 'every box for the row is emptied');
  assert.ok(markAt !== -1, 'the chosen box is then ticked');
  assert.ok(clearAt < markAt, 'the clear happens before the mark');
});

test('changing a Pass/Fail answer never re-renders the grid', () => {
  // Same reasoning as the interval band: this repaints one row's two boxes.
  const fn = /export function updatePreviewField\([\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'updatePreviewField exists');
  assert.match(fn[0], /markCalibrationRow/, 'a calibration answer goes through the per-row mark path');
  assert.ok(!/renderForm\(/.test(fn[0]), 'and never through a full re-render');
});
