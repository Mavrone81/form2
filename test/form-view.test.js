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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillTitleBlank, cellStyle, layoutRow } from '../web/js/form-view.js';
import { buildGrid } from '../server/grid-model.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const viewSrc = readFileSync(new URL('../web/js/form-view.js', import.meta.url), 'utf8');

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

// ---------------------------------------------------------------------------
// The document's own styling, as the renderer will draw it
// ---------------------------------------------------------------------------
// cellStyle() is the pure half of the cell renderer: grid data in, CSS
// declarations out. That makes the thing the user actually reported testable
// without a DOM — the grid data alone cannot tell you whether a `medium`
// border comes out heavier than a `thin` one, or whether a cell the form
// leaves open gets a box drawn around it anyway.
//
// These run against a REAL controlled document, not a hand-made fixture: the
// mismatch was measured on the real forms and the guard has to be too.
const gfx = loadFixtures();
const widthOf = (css, side) => (css[`border-${side}`] ?? '').split(' ')[0];

test('a medium border is drawn heavier than a thin one, and no border draws nothing',
  { skip: gfx ? false : SKIP }, async () => {
    const grid = await buildGrid(join(gfx.formsDir, gfx.forms[0].file));
    const cells = grid.rows.flatMap((r) => r.cells);

    const find = (style) => cells.find((c) => Object.values(c.borders ?? {}).includes(style));
    const medium = find('medium');
    const thin = find('thin');
    assert.ok(medium, 'expected the sample form to frame something with a medium border');
    assert.ok(thin, 'expected the sample form to rule something with a thin border');

    const sideOf = (cell, style) => Object.entries(cell.borders).find(([, s]) => s === style)[0];
    const names = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
    const mSide = names[sideOf(medium, 'medium')];
    const tSide = names[sideOf(thin, 'thin')];

    const mCss = cellStyle(medium, grid.defaults);
    const tCss = cellStyle(thin, grid.defaults);
    const px = (v) => Number.parseFloat(v);
    assert.ok(px(widthOf(mCss, mSide)) > 0, 'a medium side must draw a border');
    assert.ok(px(widthOf(tCss, tSide)) > 0, 'a thin side must draw a border');
    assert.ok(
      px(widthOf(mCss, mSide)) > px(widthOf(tCss, tSide)),
      `a medium border must be heavier than a thin one (got ${widthOf(mCss, mSide)} vs ${widthOf(tCss, tSide)})`
    );

    // ...and a side the document leaves open draws nothing at all. Before the
    // per-cell borders landed, a blanket `.sheet td` rule boxed every one of
    // these in.
    const open = cells.find((c) => c.filler !== true && c.borders && Object.keys(c.borders).length < 4);
    assert.ok(open, 'expected a real cell with at least one open side');
    const missing = Object.keys(names).find((k) => !open.borders[k]);
    const openCss = cellStyle(open, grid.defaults);
    assert.equal(openCss[`border-${names[missing]}`], undefined,
      'a side the document leaves open must draw no border');
  });

test('a filler placeholder draws nothing at all — no border, no fill, no padding',
  { skip: gfx ? false : SKIP }, async () => {
    const grid = await buildGrid(join(gfx.formsDir, gfx.forms[0].file));
    const fillers = grid.rows.flatMap((r) => r.cells).filter((c) => c.filler === true);
    assert.ok(fillers.length > 0, 'expected the sample form to need placeholders');
    for (const cell of fillers) {
      assert.deepEqual(cellStyle(cell, grid.defaults), {},
        'a placeholder holds a column open and must draw nothing');
    }

    // The model currently gives a placeholder nothing to draw WITH, so the
    // loop above would also pass if the renderer had no rule about
    // placeholders at all. The renderer's promise has to hold on its own: even
    // handed a placeholder carrying every property this file knows how to
    // draw, it must still draw nothing. Two independent layers, so neither one
    // silently becomes the only thing standing between the user and 4,455
    // empty boxes the printed form does not have.
    assert.deepEqual(
      cellStyle({
        col: 1, filler: true, text: 'x', borders: { t: 'medium', r: 'thin', b: 'thin', l: 'thin' },
        fill: '#D9D9D9', size: 14, font: 'Arial', valign: 'middle', wrap: true, bold: true, align: 'center'
      }, grid.defaults),
      {},
      'a placeholder must draw nothing even if it is handed something to draw'
    );
    // The renderer's other half of the same promise: they are marked so the
    // stylesheet can zero their padding, which is the only way they could
    // still change a row's height.
    assert.match(viewSrc, /cell\.filler === true/, 'the renderer must special-case placeholders');
    assert.match(viewSrc, /className\s*=\s*'filler'/, 'placeholders must be marked for the stylesheet');
  });

test('fill, size, family, vertical alignment and wrapping reach the CSS, and nothing else does',
  { skip: gfx ? false : SKIP }, async () => {
    const grid = await buildGrid(join(gfx.formsDir, gfx.forms[0].file));
    const cells = grid.rows.flatMap((r) => r.cells);

    const sized = cells.find((c) => typeof c.size === 'number');
    assert.ok(sized, 'expected a cell set at a size other than the sheet default');
    assert.equal(cellStyle(sized, grid.defaults)['font-size'], `${sized.size}pt`);

    const wrapped = cells.find((c) => c.wrap);
    assert.ok(wrapped, 'expected a wrapped cell');
    assert.equal(cellStyle(wrapped, grid.defaults)['white-space'], 'pre-wrap');
    const unwrapped = cells.find((c) => c.filler !== true && !c.wrap);
    assert.equal(cellStyle(unwrapped, grid.defaults)['white-space'], undefined);

    const middled = cells.find((c) => c.valign === 'middle');
    assert.ok(middled, 'expected a vertically centred cell');
    assert.equal(cellStyle(middled, grid.defaults)['vertical-align'], 'middle');
    const noValign = cells.find((c) => c.filler !== true && !c.valign);
    assert.equal(cellStyle(noValign, grid.defaults)['vertical-align'], undefined);

    // Shading is carried as a custom property so the out-of-scope row tint can
    // still win over it. (The twelve controlled documents shade nothing — every
    // fill in them is white — so this is asserted on a cell built here.)
    assert.equal(cellStyle({ col: 1, text: '', fill: '#D9D9D9' })['--cell-fill'], '#D9D9D9');
    assert.equal(cellStyle({ col: 1, text: '' })['--cell-fill'], undefined);
    assert.equal(cellStyle({ col: 1, text: '', fill: '#D9D9D9' })['background-color'], undefined,
      'shading must not be written as an inline background, which would outrank the row tint');
  });

test('a font family from a spreadsheet is only ever passed through as a plain name', () => {
  // Family names arrive from a file somebody else authored. A plain name is
  // used; anything shaped like a value with structure in it is dropped back to
  // the sheet default rather than reaching the CSSOM.
  assert.match(cellStyle({ col: 1, text: '', font: 'Aptos Narrow' })['font-family'], /^"Aptos Narrow"/);
  for (const hostile of ['red;background:url(x)', 'a}body{display:none', 'x/*', '']) {
    assert.equal(cellStyle({ col: 1, text: '', font: hostile })['font-family'], undefined,
      `"${hostile}" must not reach the style`);
  }
});

// ---------------------------------------------------------------------------
// Spill-over: a spreadsheet lets unwrapped text run across empty cells
// ---------------------------------------------------------------------------
// This is the other half of "the preview does not match the print". Column
// ALIGNMENT was fixed by the placeholder cells; this is the vertical half. A
// cell the sheet does not wrap prints on one line, running across the empty
// cells to its right. Confined to its own column it becomes a tower of wrapped
// lines instead — measured on the reference form, 26 lines where the paper has
// one, and a document 3,613px tall where the sheet is 914px.
test('an unwrapped cell takes the empty columns it spills across — and the row still covers every column',
  { skip: gfx ? false : SKIP }, async () => {
    let spilled = 0;
    for (const f of gfx.forms) {
      const grid = await buildGrid(join(gfx.formsDir, f.file));
      for (const row of grid.rows) {
        if (!row.cells.length) continue;
        const before = row.cells.reduce((n, c) => n + (c.span?.cols ?? 1), 0);
        const laid = layoutRow(row.cells);
        const after = laid.reduce((n, c) => n + c.cols, 0);
        // THE invariant the whole column alignment rests on: the widths move
        // from the placeholders into the cell that spills over them, and the
        // row still accounts for exactly the same columns.
        assert.equal(after, before,
          `${f.id} row ${row.index}: spill changed the columns the row covers (${before} -> ${after})`);
        for (const item of laid) {
          if (item.cols > (item.cell.span?.cols ?? 1)) spilled++;
          assert.ok(item.cols >= 1, `${f.id} row ${row.index}: a cell must cover at least one column`);
        }
        // A placeholder never grows: it has nothing to spill.
        for (const item of laid) {
          if (item.cell.filler === true) {
            assert.equal(item.cols, 1, `${f.id} row ${row.index}: a placeholder must never span`);
          }
        }
      }
    }
    assert.ok(spilled > 0, 'expected the sample forms to contain text that spills');
  });

test('spill only ever takes empty columns — never a bordered box, never text', () => {
  const box = { col: 2, text: '', borders: { t: 'thin', r: 'thin', b: 'thin', l: 'thin' } };
  const prose = { col: 1, text: 'a line of instruction' };

  // Placeholders to the right: taken.
  assert.deepEqual(
    layoutRow([prose, { col: 2, filler: true }, { col: 3, filler: true }]).map((i) => i.cols),
    [3]
  );
  // An empty BORDERED cell is a box the form means someone to write in. The
  // run stops there, exactly where the ink stops on paper.
  assert.deepEqual(layoutRow([prose, box]).map((i) => i.cols), [1, 1]);
  // ...and so does a cell with text in it, which must never be covered up.
  assert.deepEqual(
    layoutRow([prose, { col: 2, text: 'more' }, { col: 3, filler: true }]).map((i) => i.cols),
    [1, 2]
  );
  // A WRAPPED cell wraps inside its own width, as the sheet does. It never spills.
  assert.deepEqual(
    layoutRow([{ col: 1, text: 'wrapped', wrap: true }, { col: 2, filler: true }]).map((i) => i.cols),
    [1, 1]
  );
  // An empty cell has nothing to spill.
  assert.deepEqual(
    layoutRow([{ col: 1, text: '', borders: { b: 'thin' } }, { col: 2, filler: true }]).map((i) => i.cols),
    [1, 1]
  );
  // A merged cell keeps its own span and adds to it.
  assert.deepEqual(
    layoutRow([{ col: 1, text: 'x', span: { rows: 1, cols: 2 } }, { col: 3, filler: true }]).map((i) => i.cols),
    [3]
  );
});
