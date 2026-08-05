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
// the latter is a real cell and is never flagged. A placeholder carries no
// text, no bold, no borders and never spans. Real cells do not carry the
// flag at all, so test it as `cell.filler === true`.
//
// Two things deliberately emit nothing. A cell a merge covers is left out —
// its anchor carries the span, and re-emitting it would both duplicate the
// column and (a past defect) blank the anchor's content. And a row with no
// real cell at all emits no cells, keeping blank spacer rows out of the
// render and the document's vertical rhythm intact.
const DEFAULT_COL_WIDTH = 8.43;
const PX_PER_CHAR = 7.5;

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

export async function buildGrid(path, definition = null) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];

  const maxCol = ws.columnCount;
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

  const side = (b) => (b?.style ? true : false);
  const filler = (c) => ({
    col: c,
    span: { rows: 1, cols: 1 },
    text: '',
    bold: false,
    align: 'left',
    borders: { t: false, r: false, b: false, l: false },
    filler: true
  });

  const rows = [];
  for (let r = 1; r <= ws.rowCount; r++) {
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
      const hasBorder = side(b.top) || side(b.right) || side(b.bottom) || side(b.left);
      if (!text && !hasBorder && !spans.has(`${r}:${c}`)) {
        // Blank, unbordered, unmerged: hold the column open so everything to
        // its right keeps its place. One placeholder per column, never a run
        // collapsed under a span, so that every column of the row is
        // addressable by its own coordinate.
        cells.push(filler(c));
        continue;
      }
      hasReal = true;
      cells.push({
        col: c,
        span: spans.get(`${r}:${c}`) ?? { rows: 1, cols: 1 },
        text,
        bold: Boolean(cell.font?.bold),
        align: cell.alignment?.horizontal ?? 'left',
        borders: { t: side(b.top), r: side(b.right), b: side(b.bottom), l: side(b.left) }
      });
    }
    // A row of nothing but placeholders is a blank spacer row: emit nothing,
    // as before, so the renderer keeps skipping it.
    rows.push({ index: r, height: Math.round(row.height ?? 15), isTask: taskRows.has(r), cells: hasReal ? cells : [] });
  }
  return { columns, rows };
}
