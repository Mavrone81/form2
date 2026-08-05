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
  for (const opt of ['grid', 'inScopeRows', 'values', 'cellFor', 'titleCell', 'machineId', 'signatures']) {
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

test('nothing in the left pane is an editable control', () => {
  // The left pane reproduces a controlled document. It shows values; it never
  // collects them — which is also what makes an approved (read-only) record
  // render identically to a draft, with no editable surface at all.
  assert.doesNotMatch(src, /createElement\(\s*['"](input|textarea|select|button)['"]\s*\)/i,
    'the left pane must never create an editable control');
  assert.doesNotMatch(src, /contentEditable/i, 'the left pane must never be contenteditable');
});
