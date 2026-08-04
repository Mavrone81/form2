// STATIC GUARD ONLY — not a behavioural test.
//
// There is no DOM simulation harness in this project, and this task must
// not add one as a dependency (no build step, no framework, no bundler —
// plain ES modules loaded directly by the browser). So instead of exercising
// renderFields()/the app controller at runtime, these tests read the web/js/
// sources as plain text and assert that the required code shapes are
// present. Passing these tests proves the right code shapes exist; it does
// NOT prove the right pane renders correctly in a real browser, that a
// signature pad actually draws, or that the sign-off chain genuinely works
// end to end. That was verified by hand against a running server — see
// task-14-report.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const jsDir = fileURLToPath(new URL('../web/js/', import.meta.url));
const jsFiles = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const sources = new Map(jsFiles.map((f) => [f, readFileSync(jsDir + f, 'utf8')]));

const appSrc = sources.get('app.js');
const fieldPanelSrc = sources.get('field-panel.js');
assert.ok(appSrc, 'expected web/js/app.js to exist');
assert.ok(fieldPanelSrc, 'expected web/js/field-panel.js to exist');

test('no file under web/js/ ever uses innerHTML, insertAdjacentHTML, outerHTML or document.write', () => {
  // Field labels and cell text originate in spreadsheet files supplied by
  // whoever set up the forms folder and must never be interpreted as
  // markup. All text must go through textContent instead. This checks every
  // .js file under web/js/, not just one module, so a new file added later
  // (e.g. a future admin.js) is covered automatically.
  for (const [name, src] of sources) {
    assert.doesNotMatch(src, /\.innerHTML\b/, `${name} must never use innerHTML`);
    assert.doesNotMatch(src, /insertAdjacentHTML/, `${name} must never use insertAdjacentHTML`);
    assert.doesNotMatch(src, /\.outerHTML\b/, `${name} must never use outerHTML`);
    assert.doesNotMatch(src, /document\.write\(/, `${name} must never use document.write`);
  }
});

test('at least one file under web/js/ actually sets text via textContent', () => {
  // Guards against the previous test passing vacuously because nothing
  // renders any text at all.
  const anyTextContent = [...sources.values()].some((src) => /\.textContent\s*=/.test(src));
  assert.ok(anyTextContent, 'expected at least one textContent assignment somewhere under web/js/');
});

test('every signature pad this app creates is torn down before being replaced (destroy() is called)', () => {
  // Hard requirement: createSignaturePad() registers a window resize
  // listener. The right pane re-renders on every frequency change and after
  // every save/sign, so without teardown each re-render leaks a listener and
  // a dead canvas. field-panel.js must call destroy() on the previously
  // created pad before (or as part of) creating a new one.
  assert.match(fieldPanelSrc, /createSignaturePad\(/, 'expected field-panel.js to create signature pads');
  assert.match(fieldPanelSrc, /\.destroy\(\)/, 'expected field-panel.js to call destroy() on a pad it created');
  // The teardown must happen at the top of every render (before a new pad
  // can possibly be created in that same call), not only on an unrelated
  // code path.
  const renderFieldsBody = /export function renderFields\([\s\S]*?\n\{[\s\S]*/.exec(fieldPanelSrc) ||
    /export function renderFields\(container[\s\S]*/.exec(fieldPanelSrc);
  assert.ok(renderFieldsBody, 'expected an exported renderFields function');
  assert.match(
    fieldPanelSrc,
    /function\s+teardownActivePad\s*\([^)]*\)\s*\{[\s\S]*?\.destroy\(\)/,
    'expected a teardown helper that calls destroy() on the tracked pad'
  );
  assert.match(
    renderFieldsBody[0],
    /teardownActivePad\(\)/,
    'expected renderFields() to tear down the previous pad before rendering a new one'
  );
});

test('navigating away from an open form also tears down the active signature pad', () => {
  // Without this, leaving a form mid-signature (back to the picker) never
  // triggers another renderFields() call to run the teardown above, so the
  // resize listener would leak on that path too.
  assert.match(fieldPanelSrc, /export function teardownFieldPanel/, 'expected field-panel.js to export a teardown function');
  assert.match(appSrc, /teardownFieldPanel\(/, 'expected app.js to call the field-panel teardown when navigating away');
});

test('the submit path checks for a null signature before calling the sign API', () => {
  // Signature required: pad.toPNG() returns null when nothing has been
  // drawn. If it is null, the app must show "Sign before submitting." and
  // must NOT call the API. This checks the ordering: the null check appears
  // before the api.sign(...) call in source, not after.
  const pngIdx = appSrc.indexOf('toPNG()');
  assert.ok(pngIdx >= 0, 'expected app.js to call pad.toPNG()');
  const nullCheckMatch = /if\s*\(\s*!png\s*\)/.exec(appSrc);
  assert.ok(nullCheckMatch, 'expected an "if (!png)" guard in app.js');
  const signCallIdx = appSrc.indexOf('api.sign(');
  assert.ok(signCallIdx >= 0, 'expected app.js to call api.sign(...)');
  assert.ok(
    pngIdx < nullCheckMatch.index && nullCheckMatch.index < signCallIdx,
    'expected the order: read toPNG() -> check for null -> only then call api.sign()'
  );
  assert.match(appSrc, /Sign before submitting\./, 'expected the exact warning text when unsigned');
});

test('submit is never gated on unfilled tasks — only on a missing signature', () => {
  // Warn, never block: the API's completeness {inScope, filled, missing[]}
  // is advisory only. Submitting must still work with in-scope tasks left
  // blank, so the submit button must never be disabled and the sign flow
  // must never be short-circuited because of `missing` or `completeness`.
  const submitButtonBlock = /btn\.addEventListener\(\s*['"]click['"][\s\S]*?\}\);/.exec(appSrc);
  assert.ok(submitButtonBlock, 'expected a click handler on the submit button');
  // Strip comments first: this file's own explanatory prose legitimately
  // mentions "missing signature" in a comment, which must not trip the
  // guard below — only actual code referencing completeness/missing data
  // should.
  const codeOnly = submitButtonBlock[0]
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    codeOnly,
    /completeness|\.missing\b/,
    'the submit click handler must not reference completeness/missing — it must never block on unfilled tasks'
  );
  assert.doesNotMatch(appSrc, /btn\.disabled\s*=\s*true/, 'the submit button must never be disabled client-side');
});

test('the fields API call site can request server-computed completeness (submissionId is sent)', () => {
  // Without sending submissionId, GET /api/forms/:id/fields never returns
  // `completeness`, and the "N of M tasks have no status" warning would be
  // impossible to build from data the server never sends.
  const apiSrc = sources.get('api.js');
  assert.ok(apiSrc, 'expected web/js/api.js to exist');
  assert.match(apiSrc, /submissionId/, 'expected api.js fields() to be able to send submissionId');
});
