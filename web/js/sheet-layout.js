// How a spreadsheet PRINTS — shared by both renderers of the same sheet.
//
// ---------------------------------------------------------------------------
// Why this file exists, and why it lives here
// ---------------------------------------------------------------------------
// Two things draw the controlled document: the live preview
// (web/js/form-view.js, in the browser) and the archived record
// (server/pdf-record.js, in Node). They must agree, because the PDF is the
// artifact the company KEEPS — a quality record that does not look like the
// document it claims to be is a defect in the record itself.
//
// They did not agree. The spill rule below was written for the preview only,
// and the PDF kept wrapping text to its own column's width: labels the form
// prints on one line came out broken mid-word down a narrow column, prose
// blocks became fifteen-line towers, and a one-page controlled form was
// downloaded as four pages. The rule was correct in one place and absent in
// the other, which is exactly what having two copies of a rule eventually
// produces. So there is now ONE copy, imported by both.
//
// It lives under web/js/ for a mechanical reason, not a conceptual one:
// server/index.js serves web/ as the document root, so `./sheet-layout.js`
// next to form-view.js is the only specifier that resolves to the SAME FILE
// both from a browser (/js/form-view.js -> /js/sheet-layout.js) and from Node
// (web/js/form-view.js -> web/js/sheet-layout.js). A module under server/
// could not be imported by the browser at all without serving server/ over
// HTTP. server/pdf-record.js reaches it by ordinary relative path.
//
// Nothing here touches the DOM, PDFKit, or any I/O: it is pure functions over
// the grid model (server/grid-model.js), so each renderer turns the same
// answer into its own medium — CSS pixels there, PDF points here.

// ---------------------------------------------------------------------------
// Border weights
// ---------------------------------------------------------------------------
// The WEIGHT is the point: these documents frame each section in `medium` and
// rule the gridlines inside it in `thin`, and that contrast is the document's
// entire visual hierarchy. Drawing both at one weight — which a blanket
// `td{border:1px}` does, and which the archived PDF did with a single 0.5pt
// stroke — flattens the form into an undifferentiated mesh.
//
// `weight` is in sheet units (CSS pixels); a renderer scales it into whatever
// its medium measures in. `heavy` says whether the line is structural (a
// section frame) or interior (a gridline), which the preview uses to pick a
// tone. An unrecognised style still draws a line: a border the sheet asks for
// must never silently disappear.
const PENS = {
  hair: { weight: 0.5, line: 'solid', heavy: false },
  thin: { weight: 1, line: 'solid', heavy: false },
  dotted: { weight: 1, line: 'dotted', heavy: false },
  dashed: { weight: 1, line: 'dashed', heavy: false },
  dashDot: { weight: 1, line: 'dashed', heavy: false },
  dashDotDot: { weight: 1, line: 'dashed', heavy: false },
  medium: { weight: 2, line: 'solid', heavy: true },
  mediumDashed: { weight: 2, line: 'dashed', heavy: true },
  mediumDashDot: { weight: 2, line: 'dashed', heavy: true },
  mediumDashDotDot: { weight: 2, line: 'dashed', heavy: true },
  slantDashDot: { weight: 2, line: 'dashed', heavy: true },
  thick: { weight: 3, line: 'solid', heavy: true },
  double: { weight: 3, line: 'double', heavy: true }
};

export function borderPen(style) {
  return PENS[style] ?? PENS.thin;
}

// ---------------------------------------------------------------------------
// Spill-over
// ---------------------------------------------------------------------------
// How a row is laid out, given that a spreadsheet lets text SPILL and neither
// an HTML table nor a PDF grid does so by itself.
//
// A cell the sheet does not wrap is drawn by Excel on one line, running on
// across the empty cells to its right for as far as it needs. Hold it to its
// own column instead and a line of prose the form prints once becomes a
// 26-line tower, which drags the row — and the whole document's vertical
// proportions — far away from the printed page. Measured on the reference
// form, that alone made the preview 3,613px tall where the sheet is 914px,
// and made the archived PDF four pages long where the form is one.
//
// So the spill is reproduced the only way a grid can: the cell is given the
// columns it spills into. It may only ever take PLACEHOLDER columns — columns
// the sheet leaves genuinely empty, with no text, no border and no merge, so
// nothing is displaced and nothing is covered up. A bordered box the form
// means someone to write in is not a placeholder and is never absorbed, and
// neither is anything with text in it. The moment a real cell is reached, the
// run stops, exactly where the ink stops on paper.
//
// The row still accounts for every one of its columns afterwards — the widths
// simply move from the placeholders into the cell that spills over them —
// which is the invariant the whole column alignment rests on.
//
// Each entry also reports `overflow`: how many FURTHER columns the cell's ink
// could run over. Excel spills across any neighbour that is EMPTY, whether or
// not that neighbour is ruled — three columns sharing one drawn box is how
// these forms write a wide heading without merging anything. `cols` cannot
// include those, because taking a ruled column into a table cell would erase
// the rule the form draws there; but a renderer that draws text and borders
// separately (the PDF does) may let the ink run across them while the box
// stays drawn, which is both what Excel prints and strictly more faithful than
// a colspan. So: `cols` is what a cell may TAKE, `overflow` is what its ink may
// RUN OVER, and the run stops at the first thing on paper — any text, or a
// merged box, which is a box in its own right.
export function layoutRow(cells) {
  const out = [];
  let absorb = 0;
  const openColumns = (from) => {
    let n = 0;
    for (let j = from; j < cells.length; j++) {
      const next = cells[j];
      if (next.filler === true) { n++; continue; }
      if (String(next.text ?? '').trim()) break;
      if (next.span && ((next.span.cols ?? 1) > 1 || (next.span.rows ?? 1) > 1)) break;
      n++;
    }
    return n;
  };
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (absorb > 0 && cell.filler === true) { absorb--; continue; }
    const cols = cell.span?.cols ?? 1;
    if (cell.filler === true || cell.wrap || !cell.text) {
      out.push({ cell, cols, overflow: 0 });
      continue;
    }
    let extra = 0;
    while (i + 1 + extra < cells.length && cells[i + 1 + extra].filler === true) extra++;
    absorb = extra;
    // openColumns starts AFTER the placeholders already taken into `cols`, so
    // what it returns is purely additional.
    out.push({ cell, cols: cols + extra, overflow: openColumns(i + 1 + extra) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where the embedded logo sits
// ---------------------------------------------------------------------------
// The grid model reports the one image these documents embed as a rectangle in
// the sheet's own coordinates: one-based FRACTIONAL column and row positions
// (see imageOf in server/grid-model.js). Turning that into a box is arithmetic
// over the very same column widths and row heights both renderers already lay
// their cells out with, so the logo lands in the header box the form draws for
// it rather than at a position each renderer guessed separately.
//
// UNITS follow the grid model's own, unconverted, because the two axes are
// measured differently there and each renderer already knows it:
//   - `x` and `width` are in COLUMN units (CSS pixels, as `columns[i].width`);
//   - `y` and `height` are in ROW units (points, as `rows[i].height`).
// Both are measured from the top-left corner of the grid.
//
// The box is where the image is ANCHORED, not the shape it must be drawn as: a
// renderer fits the image inside it and preserves the aspect ratio, so a box
// that is not the image's own proportion crops nothing and stretches nothing.
function offsetAlong(sizes, position) {
  // `position` is one-based and fractional: 1 is the leading edge of the first
  // cell, 2.5 the middle of the second. Anything past the end stops at the end
  // rather than running off it.
  const p = Math.min(Math.max(position, 1), sizes.length + 1);
  const index = Math.min(Math.floor(p), sizes.length);
  let total = 0;
  for (let i = 0; i < index - 1; i++) total += sizes[i] ?? 0;
  return total + (sizes[index - 1] ?? 0) * Math.min(1, Math.max(0, p - index));
}

export function imageBox(grid) {
  const image = grid?.image;
  if (!image?.from || !image?.to) return null;
  const columns = (grid.columns ?? []).map((c) => c.width ?? 0);
  const rows = (grid.rows ?? []).map((r) => r.height ?? 15);
  if (!columns.length || !rows.length) return null;

  const x = offsetAlong(columns, image.from.col);
  const right = offsetAlong(columns, image.to.col);
  const y = offsetAlong(rows, image.from.row);
  const bottom = offsetAlong(rows, image.to.row);
  // A rectangle with no area cannot be drawn into; report nothing rather than
  // a degenerate box for a renderer to divide by.
  if (!(right > x) || !(bottom > y)) return null;
  return { x, y, width: right - x, height: bottom - y };
}

// ---------------------------------------------------------------------------
// The frequency band's checkboxes
// ---------------------------------------------------------------------------
// The forms print the interval band as CHECKBOXES — `☐ Monthly (1M)  ☐ Three
// Monthly (3M)  …` — and the technician ticks the ones the visit covers. They
// are not part of the cell's TEXT: each is a rectangle shape anchored on the
// band's row in the sheet's drawing XML, which is why nothing in the grid model
// carries them and why both renderers have to draw them.
//
// The geometry is here, in sheet units of the TYPE SIZE the option is set in,
// so a box scales with the band exactly as the printed one does and the preview
// and the archived record cannot drift into two different marks. `tick` is the
// check itself as a three-point polyline in the box's own square, given as
// fractions of the box's side so a renderer can scale it into pixels, points,
// or an SVG viewBox of 1 without knowing anything else.
//
// `advance` is what the box costs horizontally. Both renderers draw the box in
// the whitespace the sheet already leaves BEFORE the option (these bands pad
// their options apart with long space runs), so the option's own words stay
// exactly where the document prints them — the band is one of the widest rows
// on the sheet and must not be pushed wider by a mark being added to it.
const CHECKBOX = { side: 0.95, gap: 0.4, stroke: 0.08 };
const CHECK_TICK = [[0.17, 0.5], [0.4, 0.76], [0.85, 0.2]];

export function checkboxMetrics(fontSize) {
  const size = Math.max(0, fontSize) * CHECKBOX.side;
  const gap = Math.max(0, fontSize) * CHECKBOX.gap;
  return {
    size,
    gap,
    advance: size + gap,
    stroke: Math.max(0.25, Math.max(0, fontSize) * CHECKBOX.stroke),
    tick: CHECK_TICK.map(([x, y]) => [x * size, y * size])
  };
}

// ---------------------------------------------------------------------------
// The machine ID in the printed title's blank
// ---------------------------------------------------------------------------
// A machine ID filled into the blank the printed title leaves for it, e.g.
// "…Preventive Maintenance Record ED____" with machine ID "ED04" reads
// "…Record ED04". Display only: the stored title and the source file are
// never touched. Shared for the same reason as the spill rule — the preview
// and the archived record must fill the same blank the same way.
//
// Rules, in order:
//  - No machine ID yet: the title is left exactly as printed.
//  - No blank in the title (four of the twelve forms name their machine in
//    the title outright): left exactly as printed. Never appended to — a
//    title that does not ask for a machine ID must not grow one.
//  - Otherwise the first run of two or more underscores is replaced. A run
//    of two is the shortest thing that reads as a ruled blank; a lone "_"
//    is left alone because it is far more likely to be part of a name.
//  - If the machine ID already repeats the short code immediately before the
//    blank ("ED____" + "ED04"), that code is dropped from the title so the
//    result is "ED04" and not "EDED04". Only a stem of up to four
//    non-space characters is ever dropped, so a whole word before the blank
//    ("...Record______") can never be swallowed.
export function fillTitleBlank(title, machineId) {
  const printed = String(title ?? '');
  const id = String(machineId ?? '').trim();
  if (!id) return printed;
  const blank = /_{2,}/.exec(printed);
  if (!blank) return printed;

  let head = printed.slice(0, blank.index);
  const tail = printed.slice(blank.index + blank[0].length);
  const key = (s) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const stem = (/\S{1,4}$/.exec(head) ?? [''])[0];
  if (key(stem) && key(id).startsWith(key(stem))) head = head.slice(0, head.length - stem.length);
  return head + id + tail;
}
