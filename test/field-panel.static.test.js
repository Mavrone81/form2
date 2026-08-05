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

// --- Static guards: empty-scope dimming and the technician's own queue ---

test('static guard: form-view.js no longer conjoins the empty-scope guard with .size', () => {
  // Regression guard for the bug where `inScope.size` in the dimming
  // condition made an EMPTY (but real) scope array indistinguishable from
  // no filter at all: `inScope.size` is 0/falsy for an empty array, so the
  // whole `&&` chain short-circuited and no task row was ever dimmed for a
  // frequency that covers zero tasks. The fix drops `.size` from the
  // conjunction entirely — presence of a filter (`inScope` truthy, i.e. not
  // null) is what must gate dimming, not its size.
  const formViewSrc = sources.get('form-view.js');
  assert.ok(formViewSrc, 'expected web/js/form-view.js to exist');
  assert.doesNotMatch(
    formViewSrc,
    /inScope\s*&&\s*inScope\.size/,
    'form-view.js must not conjoin inScope with inScope.size in the row-out guard'
  );
  assert.match(
    formViewSrc,
    /if\s*\(\s*inScope\s*&&\s*row\.isTask\s*&&\s*!inScope\.has\(row\.index\)\s*\)/,
    'expected the row-out guard to depend only on whether a filter (inScope) exists, not its size'
  );
});

test('static guard: a technician sees their own existing records via api.queue(), not just a form-to-start picker', () => {
  // Regression guard for the bug where a technician who started a draft and
  // closed the browser had no way back to it: the technician branch of
  // showPicker() only ever listed forms to start a NEW draft. GET
  // /api/submissions (api.queue()) already returns exactly the technician's
  // own records in any state (server/workflow.js queueFor), so the
  // technician branch must call api.queue() too.
  const technicianBranch = /if\s*\(\s*user\.role\s*===\s*'technician'\s*\)\s*\{[\s\S]*?\n\s*\}\s*else/.exec(appSrc);
  assert.ok(technicianBranch, "expected an `if (user.role === 'technician') { ... } else` branch in app.js");
  assert.match(
    technicianBranch[0],
    /api\.queue\(\)/,
    "expected the technician branch of showPicker() to call api.queue() so a technician can reach their own existing records"
  );
  // The "start a new draft" picker must remain technician-only: it must not
  // appear in the else branch (team leader / engineer / admin), which opens
  // existing records exclusively.
  const afterElse = appSrc.slice(appSrc.indexOf(technicianBranch[0]) + technicianBranch[0].length);
  const elseBranch = /^\s*\{[\s\S]*?\n\s*\}\s*\n\}/.exec(afterElse);
  assert.ok(elseBranch, 'expected an else branch body following the technician branch');
  assert.doesNotMatch(
    elseBranch[0],
    /startNew\(/,
    'team leader / engineer / admin must never be offered the "start a new draft" picker'
  );
});

// --- Static guards: the reject / send-back controls -----------------------

test('the reject path requires a reason before calling the reject API', () => {
  // A rejection with no reason gives the technician nothing to act on. The
  // server enforces this too (400), but the client must not fire a request it
  // knows will fail, and — crucially — must SAY why rather than doing nothing
  // at all: a button that silently no-ops reads as broken. This checks the
  // ordering in source: read the reason -> guard on it -> only then call
  // api.reject().
  const guard = /if\s*\(\s*!\s*reason\.value\.trim\(\)\s*\)/.exec(appSrc);
  assert.ok(guard, 'expected an "if (!reason.value.trim())" guard in app.js');
  const rejectCallIdx = appSrc.indexOf('api.reject(');
  assert.ok(rejectCallIdx >= 0, 'expected app.js to call api.reject(...)');
  assert.ok(guard.index < rejectCallIdx, 'expected the empty-reason guard BEFORE the api.reject() call');
  // Not a silent no-op: the guard branch must set a visible message.
  const guardBranch = appSrc.slice(guard.index, rejectCallIdx);
  assert.match(guardBranch, /msg\.textContent\s*=\s*['"][^'"]+['"]/,
    'an empty reason must produce a clear message, never a silent no-op');
});

test('the reject control is offered only for the two reviewer stages', () => {
  // Shown beside Sign and submit, and only when the record is actually
  // awaiting this reviewer — addSubmitBar only reaches the control when
  // canAct is true, and this narrows it further to the rejectable states. The
  // server enforces the real rule; this only avoids offering an action that
  // would 403.
  assert.match(
    appSrc,
    /REJECTABLE_STATES\s*=\s*new Set\(\s*\[\s*'pending_lead'\s*,\s*'pending_engineer'\s*\]\s*\)/,
    'expected app.js to name exactly the two states a reviewer may reject from'
  );
  assert.match(appSrc, /REJECTABLE_STATES\.has\(sub\.state\)/,
    'expected the reject control to be gated on the record being in a reviewer stage');
});

test('a rejected record is a technician stage everywhere in the client, never a special case', () => {
  // `rejected` must behave like `draft` for the technician who owns it:
  // editable again, re-signable, and re-submittable. Mirrors
  // server/workflow.js's STAGES table, where `rejected` is likewise a
  // technician-actor row rather than a scattered set of exceptions.
  assert.match(appSrc, /rejected:\s*'technician'/, 'expected `rejected` to map to the technician actor');
  assert.doesNotMatch(
    appSrc,
    /state\s*===\s*'draft'\s*&&\s*canAct/,
    'editability must be derived from the technician-held states, not hardcoded to draft alone'
  );
});

test('the technician is shown WHY a rejected record came back — reason, who and when', () => {
  // A technician who cannot see the reason cannot act on it. All three parts
  // must be rendered, and via textContent (the no-innerHTML guard above
  // already covers the whole directory).
  assert.match(fieldPanelSrc, /r\.reason/, 'expected the rejection reason to be rendered');
  assert.match(fieldPanelSrc, /r\.full_name/, 'expected the rejecter\'s name to be rendered');
  assert.match(fieldPanelSrc, /r\.rejected_at/, 'expected the rejection timestamp to be rendered');
  assert.match(fieldPanelSrc, /state\s*===\s*'rejected'/, 'expected the notice to be gated on the rejected state');
  // ...and it must come before the fields it explains, not below them.
  const noticeIdx = fieldPanelSrc.indexOf("state === 'rejected'");
  const fieldsIdx = fieldPanelSrc.indexOf('for (const [name, fields] of groups)');
  assert.ok(fieldsIdx >= 0, 'expected the field-group render loop');
  assert.ok(noticeIdx < fieldsIdx, 'the rejection reason must render before the fields');
});
