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

test('the responsive scale stays mobile-first: no max-width breakpoint anywhere', () => {
  // Every rule outside a media query is the mobile baseline; the 640/768/1024
  // `min-width` blocks only add width back. A single `max-width` block would
  // invert that and reintroduce the desktop-down layout this file replaced.
  assert.doesNotMatch(css, /@media[^{]*max-width/i, 'app.css must not use a max-width breakpoint');
  assert.match(css, /@media\s*\(min-width:1024px\)/, 'expected the lg min-width breakpoint');
});

test('the Fill in / Form tab switcher is mobile-only and never hides a pane at desktop width', () => {
  // The tabs exist because below `lg` the single-column `.split` stacked a
  // 71-row form grid ABOVE the fields. At >=1024px both panes are on screen
  // at once, so the bar must be gone and neither pane may be hidden — this is
  // the regression guard on "the desktop two-pane layout is unchanged".
  const lg = /@media\s*\(min-width:1024px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(lg, 'expected the lg (min-width:1024px) block');

  const base = css.slice(0, lg.index);
  // The pane-hiding rules are part of the MOBILE baseline, never inside a
  // media query.
  assert.match(base, /\.split\[data-tab="fill"\]\s*>\s*#pane-left\s*\{[^}]*display:\s*none/,
    'expected the Fill in tab to hide the form pane at mobile width');
  assert.match(base, /\.split\[data-tab="form"\]\s*>\s*#pane-right\s*\{[^}]*display:\s*none/,
    'expected the Form tab to hide the fill-in pane at mobile width');

  // ...and both are undone at desktop, at equal-or-higher specificity and
  // later in source order, so neither pane can ever be hidden there.
  assert.match(lg[1], /#pane-tabs\s*\{[^}]*display:\s*none/,
    'the tab bar must be display:none at >=1024px');
  assert.match(lg[1], /\.split\[data-tab\]\s*>\s*#pane-left\s*,\s*\.split\[data-tab\]\s*>\s*#pane-right\s*\{[^}]*display:\s*block/,
    'both panes must be restored to display:block at >=1024px');
});

test('the tab bar is reachable without scrolling back to the top', () => {
  // A technician deep in a long field list must be able to switch to the form
  // in place. Sticky, not static.
  const bar = rules.find((r) => r.selector.split(',').some((s) => s.trim() === '#pane-tabs'));
  assert.ok(bar, 'expected a #pane-tabs rule');
  assert.match(bar.body, /position:\s*sticky/, 'the tab bar must be sticky');
});

test('the tabs meet the 44px tap-target floor and are not shrunk at any breakpoint', () => {
  const tabRules = rules.filter((r) => /#pane-tabs\b[^,]*\bbutton\b/.test(r.selector));
  assert.ok(tabRules.length > 0, 'expected at least one #pane-tabs button rule');
  assert.ok(
    tabRules.some((r) => /min-height:\s*44px/.test(r.body)),
    'expected a 44px minimum tap target on the tabs'
  );
  // The lg block drops several mobile tap targets back to their compact
  // desktop size; the tabs must not be among them, since they do not exist at
  // desktop width at all — a min-height:0 there would be a sign the bar had
  // been made visible on a screen it does not belong on.
  for (const r of tabRules) {
    assert.doesNotMatch(r.body, /min-height:\s*0\b/, `"${r.selector}" must not drop below the tap-target floor`);
  }
});

test('the reproduced spreadsheet has NO blanket cell border, and the app\'s own tables still do', () => {
  // This replaces the assumption the previous version of this file was written
  // under: that `.sheet td{border:1px solid var(--rule)}` drew every gridline.
  // It did — including around the ~4,500 placeholder cells that hold a column
  // open and around every cell the form deliberately leaves open, and at ONE
  // weight, which flattened the medium section framing into the thin interior
  // rules. The document's borders now come from the cell (see
  // server/grid-model.js and cellStyle() in web/js/form-view.js), so a blanket
  // rule here would fight real data and win.
  //
  // The guard is not deleted, it is inverted, and it keeps the other half:
  // `.sheet` is also worn by the admin listings and the field mapper, which
  // are the app's own tables and must keep the uniform gridline they were
  // designed with.
  const tdBorderRules = rules.filter((r) => {
    const segs = r.selector.split(',').map((s) => s.trim());
    return segs.some((s) => /(^|\s)\.sheet[^\s]*\s+td$/.test(s)) &&
      /(^|[;\s])border\s*:/.test(r.body);
  });
  assert.ok(tdBorderRules.length > 0, 'expected rules that set a border on sheet cells');

  for (const r of tdBorderRules) {
    const segs = r.selector.split(',').map((s) => s.trim()).filter((s) => /\.sheet/.test(s));
    for (const seg of segs) {
      const drawsOne = !/border\s*:\s*(0|none)\b/.test(r.body);
      if (!drawsOne) continue;
      assert.ok(
        /:not\(\.xl\)/.test(seg) === true || /\.xl/.test(seg) === false,
        `"${seg}" draws a border on every cell; the reproduced sheet (.sheet.xl) must take its borders from the cell`
      );
      assert.doesNotMatch(seg, /\.sheet\.xl\s+td$/,
        'the reproduced sheet must not have a blanket cell border');
    }
  }

  // The reproduction must explicitly stand its cells down to no border, so the
  // per-cell declarations are the only thing drawing a line.
  const xlTd = rules.find((r) => r.selector.split(',').some((s) => s.trim() === '.sheet.xl td'));
  assert.ok(xlTd, 'expected a .sheet.xl td rule');
  assert.match(xlTd.body, /border\s*:\s*0\b/, '.sheet.xl td must declare no border of its own');

  // ...and the app's own tables must still be ruled.
  const appTd = rules.find((r) => r.selector.split(',').some((s) => s.trim() === '.sheet:not(.xl) td'));
  assert.ok(appTd, 'expected the app\'s own .sheet tables to keep their gridline');
  assert.match(appTd.body, /border\s*:\s*1px/, 'the admin listings must keep their uniform gridline');
});

test('a placeholder cell draws nothing and cannot change a row\'s height', () => {
  // Placeholders exist only to hold a column open so the cells to their right
  // land in their true column. Anything drawn for them — a border, a
  // background, or padding — is a mark the printed form does not have.
  const filler = rules.find((r) => r.selector.split(',').some((s) => s.trim() === '.sheet.xl td.filler'));
  assert.ok(filler, 'expected a .sheet.xl td.filler rule');
  assert.match(filler.body, /border\s*:\s*0\b/, 'a placeholder must draw no border');
  assert.match(filler.body, /background\s*:\s*none\b/, 'a placeholder must draw no background');
  assert.match(filler.body, /padding\s*:\s*0\b/, 'a placeholder must add no padding');
});

test('cell shading never outranks the out-of-scope row tint', () => {
  // Shading arrives as `--cell-fill`, so a shaded cell inside a row this
  // visit does not cover still shows the tint rather than punching a hole in
  // it. De-emphasis stays a background tint and never a fade — the rule this
  // file has guarded since the white-on-white defect.
  const xlTd = rules.find((r) => r.selector.split(',').some((s) => s.trim() === '.sheet.xl td'));
  assert.ok(xlTd, 'expected a .sheet.xl td rule');
  assert.match(xlTd.body, /background\s*:\s*var\(--cell-fill/, 'shading must come through a custom property');

  const tinted = rules.find((r) => /\.sheet\.xl\s+tr\.row-out\s+td/.test(r.selector));
  assert.ok(tinted, 'expected the row tint to be restated at a specificity that beats .sheet.xl td');
  assert.match(tinted.body, /background\s*:\s*var\(--tint\)/, 'the out-of-scope tint must win inside the sheet');
  assert.doesNotMatch(tinted.body, /opacity\s*:\s*0?\.[0-6]\b/, 'de-emphasis is never a fade');
});

test('a frequency checkbox costs the band no width, and an unticked box still draws its outline', () => {
  const box = rules.find((r) => r.selector === '.sheet .checkbox');
  assert.ok(box, 'the frequency band must draw a checkbox before each option');

  // The band is one of the widest rows on the sheet. A box that took its own
  // horizontal space would push every option to the right of where the
  // document prints it, so the advance is cancelled by an equal negative
  // margin — the box is drawn into the whitespace the sheet already leaves.
  const left = /margin-left:\s*(-?[\d.]+)em/.exec(box.body);
  const right = /margin-right:\s*([\d.]+)em/.exec(box.body);
  const width = /width:\s*([\d.]+)em/.exec(box.body);
  assert.ok(left && right && width, 'the box must be sized and spaced in em, so it scales with the option\'s type');
  assert.ok(Number(left[1]) < 0, 'the box\'s advance must be cancelled, not added to the band');
  assert.ok(Math.abs(Number(left[1]) + Number(width[1]) + Number(right[1])) < 0.01,
    `the negative margin must cancel the box exactly (width ${width[1]} + gap ${right[1]} vs ${left[1]})`);

  // The printed form carries a box beside EVERY option, ticked or not. A
  // record showing only the ticked one would not be the same document.
  assert.match(box.body, /border:\s*[\d.]+em solid/, 'every box keeps its outline, ticked or not');

  const tick = rules.find((r) => r.selector === '.sheet .checkbox polyline');
  const ticked = rules.find((r) => r.selector === '.sheet .checkbox.on polyline');
  assert.ok(tick && ticked, 'the tick must be drawn only on a ticked box');
  assert.match(tick.body, /stroke:\s*none/, 'an unticked box must show no tick at all');
  assert.match(ticked.body, /stroke:\s*var\(--ink\)/, 'a ticked box is marked in the document\'s own ink');
});

test('the logo is fitted to its anchored box and can never be stretched', () => {
  const logo = rules.find((r) => r.selector === '.sheet-logo');
  assert.ok(logo, 'the sheet must be able to draw the logo the form embeds');
  assert.match(logo.body, /object-fit:\s*contain/,
    'a company mark squashed to fill a box it does not share proportions with is a defect');
  assert.match(logo.body, /position:\s*absolute/,
    'the logo is anchored to a rectangle of the sheet, not to a cell');
  const stage = rules.find((r) => r.selector === '.sheet-stage');
  assert.ok(stage, 'an absolutely positioned logo needs something to be positioned against');
  assert.match(stage.body, /position:\s*relative/);
});
