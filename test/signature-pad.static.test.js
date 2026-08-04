// STATIC GUARD ONLY — not a behavioural test.
//
// There is no DOM / canvas / Pointer Events simulation harness in this
// project, and this task must not add one as a dependency. So instead of
// exercising createSignaturePad() at runtime, these tests read
// web/js/signature-pad.js and web/css/app.css as plain text and assert
// that the safety-critical properties the task brief requires are present
// in the source. Passing these tests proves the right code shapes exist on
// the page; it does NOT prove the pad draws correctly, that pressure maps
// to a sane line width, or that a resize actually preserves pixels on a
// real device. Verify those by hand (see task-13-report.md) or with a
// future browser-based test harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/js/signature-pad.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');

test('canvas disables browser touch gestures so a stylus draws instead of scrolling the page', () => {
  // Must be the canvas inside .sig specifically, not some unrelated rule.
  const rule = /\.sig canvas\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'expected a ".sig canvas" rule in app.css');
  assert.match(rule[1], /touch-action:\s*none/);
});

test('toPNG() has a code path that returns null when nothing has been drawn', () => {
  // The submit workflow refuses to accept a signature unless toPNG() is
  // non-null; a blank-but-real data URL would defeat that guard. Look for
  // the dirty-flag-gated null branch.
  assert.match(src, /toPNG:\s*\(\)\s*=>\s*\(dirty\s*\?\s*canvas\.toDataURL\([^)]*\)\s*:\s*null\)/);
});

test('drawing is wired through Pointer Events, not legacy mouse-only events', () => {
  // One code path for mouse, finger and stylus requires Pointer Events.
  for (const evt of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.match(src, new RegExp(`addEventListener\\(\\s*['"]${evt}['"]`));
  }
  // Guard against regressing to separate mouse/touch handling.
  assert.doesNotMatch(src, /addEventListener\(\s*['"]mousedown['"]/);
  assert.doesNotMatch(src, /addEventListener\(\s*['"]touchstart['"]/);
});

test('pressure drives stroke width, with a fallback when the device only reports the default 0.5', () => {
  assert.match(src, /e\.pressure/);
  assert.match(src, /!==\s*0\.5/);
});

test('resize path snapshots the canvas before resizing and redraws it after, so an in-progress signature is not wiped', () => {
  // Order matters: the snapshot must be taken before canvas.width/height
  // are reassigned, because assigning either property clears the bitmap.
  const fitBody = /function fit\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(fitBody, 'expected a fit() function in signature-pad.js');
  const body = fitBody[1];
  const snapshotIdx = body.indexOf('toDataURL');
  const widthAssignIdx = body.indexOf('canvas.width =');
  assert.ok(snapshotIdx !== -1, 'expected a canvas.toDataURL() snapshot in fit()');
  assert.ok(widthAssignIdx !== -1, 'expected canvas.width to be reassigned in fit()');
  assert.ok(snapshotIdx < widthAssignIdx, 'snapshot must be taken before canvas.width is reassigned');
  assert.match(body, /drawImage/, 'expected the snapshot to be redrawn back onto the canvas');
});

test('isEmpty() reflects the same dirty flag that clear() resets', () => {
  assert.match(src, /isEmpty:\s*\(\)\s*=>\s*!dirty/);
  assert.match(src, /const clear = \(\) => \{[^}]*dirty = false/);
});

test('the canvas is keyboard-focusable and has an accessible label', () => {
  assert.match(src, /canvas\.tabIndex\s*=\s*0/);
  assert.match(src, /setAttribute\(\s*['"]aria-label['"]/);
});
