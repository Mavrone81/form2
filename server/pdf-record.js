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

  drawGrid(doc, grid);
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

function drawGrid(doc, grid) {
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

  for (const row of grid.rows) {
    const height = Math.max(10, Math.round(row.height * GRID_ROW_SCALE));
    ensureSpace(doc, height);
    const rowTop = doc.y;

    for (const cell of row.cells) {
      const startPos = colX.get(cell.col);
      if (!startPos) continue;
      const span = cell.span ?? { rows: 1, cols: 1 };
      const endColIndex = colOrder[colOrder.indexOf(cell.col) + (span.cols - 1)] ?? cell.col;
      const endPos = colX.get(endColIndex) ?? startPos;
      const cellWidth = endPos.x + endPos.width - startPos.x;
      const cellHeight = height * (span.rows || 1);

      drawCellBorders(doc, cell.borders, startPos.x, rowTop, cellWidth, cellHeight);

      if (cell.text) {
        doc.font(cell.bold ? 'bold' : 'body').fontSize(7).fillColor('#000')
          .text(cell.text, startPos.x + 2, rowTop + 2, {
            width: Math.max(1, cellWidth - 4),
            height: Math.max(1, cellHeight - 4),
            align: cell.align || 'left'
          });
      }
    }

    doc.y = rowTop + height;
  }
  doc.moveDown(0.5);
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
