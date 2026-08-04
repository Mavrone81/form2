import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const asset = (p) => fileURLToPath(new URL(`../assets/${p}`, import.meta.url));
const REGULAR = asset('fonts/DejaVuSans.ttf');
const BOLD = asset('fonts/DejaVuSans-Bold.ttf');
const MONO = asset('fonts/DejaVuSansMono.ttf');
const ICC = asset('sRGB.icc');

const PAGE_MARGIN = 28;
const HEADER_HEIGHT = 46;
const GRID_ROW_SCALE = 0.62; // Excel row heights read tall next to a Helvetica-metrics font; tighten for print.

/**
 * Render a completed submission as an archival PDF/A-2u document.
 *
 * PDFKit 0.19.1's own `subset: 'PDF/A-2'` support gets us most of the way —
 * a registered TTF yields FontFile2 + ToUnicode automatically, and the
 * library's internal endSubset() step already attaches a real OutputIntent
 * with an embedded ICC stream. What it does NOT do: (1) the conformance
 * letter is hardcoded to 'B', never 'U', and (2) the ICC profile it embeds
 * is its own bundled default, never exposed as a named /ICCBased colour
 * space anywhere reachable — so a structural scan for the standard PDF/A
 * "ICCBased" marker finds nothing. forcePdfA2u and attachOutputIntent below
 * correct both, and attachOutputIntent also makes sure OUR vendored,
 * licence-tracked sRGB profile — not PDFKit's bundled one — is what actually
 * ships as the record's archival OutputIntent.
 */
export async function renderRecordPdf({ form, submission, snapshot, values, signatures, grid }) {
  const doc = new PDFDocument({
    pdfVersion: '1.7', subset: 'PDF/A-2', tagged: true, lang: 'en-GB',
    size: 'A4', margin: PAGE_MARGIN, bufferPages: true,
    info: {
      Title: `${form.title || form.file_name} — ${submission.machine_id}`,
      Author: 'Preventive maintenance records',
      Subject: `${form.doc_number} rev ${form.revision}`,
      CreationDate: new Date(submission.created_at)
    }
  });
  doc.registerFont('body', REGULAR);
  doc.registerFont('bold', BOLD);
  doc.registerFont('mono', MONO);
  doc.font('body');

  forcePdfA2u(doc);
  attachOutputIntent(doc, readFileSync(ICC));

  const ctx = { form, submission };
  drawHeader(doc, ctx);
  doc.y = PAGE_MARGIN + HEADER_HEIGHT;
  doc.on('pageAdded', () => {
    drawHeader(doc, ctx);
    doc.y = PAGE_MARGIN + HEADER_HEIGHT;
  });

  drawGrid(doc, grid, form);
  drawValues(doc, snapshot, values);
  drawSignatures(doc, signatures);

  stampPageNumbers(doc, ctx);

  doc.end();
  return await streamToBuffer(doc);
}

// --- PDF/A-2u structural fixes ------------------------------------------

function forcePdfA2u(doc) {
  // PDFKit's PDFA mixin reads `this.subset_conformance` when it writes the
  // XMP packet inside endSubset() (called from doc.end(), before the packet
  // is serialised) — setting it here changes the ACTUAL emitted XMP, rather
  // than patching bytes after the fact.
  doc.subset_conformance = 'U';
}

function attachOutputIntent(doc, iccBuffer) {
  // Embed our vendored profile once, referenced from two places.
  const profileRef = doc.ref({ N: 3 });
  profileRef.end(iccBuffer);

  // 1) A genuine, reachable /ICCBased colour space, declared as a page
  // resource now. Page resources are finalised during flushPages(), which
  // runs BEFORE endSubset() inside doc.end() — so this must happen
  // immediately, not deferred.
  const colorSpaceRef = doc.ref(['ICCBased', profileRef]);
  colorSpaceRef.end();
  doc.page.colorSpaces.ArchivalProfile = colorSpaceRef;

  // 2) Replace PDFKit's own _addColorOutputIntent (an own-instance method
  // copied on by the PDF/A mixin) so the actual archival /OutputIntent uses
  // OUR profile instead of PDFKit's bundled default. This runs later, inside
  // endSubset() during doc.end(), which is still before the catalog
  // (_root) is finalised.
  doc._addColorOutputIntent = function () {
    const intentRef = doc.ref({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: new String('sRGB IEC61966-2.1'),
      Info: new String('sRGB IEC61966-2.1'),
      DestOutputProfile: profileRef
    });
    intentRef.end();
    doc._root.data.OutputIntents = [intentRef];
  };
}

// --- Drawing --------------------------------------------------------------

function drawHeader(doc, { form, submission }) {
  const top = PAGE_MARGIN;
  const width = doc.page.width - PAGE_MARGIN * 2;

  doc.font('bold').fontSize(12).fillColor('#000')
    .text(form.title || form.file_name, PAGE_MARGIN, top, { width: width * 0.6, height: 14, ellipsis: true });
  doc.font('body').fontSize(8).fillColor('#333')
    .text(`Machine ${submission.machine_id} — ${submission.frequency} interval`, PAGE_MARGIN, top + 15, { width: width * 0.6 });

  const codeWidth = width * 0.36;
  const codeX = PAGE_MARGIN + width * 0.64;
  doc.font('mono').fontSize(8).fillColor('#000')
    .text(`DOC ${form.doc_number || '-'}`, codeX, top, { width: codeWidth, align: 'right' })
    .text(`REV ${form.revision || '-'}`, codeX, top + 11, { width: codeWidth, align: 'right' })
    .text(pageLabel(doc), codeX, top + 22, { width: codeWidth, align: 'right' });

  doc.moveTo(PAGE_MARGIN, top + HEADER_HEIGHT - 6).lineTo(PAGE_MARGIN + width, top + HEADER_HEIGHT - 6)
    .lineWidth(1).strokeColor('#000').stroke();
}

function pageLabel(doc) {
  // With bufferPages:true, pages accumulate in the buffer and are not
  // flushed until doc.end(); the page currently being drawn is always the
  // last one, so its 1-based number is simply the buffered count so far.
  return `PAGE ${doc.bufferedPageRange().count}`;
}

// After all content is drawn, revisit each buffered page and stamp the
// header's page indicator with the final "n / N" count — the total page
// count is not known until every page has been produced.
function stampPageNumbers(doc, ctx) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const width = doc.page.width - PAGE_MARGIN * 2;
  const codeWidth = width * 0.36;
  const codeX = PAGE_MARGIN + width * 0.64;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(i);
    // Cover the previously-drawn placeholder page line, then redraw it.
    doc.rect(codeX, PAGE_MARGIN + 22, codeWidth, 10).fill('#fff');
    doc.font('mono').fontSize(8).fillColor('#000')
      .text(`PAGE ${i + 1} / ${total}`, codeX, PAGE_MARGIN + 22, { width: codeWidth, align: 'right' });
  }
}

// The record is archival evidence that a maintenance step was performed —
// a task instruction (including a safety instruction) must never be cut off
// with no trace. drawGrid measures each cell's actual required text height
// first and grows the row to fit it (Finding 1), and reserves that FULL
// footprint — including a spanning cell's multi-row height — before drawing
// anything, so a page break happens before a tall cell is painted rather
// than mid-cell (Finding 2). Only a cell whose own text could not fit even
// on a full, freshly-started page falls back to a visible ellipsis, and
// that fallback is logged rather than left silent.
function drawGrid(doc, grid, form) {
  if (!grid || !grid.columns?.length || !grid.rows?.length) return;

  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  const totalUnits = grid.columns.reduce((s, c) => s + c.width, 0) || 1;
  const scale = contentWidth / totalUnits;
  const colX = new Map();
  let x = PAGE_MARGIN;
  for (const col of grid.columns) {
    colX.set(col.index, { x, width: col.width * scale });
    x += col.width * scale;
  }
  const colOrder = grid.columns.map((c) => c.index);

  // The most vertical space a row could ever be given: an entirely fresh
  // page, below the repeated header, down to the bottom margin.
  const maxPageBudget = doc.page.height - PAGE_MARGIN - (PAGE_MARGIN + HEADER_HEIGHT);

  const cellGeometry = (cell) => {
    const startPos = colX.get(cell.col);
    if (!startPos) return null;
    const span = cell.span ?? { rows: 1, cols: 1 };
    const endColIndex = colOrder[colOrder.indexOf(cell.col) + (span.cols - 1)] ?? cell.col;
    const endPos = colX.get(endColIndex) ?? startPos;
    return { x: startPos.x, width: endPos.x + endPos.width - startPos.x, span };
  };

  for (const row of grid.rows) {
    const baseHeight = Math.max(10, Math.round(row.height * GRID_ROW_SCALE));

    // Pass 1: measure. For a cell spanning multiple rows, its need is
    // divided across the rows it covers, so growing THIS row's height by
    // that share means `rowHeight * span.rows` ends up covering the cell's
    // real requirement once drawn.
    let rowHeight = baseHeight;
    let maxSpanRows = 1;
    const measured = new Map();
    for (const cell of row.cells) {
      const geo = cellGeometry(cell);
      if (!geo) continue;
      maxSpanRows = Math.max(maxSpanRows, geo.span.rows || 1);
      if (!cell.text) continue;
      doc.font(cell.bold ? 'bold' : 'body').fontSize(7);
      const cellWidth = Math.max(1, geo.width - 4);
      const neededHeight = doc.heightOfString(cell.text, { width: cellWidth, align: cell.align || 'left' }) + 4;
      measured.set(cell, { neededHeight, cellWidth });
      rowHeight = Math.max(rowHeight, Math.ceil(neededHeight / (geo.span.rows || 1)));
    }

    // A cell's own text cannot outgrow a full fresh page. Cap the per-row
    // share so the total footprint (rowHeight * maxSpanRows) never exceeds
    // one page's budget — otherwise ensureSpace could never be satisfied.
    const perRowCap = Math.max(1, Math.floor(maxPageBudget / maxSpanRows));
    const capped = rowHeight > perRowCap;
    if (capped) rowHeight = perRowCap;

    const rowBlockHeight = rowHeight * maxSpanRows;
    ensureSpace(doc, rowBlockHeight);
    const rowTop = doc.y;

    // Pass 2: draw, now that the row's final height (and the space for it)
    // is settled.
    for (const cell of row.cells) {
      const geo = cellGeometry(cell);
      if (!geo) continue;
      const cellHeight = rowHeight * (geo.span.rows || 1);

      drawCellBorders(doc, cell.borders, geo.x, rowTop, geo.width, cellHeight);

      if (!cell.text) continue;
      const m = measured.get(cell);
      const availableHeight = cellHeight - 4;
      const overflows = capped && m && m.neededHeight > availableHeight + 0.5;
      if (overflows) {
        warnTruncation(form, row.index, cell.col);
      }

      const textOptions = {
        width: Math.max(1, geo.width - 4),
        align: cell.align || 'left'
      };
      // Only ever impose an explicit height (and thus risk PDFKit's silent
      // drop-the-remainder behaviour) on the rare, already-logged path where
      // a full fresh page genuinely would not have been enough — otherwise
      // let the text flow to the height it was just measured to need.
      if (overflows) {
        textOptions.height = Math.max(1, availableHeight);
        textOptions.ellipsis = true;
      }

      doc.font(cell.bold ? 'bold' : 'body').fontSize(7).fillColor('#000')
        .text(cell.text, geo.x + 2, rowTop + 2, textOptions);
    }

    doc.y = rowTop + rowHeight;
  }
  doc.moveDown(0.5);
}

function warnTruncation(form, rowIndex, col) {
  const label = form?.doc_number || form?.file_name || 'unknown form';
  // eslint-disable-next-line no-console -- deliberate operator-facing warning, not debug noise
  console.warn(
    `[pdf-record] "${label}": grid row ${rowIndex}, column ${col} did not fit even a full ` +
    'fresh page and was truncated with a visible ellipsis in the archival PDF.'
  );
}

function drawCellBorders(doc, borders, x, y, w, h) {
  if (!borders) return;
  doc.lineWidth(0.5).strokeColor('#000');
  if (borders.t) doc.moveTo(x, y).lineTo(x + w, y).stroke();
  if (borders.b) doc.moveTo(x, y + h).lineTo(x + w, y + h).stroke();
  if (borders.l) doc.moveTo(x, y).lineTo(x, y + h).stroke();
  if (borders.r) doc.moveTo(x + w, y).lineTo(x + w, y + h).stroke();
}

function drawValues(doc, snapshot, values) {
  if (!snapshot?.length) return;
  const byKey = new Map((values ?? []).map((v) => [v.field_key, v.value]));
  const textFields = snapshot.filter((f) => f.kind !== 'signature');
  if (!textFields.length) return;

  ensureSpace(doc, 20);
  doc.moveDown(0.5);
  doc.font('bold').fontSize(9).fillColor('#000').text('RECORDED VALUES', PAGE_MARGIN, doc.y);
  doc.moveDown(0.3);

  let currentSection = null;
  for (const field of textFields) {
    ensureSpace(doc, 14);
    if (field.section && field.section !== currentSection) {
      currentSection = field.section;
      doc.font('bold').fontSize(8).fillColor('#333').text(currentSection, PAGE_MARGIN, doc.y);
    }
    const value = byKey.get(field.field_key) ?? '';
    doc.font('body').fontSize(8).fillColor('#000')
      .text(`${field.label}: `, PAGE_MARGIN, doc.y, { continued: true })
      .font('bold').text(String(value));
  }
}

function drawSignatures(doc, signatures) {
  if (!signatures?.length) return;

  ensureSpace(doc, 30);
  doc.moveDown(0.8);
  doc.font('bold').fontSize(9).fillColor('#000').text('SIGN-OFF', PAGE_MARGIN, doc.y);
  doc.moveDown(0.3);

  const blockWidth = (doc.page.width - PAGE_MARGIN * 2) / 3;
  const blockHeight = 90;
  ensureSpace(doc, blockHeight);
  const top = doc.y;

  signatures.forEach((sig, i) => {
    const x = PAGE_MARGIN + i * blockWidth;
    doc.lineWidth(0.5).strokeColor('#000').rect(x, top, blockWidth - 6, blockHeight).stroke();

    if (sig.image_png) {
      try {
        const base64 = String(sig.image_png).replace(/^data:image\/png;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        doc.image(buf, x + 4, top + 4, { fit: [blockWidth - 14, 50], align: 'left' });
      } catch {
        // A corrupt or malformed signature image must never abort the whole
        // record — skip the image, still record the name and timestamp.
      }
    }

    doc.font('body').fontSize(7).fillColor('#000')
      .text(stageLabel(sig.stage), x + 4, top + 58, { width: blockWidth - 14 });
    doc.font('bold').fontSize(8).fillColor('#000')
      .text(sig.full_name || '', x + 4, top + 68, { width: blockWidth - 14 });
    doc.font('mono').fontSize(6).fillColor('#333')
      .text(formatTimestamp(sig.signed_at), x + 4, top + 79, { width: blockWidth - 14 });
  });

  doc.y = top + blockHeight + 10;
}

function stageLabel(stage) {
  return ({ technician: 'Maintenance performed by', team_leader: 'Verified by (Team Leader)', engineer: 'Verified by (Engineer)' })[stage] || stage;
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso ?? '') : d.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - PAGE_MARGIN) {
    doc.addPage();
  }
}

function streamToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
