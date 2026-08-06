// Turns a parsed form definition into the map the left-hand preview needs:
// which cell of the reproduced sheet each entered value belongs in.
//
// This is deliberately a pure function of the definition, with no worksheet
// and no I/O, so the rule "a value is placed only where the document itself
// puts one" is testable without a spreadsheet and cannot drift between the
// preview and the archived PDF.
//
// The field-key convention it consumes is the one server/scanner.js emits:
// `task_<sheetRow>` for a task's status, `part_<sheetRow>_<no|desc|qty|remarks>`
// for one box of the Parts Required table, plus the fixed `special_tools`,
// `remarks` and `sig_<stage>` keys. A key is present in the result ONLY when
// its cell is determinate. Two of the twelve controlled documents have no
// Status column at all, so their task statuses have nowhere on the sheet to
// go: they are omitted here rather than being placed in a neighbouring
// column, which would print a technician's "OK" against the wrong heading.

import { findIntervalCodes, ORDER, covers } from './intervals.js';

// One box of the Parts Required table, or null. Exported so anything that has
// to reason about a parts row as a ROW — the archived record skips a row nobody
// filled in — asks this rather than carrying its own copy of the key shape.
const PARTS_KEY = /^part_(\d+)_(no|desc|qty|remarks)$/;
export function parsePartsKey(fieldKey) {
  const m = PARTS_KEY.exec(String(fieldKey ?? ''));
  return m ? { row: Number(m[1]), column: m[2] } : null;
}

// Column letter to 1-based index: A -> 1, M -> 13, AA -> 27. Returns null for
// anything that is not a column letter (including the null the parser reports
// for a form with no Status column), so callers can test it as a single
// truthy check.
export function columnNumber(letter) {
  const s = String(letter ?? '').toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return null;
  return [...s].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);
}

// Where one option's own words begin inside a cell that prints several.
//
// The options are separated by a run of whitespace (these sheets pad them
// apart with long space runs) while the words WITHIN an option are separated
// by single spaces, so the start is: after the last gap of two or more
// whitespace characters between the previous option's code and this one;
// failing that, straight after the previous option's code; failing that, the
// start of the cell. Any whitespace still leading is then stepped over so the
// marked run begins on a word.
//
// Deriving the start from the gap rather than from the wording is what makes
// this work on documents whose prose differs, and on a cell that opens with a
// caption before the first option.
function optionStart(text, from, codeStart) {
  let start = from;
  for (const gap of text.slice(from, codeStart).matchAll(/\s{2,}/g)) {
    start = from + gap.index + gap[0].length;
  }
  while (start < codeStart && /\s/.test(text[start])) start += 1;
  return start;
}

// Which option of the printed frequency band each interval is, so both
// renderers can draw the band's CHECKBOXES exactly where the form prints them
// and tick the ones this visit covers, as a technician does in pen on paper.
//
// Keyed by interval code; each entry names the cell that carries the option
// AND the character range of the option inside that cell's rendered text.
// A form whose band prints each option in its own cell yields a range
// covering the whole of that cell's text, so there is one shape for callers
// to handle rather than two. `text` is the option as printed, carried along
// so a client can confirm the range still delimits what it thinks it does
// before drawing anything over a controlled document's text.
//
// EVERY option the band PRINTS is reported, whether or not this document has
// tasks at that interval, because the printed form draws a box for every one
// of them — they are rectangle shapes anchored on the band's row in the sheet's
// drawing XML, four of them on documents whose task list only reaches 3M — and
// the completed records the customer keeps show all four boxes with the covered
// ones ticked. An option the band does not print at all (one of the twelve has
// no yearly option) is still simply absent: a position is never guessed.
//
// `tickedBy` is which selected intervals put a tick in this box, and it is
// stated here so the two renderers can never disagree about it.
//
// EXACTLY ONE box is ticked: the interval of this visit. An earlier version
// ticked cumulatively — a six-monthly visit marking 1M, 3M and 6M — on the
// stated grounds that the customer's completed records showed that. They do
// not. Four of their archived records were checked against this directly and
// every one carries a single tick: MB shows 1M alone, DP and KW show 3M alone,
// AVS shows 1M alone.
//
// The cumulative rule (server/intervals.js) is a different question with a
// different answer. It decides which TASKS this visit must cover — a yearly
// service does include the 3M and 6M work, which is why selecting Y puts 18
// tasks in scope and not 1. But the band records WHICH VISIT THIS IS, and a
// technician ticks one box. Conflating the two put three ticks on a record
// that should carry one.
export function intervalMarksFor(definition) {
  const marks = {};
  for (const cell of definition?.cells?.frequencyBand ?? []) {
    const text = String(cell?.text ?? '');
    const codes = findIntervalCodes(text);
    codes.forEach((code, i) => {
      if (marks[code.code]) return;
      const start = optionStart(text, i ? codes[i - 1].end : 0, code.start);
      marks[code.code] = {
        row: cell.row, col: cell.col,
        start, end: code.end, text: text.slice(start, code.end),
        tickedBy: [code.code]
      };
    });
  }
  return marks;
}

export function cellMapFor(definition) {
  const cellFor = {};
  const cells = definition?.cells ?? {};

  // Every task's status goes in the Status column, on that task's own sheet
  // row — the row the field key is built from. Exact, not heuristic.
  const statusCol = columnNumber(definition?.statusColumn);
  if (statusCol) {
    for (const t of definition?.tasks ?? []) {
      if (Number.isInteger(t?.row)) cellFor[`task_${t.row}`] = { row: t.row, col: statusCol };
    }
  }

  // Each empty box of the Parts Required table, keyed by its sheet row and its
  // column's name — the same `<thing>_<sheetRow>` shape as task_<row>, so a
  // field name resolves to a coordinate by arithmetic rather than by a lookup
  // table. Both halves are checked for being real integers: a definition whose
  // parts table is absent or malformed must contribute no coordinates at all
  // rather than a {row: undefined, col: NaN} that no cell could ever match.
  for (const row of definition?.parts?.rows ?? []) {
    if (!Number.isInteger(row)) continue;
    for (const [name, col] of Object.entries(definition.parts.columns ?? {})) {
      if (Number.isInteger(col)) cellFor[`part_${row}_${name}`] = { row, col };
    }
  }

  // The parser reports null for any of these it could not locate on the
  // sheet; a null must stay out of the map entirely.
  if (cells.special_tools) cellFor.special_tools = { ...cells.special_tools };
  if (cells.remarks) cellFor.remarks = { ...cells.remarks };
  for (const [stage, cell] of Object.entries(cells.signatures ?? {})) {
    if (cell) cellFor[`sig_${stage}`] = { ...cell };
  }

  // The title cell is NOT a destination for a value — the machine ID fills a
  // blank inside the printed title rather than replacing it — so it travels
  // separately and can never be treated as an ordinary write target. The same
  // is true of the frequency band: its boxes are ticked beside options the
  // document already prints, never written into an empty cell.
  return {
    cellFor,
    titleCell: cells.title ?? null,
    intervalCells: intervalMarksFor(definition)
  };
}
