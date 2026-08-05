// Turns a parsed form definition into the map the left-hand preview needs:
// which cell of the reproduced sheet each entered value belongs in.
//
// This is deliberately a pure function of the definition, with no worksheet
// and no I/O, so the rule "a value is placed only where the document itself
// puts one" is testable without a spreadsheet and cannot drift between the
// preview and the archived PDF.
//
// The field-key convention it consumes is the one server/scanner.js emits:
// `task_<sheetRow>` for a task's status, plus the fixed `special_tools`,
// `remarks` and `sig_<stage>` keys. A key is present in the result ONLY when
// its cell is determinate. Two of the twelve controlled documents have no
// Status column at all, so their task statuses have nowhere on the sheet to
// go: they are omitted here rather than being placed in a neighbouring
// column, which would print a technician's "OK" against the wrong heading.

// Column letter to 1-based index: A -> 1, M -> 13, AA -> 27. Returns null for
// anything that is not a column letter (including the null the parser reports
// for a form with no Status column), so callers can test it as a single
// truthy check.
export function columnNumber(letter) {
  const s = String(letter ?? '').toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return null;
  return [...s].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);
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

  // The parser reports null for any of these it could not locate on the
  // sheet; a null must stay out of the map entirely.
  if (cells.special_tools) cellFor.special_tools = { ...cells.special_tools };
  if (cells.remarks) cellFor.remarks = { ...cells.remarks };
  for (const [stage, cell] of Object.entries(cells.signatures ?? {})) {
    if (cell) cellFor[`sig_${stage}`] = { ...cell };
  }

  // The title cell is NOT a destination for a value — the machine ID fills a
  // blank inside the printed title rather than replacing it — so it travels
  // separately and can never be treated as an ordinary write target.
  return { cellFor, titleCell: cells.title ?? null };
}
