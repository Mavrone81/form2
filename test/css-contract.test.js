import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');

// Naive but sufficient leaf-rule extractor: pulls out every `selector { body }`
// pair, including ones nested inside @media blocks. It does not attempt to
// parse selectors or values — it only needs non-overlapping leaf declaration
// blocks (no braces inside the body), which is all this stylesheet contains.
// Comments are stripped first: a comma inside a comment (e.g. "Declare it, or
// a white input...") would otherwise corrupt selector-splitting below.
function leafRules(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(withoutComments))) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

const rules = leafRules(css);
const CONTROL_TAGS = ['input', 'textarea', 'select', 'button'];
const controlTagRe = /(^|[\s,>+~])(input|textarea|select|button)\b/i;

test('light panels pin color-scheme so dark-mode viewers do not get white-on-white', () => {
  assert.match(css, /color-scheme:\s*light/);
});

test('every base control element declares its own colour, regardless of source order', () => {
  // Structural, not positional: does not care which order input/textarea/
  // select/button appear in relative to one another.
  for (const tag of CONTROL_TAGS) {
    const covering = rules.filter(
      (r) => r.selector.split(',').some((seg) => seg.trim().toLowerCase() === tag) &&
        /(^|[;\s])color\s*:/.test(r.body)
    );
    assert.ok(covering.length > 0, `expected a top-level "${tag}" rule that declares colour`);
  }
});

test('every control rule that sets a background also sets a colour in the same rule', () => {
  // Guards against a NEW control rule being added later that sets a
  // background (e.g. white) without a colour — invisible text in dark mode.
  // Deliberately does not rely on a distant earlier rule cascading colour in;
  // every rule that touches a control's background must be self-sufficient.
  const controlBgRules = rules.filter(
    (r) => controlTagRe.test(r.selector) && /background(-color)?\s*:/.test(r.body)
  );
  assert.ok(controlBgRules.length > 0, 'expected at least one control rule with a background');
  for (const r of controlBgRules) {
    assert.match(
      r.body,
      /(^|[;\s])color\s*:/,
      `rule "${r.selector}" sets a background but no colour`
    );
  }
});

test('no rule anywhere sets white text without an obviously dark background in the same rule', () => {
  const whiteTextRules = rules.filter((r) => /color\s*:\s*(#fff(f{2})?\b|white\b)/i.test(r.body));
  assert.ok(
    whiteTextRules.length > 0,
    'expected at least one white-text rule to check (e.g. #control-strip)'
  );
  for (const r of whiteTextRules) {
    assert.match(
      r.body,
      /background(-color)?\s*:\s*(var\(--(ink|stamp|ok)\)|#(16181d|b4232a|0f6e5c)\b)/i,
      `rule "${r.selector}" sets white text without a dark background in the same rule`
    );
  }
});

test('out-of-scope rows are tinted, never faded, and the "not in scope" label stays visible', () => {
  const rowOutRules = rules.filter((r) => /\.row-out\b/.test(r.selector));
  assert.ok(rowOutRules.length > 0, 'expected at least one .row-out rule');

  // None of the .row-out family may fade text via opacity.
  for (const r of rowOutRules) {
    assert.doesNotMatch(
      r.body,
      /opacity\s*:\s*0?\.[0-6]\b/,
      `"${r.selector}" must not fade the text (opacity below 0.7)`
    );
  }

  // De-emphasis must be by background tint on at least one .row-out rule.
  assert.ok(
    rowOutRules.some((r) => /background(-color)?\s*:/.test(r.body)),
    'de-emphasis is by background tint'
  );

  // The rule(s) that actually render the "not in scope" label must not hide it.
  const labelRules = rowOutRules.filter((r) => /not in scope/.test(r.body));
  assert.ok(labelRules.length > 0, 'expected a .row-out rule that renders the "not in scope" label');
  for (const r of labelRules) {
    assert.doesNotMatch(r.body, /visibility\s*:\s*hidden/, `"${r.selector}" must not hide the label`);
    assert.doesNotMatch(r.body, /display\s*:\s*none/, `"${r.selector}" must not remove the label`);
  }

  assert.match(css, /not in scope/, 'the out-of-scope label text must still be present');
});

test('.row-tint rows (inactive users/forms, added in Task 15) are tinted, never faded', () => {
  // Same "never fade, only tint" rule as .row-out, extended to the admin
  // screens' inactive-user/inactive-form rows (review round 1, Finding 2).
  // .row-tint has no hidden-label mechanism like .row-out's "not in scope"
  // text, so only the fade/background checks apply here.
  const rowTintRules = rules.filter((r) => /\.row-tint\b/.test(r.selector));
  assert.ok(rowTintRules.length > 0, 'expected at least one .row-tint rule');

  for (const r of rowTintRules) {
    assert.doesNotMatch(
      r.body,
      /opacity\s*:\s*0?\.[0-6]\b/,
      `"${r.selector}" must not fade the text (opacity below 0.7)`
    );
    assert.doesNotMatch(r.body, /visibility\s*:\s*hidden/, `"${r.selector}" must not hide its content`);
    assert.doesNotMatch(r.body, /display\s*:\s*none/, `"${r.selector}" must not remove its content`);
  }

  assert.ok(
    rowTintRules.some((r) => /background(-color)?\s*:/.test(r.body)),
    'de-emphasis is by background tint'
  );
});

test('reduced motion is honoured', () => {
  assert.match(css, /prefers-reduced-motion/);
});
