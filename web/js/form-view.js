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
    // Only rows that are actually task rows can be out of scope.
    if (inScope && inScope.size && row.isTask && !inScope.has(row.index)) tr.className = 'row-out';
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
  container.append(table);
}
