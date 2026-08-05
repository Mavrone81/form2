// Renders the left pane: an HTML table mirroring the sheet for xlsx forms,
// or the browser's own PDF viewer for pdf forms.
//
// The sheet is rendered WITH the record's entered values merged into it, in
// the cells the server says each value belongs in (see server/cell-map.js).
// The point of "form on the left, fields on the right" is that the left pane
// shows the record as it will look on paper — a preview of the blank form is
// not that. Values are placed only at coordinates the server reports as
// determinate; a field with no known cell simply does not appear here.
//
// Nothing rendered here is editable, ever. This pane is a reproduction of a
// controlled document, so an approved (read-only) record renders exactly the
// same way a draft does — with its values shown and nothing to type into.

// A machine ID filled into the blank the printed title leaves for it, e.g.
// "BESI Die Attach Preventive Maintenance Record ED____" with machine ID
// "ED04" reads "...Record ED04". Display only: the stored title and the
// source file are never touched.
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

// What an entered value looks like inside the reproduced sheet: the value
// itself in a `.entry` span, or — when the value is cleared — the cell's own
// printed text back exactly as the document had it (a status cell is empty;
// a signature line is its row of underscores).
//
// textContent only. Cell text and entered values both originate in
// spreadsheets or in what a technician typed, and neither is ever markup.
function paintCell(td, printed, value) {
  const text = String(value ?? '').trim();
  td.replaceChildren();
  if (!text) {
    td.textContent = printed;
    td.classList.remove('has-entry');
    return;
  }
  const span = document.createElement('span');
  span.className = 'entry';
  span.textContent = text;
  td.append(span);
  td.classList.add('has-entry');
}

const at = (cell) => `${cell.row}:${cell.col}`;

// Attribution for a signed stage, shown in the sheet's own signature blank.
// Name and timestamp, never the image: the stored PNG is a wide, shallow
// stroke and a table cell would squash it out of recognition — a distorted
// signature on a quality record is worse than no image at all. The ink stays
// where it renders honestly: the right-hand panel and the archived PDF.
function signatureText(signature) {
  if (!signature) return '';
  const when = signature.signed_at ? new Date(signature.signed_at).toLocaleString() : '';
  return [signature.full_name, when].filter(Boolean).join(' · ');
}

export function renderForm(container, form, {
  grid, inScopeRows, values, cellFor, titleCell, machineId, signatures
} = {}) {
  container.replaceChildren();
  // Any preview state from a previously rendered form is stale the moment
  // this container is cleared — drop it before anything can consult it.
  container.preview = null;

  if (form.file_type === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = `/api/forms/${form.id}/file`;
    frame.title = form.file_name;
    frame.style.cssText = 'width:100%;height:80vh;border:1px solid var(--rule)';
    container.append(frame);
    return;
  }

  const table = document.createElement('table');
  table.className = 'sheet';
  const colgroup = document.createElement('colgroup');
  for (const c of grid.columns) {
    const col = document.createElement('col');
    col.style.width = `${c.width}px`;
    colgroup.append(col);
  }
  table.append(colgroup);

  // Coordinate -> text to show, built once. Only keys the server gave a cell
  // for are considered, so an unmapped field cannot land anywhere.
  const map = cellFor ?? {};
  const byKey = new Map((values ?? []).map((v) => [v.field_key, v.value]));
  const signed = new Map((signatures ?? []).map((s) => [s.stage, s]));
  const entries = new Map();
  for (const [key, cell] of Object.entries(map)) {
    if (!cell) continue;
    const text = key.startsWith('sig_')
      ? signatureText(signed.get(key.slice(4)))
      : (byKey.get(key) ?? '');
    if (String(text ?? '').trim()) entries.set(at(cell), text);
  }

  // Live single-cell updates need three things later: the <td> at each mapped
  // coordinate, that cell's own printed text (to restore when a value is
  // cleared), and the title cell. Kept on the container, as the field panel
  // already keeps its signature pads.
  const state = { cellFor: map, cells: new Map(), printed: new Map(), titleTd: null, titlePrinted: '' };

  const inScope = inScopeRows ? new Set(inScopeRows) : null;
  const body = document.createElement('tbody');
  for (const row of grid.rows) {
    if (!row.cells.length) continue;
    const tr = document.createElement('tr');
    // Only rows that are actually task rows can be out of scope. `inScope`
    // is null only when no filter is applied at all (nothing dimmed); once a
    // filter exists, even an EMPTY array is a real filter that puts every
    // task row out of scope, so the guard must not also require `.size` —
    // that would silently disable dimming for the very case (a frequency
    // covering zero tasks) it exists to catch.
    if (inScope && row.isTask && !inScope.has(row.index)) tr.className = 'row-out';
    for (const cell of row.cells) {
      const td = document.createElement('td');
      if (cell.span.cols > 1) td.colSpan = cell.span.cols;
      if (cell.span.rows > 1) td.rowSpan = cell.span.rows;
      td.textContent = cell.text;
      if (cell.bold) td.style.fontWeight = '600';
      if (cell.align && cell.align !== 'left') td.style.textAlign = cell.align;

      const coord = `${row.index}:${cell.col}`;
      if (titleCell && row.index === titleCell.row && cell.col === titleCell.col) {
        state.titleTd = td;
        state.titlePrinted = cell.text;
        td.textContent = fillTitleBlank(cell.text, machineId);
      } else {
        state.cells.set(coord, td);
        state.printed.set(coord, cell.text);
        if (entries.has(coord)) paintCell(td, cell.text, entries.get(coord));
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  container.preview = state;
  // The task grid is a spreadsheet reproduction — it must never reflow/stack
  // on narrow screens (that would destroy its meaning). Instead it gets its
  // own horizontal scroll container, so the table can pan sideways while the
  // page body itself never needs to scroll horizontally. See `.table-scroll`
  // in app.css.
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';
  scroller.append(table);
  container.append(scroller);
}

// Reflect one field's current value in the already-rendered sheet.
//
// This exists so typing does not re-render the grid. A rebuild would throw
// away and recreate every <td> on a 71-row sheet — hundreds of nodes, a full
// layout and paint, and the loss of any scroll position inside
// `.table-scroll` — on every keystroke. Here the work is a single map lookup
// and one text node, so cost is constant no matter how large the form is.
// Returns false when this field has no cell on this sheet (a task status on a
// form with no Status column, say), so a caller can tell "nothing to show"
// from "shown".
export function updatePreviewField(container, key, value) {
  const state = container?.preview;
  if (!state) return false;

  // The machine ID is not written into a cell of its own — it fills the blank
  // the printed title leaves, recomputed each time from the ORIGINAL title so
  // repeated edits can never compound.
  if (key === 'machine_id') {
    if (!state.titleTd) return false;
    state.titleTd.textContent = fillTitleBlank(state.titlePrinted, value);
    return true;
  }

  const cell = state.cellFor[key];
  if (!cell) return false;
  const coord = at(cell);
  const td = state.cells.get(coord);
  if (!td) return false;
  paintCell(td, state.printed.get(coord) ?? '', value);
  return true;
}
