import ExcelJS from 'exceljs';

// Every row that emits anything accounts for EVERY one of its columns: the
// emitted cells' `col` plus `span.cols`, together with the columns a cell in
// an earlier row spans down into, tile 1..columns.length with no hole and no
// overlap. A consumer can therefore append one element per cell, in order,
// and land each one in its true column — which is exactly what the browser
// does with <td>, where cells pack from the left. Without that guarantee a
// row whose leading columns are blank slides left and stops lining up with
// the row above it, so the preview and the printed sheet disagree.
//
// The columns a sheet leaves genuinely blank are filled by placeholder cells
// carrying `filler: true`. That flag is the difference between "nothing is
// here" and "an empty bordered box the form intends someone to write in" —
// the latter is a real cell and is never flagged. A placeholder carries
// NOTHING but its column and the flag: no text, no span, no borders, no
// styling of any kind, because it is not a cell of the document — it exists
// only so the cells to its right land in their true column. Real cells do
// not carry the flag at all, so test it as `cell.filler === true`.
//
// Two things deliberately emit nothing. A cell a merge covers is left out —
// its anchor carries the span, and re-emitting it would both duplicate the
// column and (a past defect) blank the anchor's content. And a row with no
// real cell at all emits no cells, keeping blank spacer rows out of the
// render and the document's vertical rhythm intact.
//
// ---------------------------------------------------------------------------
// STYLING: what this model carries, and why it is a lean payload
// ---------------------------------------------------------------------------
// The preview has to look like the printed sheet, so the document's own
// styling has to survive the trip. Measured across the twelve controlled
// forms, that means: TWO border weights (medium framing sections against thin
// gridlines inside them — collapsing both to one weight flattens the entire
// visual hierarchy), font sizes of 8/9/10/11/12/14pt, three families (Aptos
// Narrow, Calibri, Arial), vertical alignment, per-cell text wrapping, and
// cell shading where a form has any.
//
// Every one of those is emitted ONLY where it differs from what the sheet
// does by default, because a grid is sent per form and the corpus is ~6,500
// cells: writing `size: 10` on all of them would be most of the payload and
// would say nothing. So:
//   - `borders` is present only when a side actually has one, and names the
//     Excel style ('thin'/'medium'/...) per side — never a boolean, since the
//     weight IS the hierarchy. A side with no border is simply absent.
//   - `size` / `font` appear only when they differ from `grid.defaults`, which
//     carries the sheet's own most-used size and family for the renderer to
//     set once on the table.
//   - `fill`, `valign` and `wrap` appear only when the cell sets them.
//   - `bold` and `align` are likewise omitted at their defaults (not bold,
//     left) rather than written on every cell.
// Consumers must therefore read these as optional: `cell.align || 'left'`,
// `cell.span ?? {rows:1,cols:1}`, `if (cell.borders)`.
const DEFAULT_COL_WIDTH = 8.43;
const PX_PER_CHAR = 7.5;

// Excel writes a cell's shading as a pattern fill. Only a fill that names an
// explicit colour is reported, and only when that colour is not the paper the
// sheet is already printed on:
//   - `argb` is the unambiguous case and is passed through as #RRGGBB.
//   - `theme: 0` (background 1) and `indexed: 65` (the system background) are
//     white — they are how Excel writes "no shading at all", and every fill in
//     the current twelve forms is one of those two. Reporting them would paint
//     ~11,400 opaque white boxes that hide the out-of-scope row tint beneath
//     them, which is the opposite of the intent.
//   - anything else (a themed colour with a tint, say) needs the workbook's
//     theme palette to resolve. Rather than guess a colour onto a controlled
//     document, it is omitted — the cell renders unshaded, as it does today.
// White is treated as "no fill" for the same reason: the sheet's paper is
// already white, so saying so adds bytes and takes away the tint.
function fillColour(fill) {
  if (!fill || fill.type !== 'pattern' || !fill.pattern || fill.pattern === 'none') return null;
  const fg = fill.fgColor;
  if (!fg) return null;
  if (typeof fg.argb === 'string' && /^[0-9a-f]{8}$/i.test(fg.argb)) {
    const hex = `#${fg.argb.slice(2).toUpperCase()}`;
    return hex === '#FFFFFF' ? null : hex;
  }
  return null;
}

// The sheet's own default family/size: whatever most of its real cells use.
// Derived from the document rather than assumed, so a form set in Calibri 10
// and one set in Aptos Narrow 10 each get their own baseline and each emits
// per-cell overrides only where the document genuinely departs from it.
// Ties are broken by first-seen, which is arbitrary but harmless: the default
// and the per-cell overrides are computed from the same tally, so whichever
// value wins, every cell still renders at the size and family it carries.
function modal(counts, fallback) {
  let best = fallback, seen = -1;
  for (const [value, n] of counts) if (n > seen) { best = value; seen = n; }
  return best;
}

// Map every cell covered by a merge to its anchor, so covered cells can be
// skipped and the anchor can carry the span.
//
// Exported because excel-parser.js needs the SAME notion of "covered" when it
// locates the cells an entered value belongs in: a coordinate this function
// reports as covered is never rendered by buildGrid below, so pointing a
// field at one would silently drop the technician's value. One definition,
// used by both, is the only way those two can never disagree.
export function mergeMap(ws) {
  const spans = new Map();
  const covered = new Set();
  for (const range of Object.values(ws.model.merges ?? {})) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (!m) continue;
    const toNum = (s) => [...s].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);
    const c1 = toNum(m[1]), r1 = Number(m[2]), c2 = toNum(m[3]), r2 = Number(m[4]);
    spans.set(`${r1}:${c1}`, { rows: r2 - r1 + 1, cols: c2 - c1 + 1 });
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++)
        if (!(r === r1 && c === c1)) covered.add(`${r}:${c}`);
  }
  return { spans, covered };
}

// A side's Excel border style ('thin', 'medium', 'double', ...) or null,
// hoisted above buildGrid so the trimming scan below and the per-cell body
// further down share one definition.
function borderSide(b) { return b?.style ? String(b.style) : null; }

// The frame around a MERGED box.
//
// Excel does not keep a merge's outline on its anchor: it keeps it on the cells
// the merge COVERS, each carrying the segment of the perimeter that runs along
// its own edge. The header box that holds the company logo on all twelve of
// these documents is exactly that shape — the anchor declares only a top and a
// left, while the bottom lives on the cell below it and the right on the cell
// beside it — so reading the anchor alone drew that box with two of its four
// sides missing, and the archived record's header did not close.
//
// So each side is taken from the whole run of cells along it, anchor included:
// the anchor's own declaration first (it is the cell the document names), then
// the rest of that edge, first one found. A merge whose edge changes style
// half-way along is drawn in the style it starts with — this model states ONE
// style per side, and the alternative (silently dropping the rest of the box)
// is what was already wrong.
//
// A 1x1 cell has no covered cells, so this returns exactly what it always did.
function mergedBorders(ws, row, col, span) {
  const rows = Math.max(1, span?.rows ?? 1);
  const cols = Math.max(1, span?.cols ?? 1);
  const at = (r, c) => ws.getRow(r).getCell(c).border ?? {};
  const along = (side, coords) => {
    for (const [r, c] of coords) {
      const style = borderSide(at(r, c)[side]);
      if (style) return style;
    }
    return null;
  };
  const across = (r) => Array.from({ length: cols }, (_, i) => [r, col + i]);
  const down = (c) => Array.from({ length: rows }, (_, i) => [row + i, c]);
  const borders = {};
  for (const [key, side, coords] of [
    ['t', 'top', across(row)],
    ['b', 'bottom', across(row + rows - 1)],
    ['l', 'left', down(col)],
    ['r', 'right', down(col + cols - 1)]
  ]) {
    const style = along(side, coords);
    if (style) borders[key] = style;
  }
  return borders;
}

// The sheet's own declared columnCount/rowCount routinely runs past what the
// form actually uses — Excel's print area stops short of it. Rendering the
// surplus draws a dead strip with no content and no border, past which the
// table's own outer frame still sits: the "warp" a user sees on a printed
// form's on-screen preview. This finds the last column and row that carry
// anything real ANYWHERE in the sheet — text, or a border on any side, on
// ANY cell, including one a merge covers, since Excel can still write a
// border on a covered cell that forms the merge's own visual perimeter.
// Nothing past that point is emitted below.
function realExtent(ws) {
  let lastCol = 0, lastRow = 0;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = row.getCell(c);
      const text = cell.value == null ? '' : String(cell.text ?? cell.value).trim();
      const b = cell.border ?? {};
      const hasBorder = !!(borderSide(b.top) || borderSide(b.right) || borderSide(b.bottom) || borderSide(b.left));
      if (text || hasBorder) {
        if (c > lastCol) lastCol = c;
        if (r > lastRow) lastRow = r;
      }
    }
  }
  // A wholly empty sheet (no test fixture does this) falls back to the
  // sheet's own declared extent rather than trimming to nothing.
  return {
    maxCol: lastCol > 0 ? lastCol : ws.columnCount,
    maxRow: lastRow > 0 ? lastRow : ws.rowCount
  };
}

// What the AUTHOR said about printing this sheet, read off the worksheet
// rather than inferred: eleven of the twelve controlled documents carry an
// explicit page setup, and it answers most of the layout question outright.
//
//   orientation portrait, fitToWidth 1, fitToHeight 1, scale 72-80,
//   printArea A1:Q39 (and so on)
//
// `fitToWidth: 1` with `fitToHeight: 1` is the author stating that the form is
// a ONE-PAGE document — which is exactly the claim the archived PDF was
// failing, coming out at three to six pages. `scale` is the shrink factor they
// chose themselves, and is honoured as an upper bound rather than reinvented.
// `printArea` states where the form ends, which is strictly better evidence
// than the content scan below: see realExtent's caller.
//
// A sheet that declares nothing (one of the twelve does) yields nulls
// throughout and every consumer falls back to computing its own fit.
function parsePrintArea(area) {
  const m = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(String(area ?? '').trim().toUpperCase());
  if (!m) return null;
  const toNum = (s) => [...s].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);
  const [firstCol, firstRow, lastCol, lastRow] = [toNum(m[1]), Number(m[2]), toNum(m[3]), Number(m[4])];
  // Only a print area anchored at A1 is used as an extent. Every one of the
  // twelve is, and a region starting elsewhere would mean the printed form is
  // a WINDOW onto the sheet — a different thing entirely from "the form ends
  // here", and not something to assume on a controlled document.
  if (firstCol !== 1 || firstRow !== 1) return null;
  return { maxCol: lastCol, maxRow: lastRow };
}

// ---------------------------------------------------------------------------
// The company logo
// ---------------------------------------------------------------------------
// Every one of the twelve controlled documents embeds exactly one image, and
// on the printed form it fills the framed box at the top-left of the header —
// the box the archived record was leaving empty. A quality record whose header
// is missing the company mark does not look like the document it claims to be,
// which is the whole complaint this model exists to answer.
//
// ExcelJS resolves `xl/drawings/drawing1.xml` into a range and offers a ready
// FRACTIONAL cell position on it (`tl.col`, `br.col`). Those are NOT used:
// measured against the drawing XML on the twelve real forms they disagree with
// the file — one document anchors its logo 88,215 EMU into a column 552,450 EMU
// wide, a sixth of the way in, and ExcelJS reports that as a whole column in,
// which drew that form's logo at a third of its size and in the wrong place.
// What IS used is the raw anchor the file states — `nativeCol` plus
// `nativeColOff` in EMU — converted against THIS MODEL'S own column widths and
// row heights, so the rectangle is expressed in the same geometry the cells are
// laid out in and cannot drift from it.
//
// What is reported is a rectangle in the grid's OWN coordinates — one-based
// fractional column and row positions, matching `columns[i].index` and
// `rows[i].index` — plus the image bytes. Neither renderer is told a size in
// pixels or points: web/js/sheet-layout.js turns the rectangle into each
// medium's units, and each renderer fits the image INSIDE it preserving the
// aspect ratio, so the mark can never come out stretched.
//
// A form with no image yields null and every consumer draws nothing. An image
// whose anchor cannot be resolved is likewise dropped rather than guessed at:
// a logo in the wrong place on a controlled document is worse than none.
const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif' };
// Office's own units. A column is measured in PIXELS here (as `columns[i].width`
// is) and a row in POINTS (as `rows[i].height` is), so the two axes convert
// differently — the same split the rest of this model already carries.
const EMU_PER_PX = 9525;
const EMU_PER_PT = 12700;

// Where a one-based fractional position lands after moving `amount` further
// along a run of cell sizes. Used only for a ONE-cell anchor, which states its
// extent as a size rather than as a far corner.
function advanceAlong(sizes, start, amount) {
  if (!(amount > 0)) return null;
  let position = start;
  let left = amount;
  while (left > 0 && position < sizes.length + 1) {
    const size = sizes[Math.min(Math.floor(position), sizes.length) - 1] || 1;
    const room = size * (Math.floor(position) + 1 - position) || size;
    if (left <= room) return position + left / size;
    left -= room;
    position = Math.floor(position) + 1;
  }
  return sizes.length + 1;
}

function imageOf(wb, ws, columns, rows) {
  const images = typeof ws.getImages === 'function' ? ws.getImages() : [];
  if (!images.length) return null;
  const anchor = images[0];
  const media = typeof wb.getImage === 'function' ? wb.getImage(anchor.imageId) : null;
  const mime = IMAGE_MIME[String(media?.extension ?? '').toLowerCase()];
  if (!media || !mime || !media.buffer?.length) return null;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // One-based fractional position of an anchor point, clamped to the grid this
  // model actually emits: a whole cell index plus how far into that cell the
  // stated offset reaches. `sizes` are the model's own cell sizes on that axis
  // and `perUnit` the EMU in one of them.
  const positionOf = (index, offsetEmu, sizes, perUnit) => {
    if (index == null || offsetEmu == null) return null;
    if (index >= sizes.length) return sizes.length + 1;
    const size = sizes[Math.max(0, index)] || 1;
    const fraction = Math.min(1, Math.max(0, (offsetEmu / perUnit) / size));
    return Math.min(sizes.length + 1, index + 1 + fraction);
  };

  const widths = columns.map((c) => c.width ?? 0);
  const heights = rows.map((r) => r.height ?? 15);
  const point = (a) => (a ? {
    col: positionOf(num(a.nativeCol), num(a.nativeColOff), widths, EMU_PER_PX),
    row: positionOf(num(a.nativeRow), num(a.nativeRowOff), heights, EMU_PER_PT)
  } : null);

  const from = point(anchor.range?.tl);
  if (!from || from.col == null || from.row == null) return null;

  // A two-cell anchor states its far corner; a one-cell anchor states a SIZE in
  // pixels instead, which is walked out along the same widths and heights.
  let to = point(anchor.range?.br);
  const ext = anchor.range?.ext;
  if ((!to || to.col == null || to.row == null) && ext) {
    to = {
      col: advanceAlong(widths, from.col, num(ext.width)),
      row: advanceAlong(heights, from.row, num(ext.height) * 0.75)
    };
  }
  if (!to || to.col == null || to.row == null) return null;
  if (to.col <= from.col || to.row <= from.row) return null;

  return { mime, data: media.buffer.toString('base64'), from, to };
}

function pageSetupOf(ws) {
  const ps = ws.pageSetup ?? {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    orientation: typeof ps.orientation === 'string' ? ps.orientation : null,
    scale: num(ps.scale),
    fitToWidth: num(ps.fitToWidth),
    fitToHeight: num(ps.fitToHeight),
    printArea: parsePrintArea(ps.printArea)
  };
}

export async function buildGrid(path, definition = null) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];

  const pageSetup = pageSetupOf(ws);
  // Where the form ends. Two independent answers, and the SMALLER wins:
  //  - the author's declared print area, which is a statement of intent;
  //  - realExtent()'s scan for the last cell carrying text or a border, which
  //    is a heuristic.
  // Taking the smaller means the print area can trim material the scan found
  // OUTSIDE what the form prints — on one of the twelve that is ten columns of
  // off-print working notes, which is why that form was rendering at 1,699px
  // wide against its siblings' ~920 — while a print area that reaches past the
  // real content never pads the document out with declared-but-empty columns.
  //
  // What this deliberately cannot do is print something the author excluded.
  // That is the point: the printed form is the controlled document. The guard
  // against trimming too far is the cell-map test — every coordinate a value
  // can be written into must be one the rendered grid still contains — so a
  // print area that cut a fillable box would fail the suite rather than
  // silently drop a technician's entry.
  const scanned = realExtent(ws);
  const maxCol = pageSetup.printArea ? Math.min(pageSetup.printArea.maxCol, scanned.maxCol) : scanned.maxCol;
  const maxRow = pageSetup.printArea ? Math.min(pageSetup.printArea.maxRow, scanned.maxRow) : scanned.maxRow;
  const columns = [];
  for (let c = 1; c <= maxCol; c++) {
    const w = ws.getColumn(c).width ?? DEFAULT_COL_WIDTH;
    columns.push({ index: c, width: Math.round(w * PX_PER_CHAR) });
  }

  const { spans, covered } = mergeMap(ws);

  // Rows that carry an actual maintenance task (per the parsed definition),
  // so the left pane can dim rows the current interval does not cover.
  // definition is optional so existing single-argument callers keep working.
  const taskRows = new Set((definition?.tasks ?? []).map((t) => t.row));

  // The style string is kept verbatim rather than reduced to a weight, so the
  // renderer decides how to draw it and this model stays a faithful record of
  // what the document says.
  const side = borderSide;

  const sizes = new Map();
  const families = new Map();
  const tally = (map, key) => { if (key != null) map.set(key, (map.get(key) ?? 0) + 1); };

  const rows = [];
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    const cells = [];
    let hasReal = false;
    for (let c = 1; c <= maxCol; c++) {
      // Covered by a merge: the anchor's span already accounts for this
      // column, in this row and in every row the merge reaches down into.
      // Nothing may be emitted here, placeholder included.
      if (covered.has(`${r}:${c}`)) continue;
      const cell = row.getCell(c);
      const text = cell.value == null ? '' : String(cell.text ?? cell.value).trim();
      // A merge is clamped to the trimmed extent before anything else looks at
      // it, so the frame below is read from the perimeter of the box that will
      // actually be DRAWN, not from one reaching past the form's last column.
      const merge = spans.get(`${r}:${c}`);
      const span = merge && {
        rows: Math.min(merge.rows, maxRow - r + 1),
        cols: Math.min(merge.cols, maxCol - c + 1)
      };
      const b = cell.border ?? {};
      const borders = span && (span.rows > 1 || span.cols > 1)
        ? mergedBorders(ws, r, c, span)
        : (() => {
          const own = {};
          for (const [key, source] of [['t', b.top], ['r', b.right], ['b', b.bottom], ['l', b.left]]) {
            const style = side(source);
            if (style) own[key] = style;
          }
          return own;
        })();
      const hasBorder = Object.keys(borders).length > 0;
      if (!text && !hasBorder && !spans.has(`${r}:${c}`)) {
        // Blank, unbordered, unmerged: hold the column open so everything to
        // its right keeps its place. One placeholder per column, never a run
        // collapsed under a span, so that every column of the row is
        // addressable by its own coordinate. It carries nothing else: a
        // placeholder is not part of the document and must not draw one.
        cells.push({ col: c, filler: true });
        continue;
      }
      hasReal = true;

      const align = cell.alignment?.horizontal;
      const valign = cell.alignment?.vertical;
      const size = typeof cell.font?.size === 'number' ? cell.font.size : null;
      const family = typeof cell.font?.name === 'string' ? cell.font.name : null;
      const fill = fillColour(cell.fill);
      tally(sizes, size);
      tally(families, family);

      const out = { col: c, text };
      // A merge can reach past the trimmed extent (its anchor real, its tail
      // cells blank/unbordered and therefore not what pushed the extent out).
      // It was clamped above so the tiling invariant still holds exactly
      // against the trimmed column/row count; a clamp that leaves it 1x1 drops
      // the span entirely — same convention as never spanning.
      if (span && (span.rows > 1 || span.cols > 1)) out.span = span;
      if (cell.font?.bold) out.bold = true;
      if (align && align !== 'left') out.align = align;
      if (hasBorder) out.borders = borders;
      if (fill) out.fill = fill;
      if (valign) out.valign = valign;
      if (cell.alignment?.wrapText) out.wrap = true;
      if (size != null) out.size = size;
      if (family != null) out.font = family;
      cells.push(out);
    }
    // A row of nothing but placeholders is a blank spacer row: emit nothing,
    // as before, so the renderer keeps skipping it.
    rows.push({ index: r, height: Math.round(row.height ?? 15), isTask: taskRows.has(r), cells: hasReal ? cells : [] });
  }

  // Second pass: now that the sheet's own baseline is known, drop the size and
  // family from every cell that merely agrees with it. Nothing is lost — the
  // renderer sets the baseline once on the table — and on the current corpus
  // this is the difference between ~6,500 redundant declarations and a few
  // hundred meaningful ones.
  const defaults = { size: modal(sizes, 10), font: modal(families, null) };
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.size === defaults.size) delete cell.size;
      if (cell.font === defaults.font) delete cell.font;
    }
  }

  // The logo is placed against the columns and rows this model has just
  // settled, so it can never be measured against a different geometry from the
  // cells it sits among.
  return { columns, rows, defaults, pageSetup, image: imageOf(wb, ws, columns, rows) };
}
