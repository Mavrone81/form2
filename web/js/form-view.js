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
//
// ---------------------------------------------------------------------------
// DELIBERATE EXCEPTION TO THIS APP'S DESIGN LANGUAGE — do not "correct" it
// ---------------------------------------------------------------------------
// Everything else in this app follows one monochrome document-control
// direction with its own type scale. The sheet below does NOT. Its font
// sizes, families, border weights, shading, alignment and wrapping are taken
// from the SPREADSHEET, cell by cell, because this pane is not a design — it
// is a reproduction of somebody else's controlled document, and the person
// filling it in has the printed original in front of them. A 14pt title is
// rendered at 14pt because the form prints it at 14pt; Calibri and Aptos
// Narrow appear here because the documents are set in them.
// So: do not fold these into the app's type scale, and do not replace the
// per-cell values with a tidier uniform rule. Making the two agree is the
// whole point of this file. The exception stops at the edge of the sheet —
// every control, panel and label around it stays in the app's own language.

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

// How a spreadsheet border style is drawn. The WEIGHT is the point: these
// documents frame each section in `medium` and rule the gridlines inside it in
// `thin`, and that contrast is the document's entire visual hierarchy. Drawing
// both at one weight — which a blanket `td{border:1px}` does — flattens the
// form into an undifferentiated mesh, which is exactly why the preview did not
// look like the print.
//
// Tone follows weight for the same reason: a section frame is drawn in the
// document ink, an interior gridline in the lighter rule grey the rest of this
// app uses for gridlines. Both are monochrome, so this borrows nothing from
// the state accent.
//
// An unrecognised style still draws a line (thin, solid). A border the sheet
// asks for must never silently disappear, and none of the twelve forms uses
// anything but thin and medium, so this branch is insurance rather than a
// guess about content.
const BORDER = {
  hair: ['0.5px', 'solid', 'rule'],
  thin: ['1px', 'solid', 'rule'],
  dotted: ['1px', 'dotted', 'rule'],
  dashed: ['1px', 'dashed', 'rule'],
  dashDot: ['1px', 'dashed', 'rule'],
  dashDotDot: ['1px', 'dashed', 'rule'],
  medium: ['2px', 'solid', 'ink'],
  mediumDashed: ['2px', 'dashed', 'ink'],
  mediumDashDot: ['2px', 'dashed', 'ink'],
  mediumDashDotDot: ['2px', 'dashed', 'ink'],
  slantDashDot: ['2px', 'dashed', 'ink'],
  thick: ['3px', 'solid', 'ink'],
  double: ['3px', 'double', 'ink']
};
const SIDE = { t: 'top', r: 'right', b: 'bottom', l: 'left' };

// A family name reaches here from a spreadsheet file, so it is treated as
// data: only a plain font name is ever passed through, and anything else is
// dropped in favour of the sheet default. (Assigning to `style.fontFamily`
// cannot escape into another declaration — the CSSOM rejects an invalid value
// outright — but a name is content, and content gets checked here like it does
// everywhere else in this file.)
const SAFE_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const familyFor = (name) => (typeof name === 'string' && SAFE_FAMILY.test(name.trim())
  ? `"${name.trim()}", var(--sheet-fallback)`
  : null);

// The CSS a single sheet cell needs, as plain property/value pairs. Pure and
// exported so the border weights, fills and type can be asserted against a
// real form's grid without a DOM — the shape of the data alone cannot tell you
// whether a medium border comes out heavier than a thin one.
//
// A `filler` placeholder returns NOTHING. It is not a cell of the document: it
// holds a column open so the cells to its right land in the right place, and
// must draw no border, no background and no padding that could make its row
// taller than the sheet prints it. That is enforced by a class here rather
// than by writing four `border:0` declarations onto ~4,500 elements.
export function cellStyle(cell, defaults = {}) {
  const css = {};
  if (!cell || cell.filler === true) return css;

  for (const [key, name] of Object.entries(SIDE)) {
    const style = cell.borders?.[key];
    if (!style) continue;
    const [width, line, token] = BORDER[style] ?? BORDER.thin;
    css[`border-${name}`] = `${width} ${line} var(--${token})`;
  }

  // Shading travels as a custom property, not as an inline background: an
  // inline background outranks every selector, and a shaded cell would then
  // punch a hole in the out-of-scope row tint. See `.sheet.xl td` in app.css.
  if (cell.fill) css['--cell-fill'] = cell.fill;
  if (cell.bold) css['font-weight'] = '600';
  if (cell.align && cell.align !== 'left') css['text-align'] = cell.align;
  // Excel calls it `middle`; CSS calls the same thing `middle` on a table
  // cell, and `top`/`bottom` line up too, so the sheet's own word is used
  // as-is and anything unrecognised is left to the sheet default.
  if (cell.valign && ['top', 'middle', 'bottom'].includes(cell.valign)) css['vertical-align'] = cell.valign;
  // Wrapping is per cell in the source. `pre-wrap` keeps the line breaks the
  // author typed into the cell, which collapse to spaces otherwise. Cells the
  // sheet does not wrap are left to the table's own wrapping rather than
  // `nowrap`: a spreadsheet lets an unwrapped cell spill across its empty
  // neighbours, an HTML table cannot, and the alternatives are to clip the
  // text (unacceptable on a maintenance instruction) or to let one long line
  // stretch its column and pull every other column out of alignment.
  if (cell.wrap) css['white-space'] = 'pre-wrap';
  // Size and family are absent whenever the cell agrees with the sheet's own
  // default, which the table itself carries — see grid-model.js.
  if (typeof cell.size === 'number' && cell.size > 0) css['font-size'] = `${cell.size}pt`;
  const family = familyFor(cell.font);
  if (family) css['font-family'] = family;
  return css;
}

const applyStyle = (el, css) => {
  for (const [prop, value] of Object.entries(css)) el.style.setProperty(prop, value);
};

// How a row is laid out, given that a spreadsheet lets text SPILL and an HTML
// table does not.
//
// A cell the sheet does not wrap is drawn by Excel on one line, running on
// across the empty cells to its right for as far as it needs. A table cell
// cannot do that: hold it to its own column and a line of prose the form
// prints once becomes a 26-line tower, which drags the row — and the whole
// document's vertical proportions — far away from the printed page. Measured
// on the reference form, that alone made the preview 3,613px tall where the
// sheet is 914px.
//
// So the spill is reproduced the only way a table can: the cell is given the
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
export function layoutRow(cells) {
  const out = [];
  let absorb = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (absorb > 0 && cell.filler === true) { absorb--; continue; }
    const cols = cell.span?.cols ?? 1;
    if (cell.filler === true || cell.wrap || !cell.text) {
      out.push({ cell, cols });
      continue;
    }
    let extra = 0;
    while (i + 1 + extra < cells.length && cells[i + 1 + extra].filler === true) extra++;
    absorb = extra;
    out.push({ cell, cols: cols + extra });
  }
  return out;
}

// Ring the interval this visit covers, on the option the document already
// prints in its frequency band — the same mark a technician makes with a pen
// on the paper form.
//
// Exactly ONE option is ever ringed: whatever was ringed before is put back
// to its printed text first, so selecting another interval moves the mark
// rather than adding a second one.
//
// Two band shapes exist across the controlled documents — one option per
// cell, or every option inside one wide cell — and the server hands both over
// as a cell plus a character range (see server/cell-map.js), so there is one
// path here. The range is checked against the text this cell actually renders
// before anything is drawn: if it does not delimit the option the server
// named, the band is left exactly as printed rather than ringing the wrong
// words on a controlled document.
//
// textContent and createElement only. The band is spreadsheet text like every
// other cell here and is never treated as markup.
function markInterval(state, interval) {
  const previous = state.marked;
  if (previous) {
    const td = state.cells.get(previous);
    if (td) td.textContent = state.printed.get(previous) ?? '';
    state.marked = null;
  }

  const mark = state.intervalCells[interval];
  if (!mark) return false;
  const coord = at(mark);
  const td = state.cells.get(coord);
  if (!td) return false;

  const printed = state.printed.get(coord) ?? '';
  const { start, end } = mark;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end > printed.length || start >= end) return false;
  if (printed.slice(start, end) !== mark.text) return false;

  const ring = document.createElement('span');
  ring.className = 'interval-mark';
  ring.textContent = printed.slice(start, end);

  const parts = [];
  if (start > 0) parts.push(document.createTextNode(printed.slice(0, start)));
  parts.push(ring);
  if (end < printed.length) parts.push(document.createTextNode(printed.slice(end)));
  td.replaceChildren(...parts);
  state.marked = coord;
  return true;
}

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
  grid, inScopeRows, values, cellFor, titleCell, machineId, signatures,
  intervalCells, selectedInterval
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
  // `xl` marks this table as a spreadsheet reproduction rather than one of the
  // app's own listings (the admin screens use `.sheet` too). It is what turns
  // OFF the blanket gridline every `.sheet` cell would otherwise get, so the
  // borders below are the cell's own and nothing competes with them.
  table.className = 'sheet xl';
  // The sheet's own baseline type, set once here so ~6,500 cells do not each
  // have to repeat it; a cell only carries a size or family where the document
  // departs from this.
  const defaults = grid.defaults ?? {};
  if (typeof defaults.size === 'number' && defaults.size > 0) table.style.fontSize = `${defaults.size}pt`;
  const defaultFamily = familyFor(defaults.font);
  if (defaultFamily) table.style.fontFamily = defaultFamily;
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
  // `intervalCells` and `marked` are the same idea for the frequency band:
  // where each interval's printed option lives, and which one currently
  // carries the ring, so a later change can move it in place.
  const state = {
    cellFor: map, cells: new Map(), printed: new Map(), titleTd: null, titlePrinted: '',
    intervalCells: intervalCells ?? {}, marked: null
  };

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
    // The sheet's own row height, in points, converted to CSS pixels. `height`
    // on a table row is a MINIMUM, not a cap: a short row on paper is short
    // here too instead of being padded out to a comfortable web row height,
    // but a cell whose text needs more room still gets it — nothing on a
    // maintenance record is ever cut off to hit a number.
    if (row.height > 0) tr.style.height = `${Math.round(row.height * 4 / 3)}px`;
    for (const { cell, cols } of layoutRow(row.cells)) {
      const td = document.createElement('td');
      const span = cell.span ?? { rows: 1, cols: 1 };
      if (cols > 1) td.colSpan = cols;
      if (span.rows > 1) td.rowSpan = span.rows;
      // A placeholder holds a column open and nothing more: no text, no
      // border, no background, and no padding that would make the row taller
      // than the sheet prints it.
      if (cell.filler === true) {
        td.className = 'filler';
        tr.append(td);
        continue;
      }
      td.textContent = cell.text ?? '';
      applyStyle(td, cellStyle(cell, defaults));

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
  // Drawn after the sheet exists, through the very same path a later change
  // of interval uses — one mechanism, so what a reload shows and what a click
  // shows can never diverge. A read-only record takes this path too: it rings
  // the interval that was recorded, with nothing editable anywhere.
  markInterval(state, selectedInterval);
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

// Move the ring to another interval in the already-rendered sheet.
//
// Same reasoning as updatePreviewField above: this is one lookup and two text
// nodes, so changing the interval never rebuilds the 71-row grid. Returns
// false when this form prints no such option (the band of one of the twelve
// has no yearly option) — the previous ring is still cleared, because the
// selected interval genuinely is not marked on this sheet, and leaving the
// old one drawn would state something untrue about the record.
export function updatePreviewInterval(container, interval) {
  const state = container?.preview;
  if (!state) return false;
  return markInterval(state, interval);
}
