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

test('resize path restores the signature with a SYNCHRONOUS drawImage — no Image()/onload round trip', () => {
  // Regression guard for the Critical finding: an async restore
  // (toDataURL() -> new Image() -> onload -> drawImage) leaves a window in
  // which a second resize (a burst from a window drag, or an
  // orientationchange firing multiple resize events) can run before the
  // first restore lands, snapshot an already-blank canvas, and permanently
  // erase the signature while `dirty` stays true — the pad then lies about
  // having a signature. A synchronous drawImage() from an offscreen backing
  // canvas closes that window entirely: nothing async, nothing to race.
  assert.doesNotMatch(src, /new Image\(/, 'must not reintroduce the async Image()/onload restore path');
  assert.doesNotMatch(src, /\.onload\s*=/, 'must not reintroduce an async onload restore callback');

  const fitBody = /function fit\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(fitBody, 'expected a fit() function in signature-pad.js');
  const body = fitBody[1];
  assert.match(body, /ctx\.drawImage\(\s*backing\s*,/, 'fit() must restore synchronously from the backing canvas');
});

test('resize restore preserves aspect ratio with a single uniform scale, and stays synchronous', () => {
  // STATIC GUARD ONLY: there is no DOM/canvas harness in this project, so
  // this cannot exercise fit() against a real non-uniformly-resized canvas
  // and check actual pixels. It only proves the right code shape is present
  // — that fit() computes ONE scale factor (via Math.min, so the smaller of
  // the two axis ratios wins) and applies it to both axes, instead of
  // stretching width and height independently. It does NOT prove a real
  // tablet rotation or 375/768/1024 breakpoint hop renders an undistorted
  // signature on screen. Verify that by hand.
  const fitBody = /function fit\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(fitBody, 'expected a fit() function in signature-pad.js');
  const body = fitBody[1];

  // Uniform scale: a single Math.min(...) computation feeding both the
  // width and height destination extents, not two independent ratios.
  assert.match(body, /Math\.min\(/, 'fit() must compute a uniform scale via Math.min, not stretch each axis independently');

  // Still no async restore path reintroduced.
  assert.doesNotMatch(body, /new Image\(/, 'fit() must not reintroduce an async Image()/onload restore path');
  assert.doesNotMatch(body, /\.onload\s*=/, 'fit() must not reintroduce an async onload restore callback');
  assert.doesNotMatch(body, /toDataURL/, 'fit() must not read via toDataURL() — that belongs only in toPNG()');
});

test('completed stroke segments are committed to an offscreen backing canvas synchronously', () => {
  // The backing canvas is what fit() restores from. It must be kept
  // up to date synchronously, in the same call stack as the stroke that
  // produced it — not deferred — or a resize landing between a stroke and
  // a later sync could still restore stale content.
  assert.match(src, /const backing = document\.createElement\(\s*['"]canvas['"]\s*\)/);
  assert.match(src, /backingCtx\.drawImage\(\s*canvas\s*,/, 'expected the backing canvas to be synced from the visible canvas');
  // Called from within the pointermove handler, not from a callback/promise.
  const pointermove = /addEventListener\(\s*['"]pointermove['"][\s\S]*?\}\);/.exec(src);
  assert.ok(pointermove, 'expected a pointermove handler');
  assert.match(pointermove[0], /syncBacking\(\)/, 'expected the pointermove handler to sync the backing canvas synchronously');
});

test('resize scheduling is deduped: a pending animation frame is cancelled before scheduling a new one', () => {
  // Findings 1/2's real fix is the synchronous restore above; this dedup is
  // the accompanying hygiene fix so a resize burst does not pile up
  // redundant fit() calls.
  assert.match(src, /cancelAnimationFrame\(/, 'expected cancelAnimationFrame to appear alongside requestAnimationFrame');
  assert.match(src, /requestAnimationFrame\(/);
});

test('clear() empties the backing canvas too, not just the visible one', () => {
  // Otherwise Clear followed by a resize would resurrect the cleared
  // signature from a stale backing copy.
  const clearBody = /const clear = \(\) => \{([\s\S]*?)\};/.exec(src);
  assert.ok(clearBody, 'expected a clear() implementation');
  assert.match(clearBody[1], /backingCtx\.clearRect/);
});

test('isEmpty() reflects the same dirty flag that clear() resets', () => {
  assert.match(src, /isEmpty:\s*\(\)\s*=>\s*!dirty/);
  assert.match(src, /const clear = \(\) => \{[^}]*dirty = false/);
});

test('the canvas is keyboard-focusable and has an accessible label', () => {
  assert.match(src, /canvas\.tabIndex\s*=\s*0/);
  assert.match(src, /setAttribute\(\s*['"]aria-label['"]/);
});

test('the pad exposes destroy() to remove the window resize listener and stop leaking', () => {
  // Every record open recreates a pad. Without a teardown, the window
  // resize listener added at module scope keeps the whole closure (both
  // canvases, both contexts, DOM nodes) alive forever, once per pad ever
  // created in the session.
  const returned = /return\s*\{([\s\S]*?)\n  \};/.exec(src);
  assert.ok(returned, 'expected the module to return an object literal');
  assert.match(returned[1], /destroy:/, 'expected the returned object to expose destroy()');
  assert.match(src, /removeEventListener\(\s*['"]resize['"]/, 'destroy() must remove the resize listener it added');
});
