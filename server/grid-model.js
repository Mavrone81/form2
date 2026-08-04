import ExcelJS from 'exceljs';

const DEFAULT_COL_WIDTH = 8.43;
const PX_PER_CHAR = 7.5;

export async function buildGrid(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];

  const maxCol = ws.columnCount;
  const columns = [];
  for (let c = 1; c <= maxCol; c++) {
    const w = ws.getColumn(c).width ?? DEFAULT_COL_WIDTH;
    columns.push({ index: c, width: Math.round(w * PX_PER_CHAR) });
  }

  // Map every cell covered by a merge to its anchor, so covered cells can be
  // skipped and the anchor can carry the span.
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

  const side = (b) => (b?.style ? true : false);
  const rows = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= maxCol; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = row.getCell(c);
      const text = cell.value == null ? '' : String(cell.text ?? cell.value).trim();
      const b = cell.border ?? {};
      const hasBorder = side(b.top) || side(b.right) || side(b.bottom) || side(b.left);
      if (!text && !hasBorder && !spans.has(`${r}:${c}`)) continue;
      cells.push({
        col: c,
        span: spans.get(`${r}:${c}`) ?? { rows: 1, cols: 1 },
        text,
        bold: Boolean(cell.font?.bold),
        align: cell.alignment?.horizontal ?? 'left',
        borders: { t: side(b.top), r: side(b.right), b: side(b.bottom), l: side(b.left) }
      });
    }
    rows.push({ index: r, height: Math.round(row.height ?? 15), cells });
  }
  return { columns, rows };
}
