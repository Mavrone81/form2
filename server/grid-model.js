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

export async function buildGrid(path, definition = null) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];

  const { maxCol, maxRow } = realExtent(ws);
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
      const b = cell.border ?? {};
      const borders = {};
      for (const [key, source] of [['t', b.top], ['r', b.right], ['b', b.bottom], ['l', b.left]]) {
        const style = side(source);
        if (style) borders[key] = style;
      }
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

      const span = spans.get(`${r}:${c}`);
      const align = cell.alignment?.horizontal;
      const valign = cell.alignment?.vertical;
      const size = typeof cell.font?.size === 'number' ? cell.font.size : null;
      const family = typeof cell.font?.name === 'string' ? cell.font.name : null;
      const fill = fillColour(cell.fill);
      tally(sizes, size);
      tally(families, family);

      const out = { col: c, text };
      if (span && (span.rows > 1 || span.cols > 1)) {
        // A merge can reach past the trimmed extent (its anchor real, its
        // tail cells blank/unbordered and therefore not what pushed the
        // extent out). Clamp so the tiling invariant still holds exactly
        // against the trimmed column/row count, and drop the span entirely
        // if clamping leaves it 1x1 — same convention as never spanning.
        const clamped = {
          rows: Math.min(span.rows, maxRow - r + 1),
          cols: Math.min(span.cols, maxCol - c + 1)
        };
        if (clamped.rows > 1 || clamped.cols > 1) out.span = clamped;
      }
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

  return { columns, rows, defaults };
}
