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
