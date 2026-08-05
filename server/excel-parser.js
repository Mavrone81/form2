import ExcelJS from 'exceljs';
import { ORDER, findIntervalCodes } from './intervals.js';
import { mergeMap } from './grid-model.js';

const txt = (cell) => (cell?.value == null ? '' : String(cell.text ?? cell.value).trim());
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
// Comparison key for a printed label: case- and punctuation-insensitive, so
// the sheet's "Verified By: (Workshop Team Leader)" still matches the
// definition's own "Verified by (Workshop Team Leader)". Deriving the search
// term from SIGNATURE_BLOCKS rather than hardcoding a second list means the
// two can never drift apart.
const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// The three sign-off blocks every one of these controlled documents carries.
// Named once, used both for the definition's `signatures` array and for
// locating each block's printed signature blank.
const SIGNATURE_BLOCKS = [
  { key: 'technician', label: 'Maintenance performed by' },
  { key: 'team_leader', label: 'Verified by (Workshop Team Leader)' },
  { key: 'engineer', label: 'Verified by (Workshop Supervisor/Engr)' }
];

// A printed blank: a cell whose entire content is a run of underscores, i.e.
// the ruled line the form leaves for someone to write on. That is the only
// signal in these sheets that is unambiguously "an entry goes HERE", which
// is why it — and not proximity to a label — decides whether a field has a
// determinate cell at all. A label cell that merely CONTAINS underscores
// (the KNS form writes "Maintenance Performed by:   ______" in one cell) is
// deliberately not a blank: writing into it would erase printed text.
const isPrintedBlank = (s) => /^_{2,}$/.test(s.replace(/\s+/g, ''));

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

// Every cell on `row` at or after `fromCol` whose text is a printed blank and
// which is not swallowed by a merge. Merge-covered coordinates are excluded
// because buildGrid never renders them (see mergeMap): a field pointed at one
// would have nowhere on screen to appear.
function blanksOnRow(ws, row, fromCol, covered) {
  const found = [];
  const r = ws.getRow(row);
  for (let c = fromCol; c <= (r.cellCount || 0); c++) {
    if (covered.has(`${row}:${c}`)) continue;
    if (isPrintedBlank(txt(r.getCell(c)))) found.push({ row, col: c });
  }
  return found;
}

// The cell an entered value belongs in for a labelled field: the first
// printed blank to the right of the label, on the label's own row. Several
// cells can match a label prefix (these forms carry both a "Remarks" column
// header in the parts table and a printed "Remarks:" note lower down), so
// every candidate anchor is tried and the first that actually has a blank
// wins. When none does, this returns null and the field is simply omitted —
// there is no cell on the sheet where that value would land, and inventing
// one would print a technician's words into a cell the document uses for
// something else.
function labelledBlank(ws, prefix, covered) {
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= (row.cellCount || 0); c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const v = txt(row.getCell(c));
      if (!v || !norm(v).startsWith(prefix)) continue;
      const [blank] = blanksOnRow(ws, r, c + 1, covered);
      if (blank) return blank;
    }
  }
  return null;
}

// Where a signature block's signer name goes: the leftmost printed blank on
// the row BELOW the block's label, which on these forms is the ruled
// signature line (the blank further right on that same row is the date).
// A form that prints its signature line inside the label cell itself has no
// separate blank on the next row, so this returns null and that block is
// omitted rather than having the name written over the date.
function signatureBlank(ws, label, covered) {
  const want = flat(label);
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= (row.cellCount || 0); c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const v = txt(row.getCell(c));
      if (!v || !flat(v).startsWith(want)) continue;
      return blanksOnRow(ws, r + 1, 1, covered)[0] ?? null;
    }
  }
  return null;
}

// The frequency band: the printed strip of interval options above the task
// table, one of which a technician RINGS on paper to say which service this
// visit is. Returned as the cells that carry an option code, with the same
// trimmed text buildGrid renders, so a caller can point inside one of them.
//
// Located by scanning the rows above the task header for the parenthesised
// codes themselves — never by row or column number, which move between
// documents, and never by the surrounding prose, which differs too. The first
// row above the header that carries any code is the band; a later mention (a
// remark that says a yearly service includes the 3M work, say) is not.
//
// Two shapes exist in the twelve controlled documents and both come out of
// here identically: one prints each option in a cell of its own, the other
// prints them all inside a single wide cell. Merge-covered coordinates are
// skipped for the same reason as everywhere else here — buildGrid never
// renders them, so nothing could be shown at one.
function frequencyBand(ws, beforeRow, covered) {
  for (let r = 1; r < beforeRow; r++) {
    const row = ws.getRow(r);
    const found = [];
    for (let c = 1; c <= (row.cellCount || 0); c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const text = txt(row.getCell(c));
      if (text && findIntervalCodes(text).length) found.push({ row: r, col: c, text });
    }
    if (found.length) return found;
  }
  return [];
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
    let no = null, freq = null, instr = null;
    const statusMatches = [];
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
      // Collect every fuzzy "status..." match rather than latching onto the
      // first: a stray earlier cell (e.g. a decoy that happens to start
      // with "status") must not shadow the real Status column that follows
      // Instruction — see the ascending-order pick below.
      else if (v.startsWith('status')) statusMatches.push(c);
    }
    // Structural invariant for this template: columns always appear in
    // ascending order No < Freq < Instruction < Status. A fuzzy keyword
    // match out of that order (e.g. a decoy cell whose text happens to
    // start with a keyword) must not be accepted — require ascending order
    // to qualify as the header row at all, and pick only a status column
    // that is strictly to the right of Instruction, falling back to "no
    // status column" (null) rather than accepting a bogus earlier match.
    if (no != null && freq != null && instr != null && no < freq && freq < instr) {
      const status = statusMatches.find((c) => c > instr) ?? null;
      header = { r, no, freq, instr, status };
    }
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

  // Where an entered value belongs on the sheet. Each entry is either an
  // exact (row, col) the grid genuinely renders, or null — never a guess.
  // The client writes values only into the cells named here, so a null is a
  // field that stays in the right-hand panel and off the preview.
  const { covered } = mergeMap(ws);
  const cells = {
    title: titleAnchor ? { row: titleAnchor.row + 1, col: titleAnchor.col } : null,
    special_tools: labelledBlank(ws, 'special tool', covered),
    remarks: labelledBlank(ws, 'remark', covered),
    signatures: Object.fromEntries(
      SIGNATURE_BLOCKS.map((s) => [s.key, signatureBlank(ws, s.label, covered)])
    ),
    frequencyBand: frequencyBand(ws, header.r, covered)
  };

  return {
    title: below(titleAnchor),
    docNumber: below(numAnchor),
    revision: below(revAnchor),
    page: below(pageAnchor),
    frequencies: freqs,
    statusColumn: header.status ? colLetter(header.status) : null,
    tasks,
    cells,
    partsRows,
    sections: {
      safety: sectionText('safety'),
      procedure: sectionText('procedure'),
      ppe,
      remarks: sectionText('remarks')
    },
    signatures: SIGNATURE_BLOCKS.map((s) => ({ ...s }))
  };
}
