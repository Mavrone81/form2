import ExcelJS from 'exceljs';
import { ORDER } from './intervals.js';

const txt = (cell) => (cell?.value == null ? '' : String(cell.text ?? cell.value).trim());
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// Column letter for a 1-based column index: 1 -> A, 27 -> AA.
function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
}

function findCell(ws, predicate, maxRow = ws.rowCount) {
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= (row.cellCount || 0); c++) {
      const v = txt(row.getCell(c));
      if (v && predicate(norm(v))) return { row: r, col: c, value: v };
    }
  }
  return null;
}

function rightOf(ws, row, col) {
  for (let c = col + 1; c <= col + 12; c++) {
    const v = txt(ws.getRow(row).getCell(c));
    if (v) return v;
  }
  return '';
}

export async function parseWorkbook(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  // Sheet names are inconsistent and non-unique across files. Index only.
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('workbook has no worksheets');

  const titleAnchor = findCell(ws, (v) => v.startsWith('document title'), 6);
  const numAnchor = findCell(ws, (v) => v.startsWith('document number'), 6);
  const revAnchor = findCell(ws, (v) => v.startsWith('revision'), 6);
  const pageAnchor = findCell(ws, (v) => v === 'page', 6);
  const below = (a) => (a ? txt(ws.getRow(a.row + 1).getCell(a.col)) : '');

  // Task header: the row carrying No + Freq + Instruction together.
  let header = null;
  for (let r = 1; r <= ws.rowCount && !header; r++) {
    const row = ws.getRow(r);
    let no = null, freq = null, instr = null, status = null;
    for (let c = 1; c <= (row.cellCount || 0); c++) {
      const v = norm(txt(row.getCell(c)));
      // Multi-column headers (Instruction, Status) are merged across a
      // range; take the leftmost (merge-master) column. Some rows in some
      // files drop the merge for that row alone (a real, unnumbered task
      // row observed in the sample data), leaving only the master column
      // populated — reading a later column would see blank and misfire the
      // table-termination check.
      if (v === 'no' && no == null) no = c;
      else if (v.startsWith('freq') && freq == null) freq = c;
      else if (v.startsWith('instruction') && instr == null) instr = c;
      else if (v.startsWith('status') && status == null) status = c;
    }
    if (no != null && freq != null && instr != null) header = { r, no, freq, instr, status };
  }
  if (!header) throw new Error('no task table found');

  // Terminate on a blank Instruction, never on a blank No: one sample form
  // has a real task with an empty No cell and a gap in its numbering.
  const tasks = [];
  for (let r = header.r + 1; r <= ws.rowCount; r++) {
    const instruction = txt(ws.getRow(r).getCell(header.instr));
    if (!instruction) break;
    const rawNo = txt(ws.getRow(r).getCell(header.no));
    tasks.push({
      no: /^\d+$/.test(rawNo) ? Number(rawNo) : null,
      freq: txt(ws.getRow(r).getCell(header.freq)).toUpperCase(),
      instruction,
      row: r
    });
  }

  const partsAnchor = findCell(ws, (v) => v.startsWith('parts required'));
  let partsRows = 0;
  if (partsAnchor) {
    for (let r = partsAnchor.row + 1; r < header.r; r++) {
      if (txt(ws.getRow(r).getCell(partsAnchor.col + 3))) break;
      partsRows++;
    }
  }

  const ppeAnchor = findCell(ws, (v) => v.startsWith('ppe required'));
  const ppe = [];
  if (ppeAnchor) {
    for (let r = ppeAnchor.row; r < ppeAnchor.row + 8; r++) {
      const v = rightOf(ws, r, ppeAnchor.col + 1);
      if (v) ppe.push(v);
    }
  }
  const sectionText = (start) => {
    const a = findCell(ws, (v) => v.startsWith(start));
    return a ? rightOf(ws, a.row, a.col) : '';
  };

  const freqs = ORDER.filter((f) => tasks.some((t) => t.freq === f));

  return {
    title: below(titleAnchor),
    docNumber: below(numAnchor),
    revision: below(revAnchor),
    page: below(pageAnchor),
    frequencies: freqs,
    statusColumn: header.status ? colLetter(header.status) : null,
    tasks,
    partsRows,
    sections: {
      safety: sectionText('safety'),
      procedure: sectionText('procedure'),
      ppe,
      remarks: sectionText('remarks')
    },
    signatures: [
      { key: 'technician', label: 'Maintenance performed by' },
      { key: 'team_leader', label: 'Verified by (Workshop Team Leader)' },
      { key: 'engineer', label: 'Verified by (Workshop Supervisor/Engr)' }
    ]
  };
}
