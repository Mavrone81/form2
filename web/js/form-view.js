// Renders the left pane: an HTML table mirroring the sheet for xlsx forms,
// or the browser's own PDF viewer for pdf forms.
export function renderForm(container, form, { grid, inScopeRows } = {}) {
  container.replaceChildren();

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
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
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
