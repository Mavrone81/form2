import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePartsKey } from './cell-map.js';
// How the sheet PRINTS: where an unwrapped cell spills across its empty
// neighbours, how heavy each border weight is, and how the machine ID fills
// the blank in the printed title. ONE definition, shared with the live
// preview (web/js/form-view.js) — see web/js/sheet-layout.js for why it lives
// there and why a second copy is not an option. Two copies of the spill rule
// is precisely how this renderer came to disagree with the preview: labels
// the form prints on one line were broken mid-word down a narrow column and
// a one-page controlled document was archived as four pages.
import { layoutRow, borderPen, fillTitleBlank } from '../web/js/sheet-layout.js';

const asset = (p) => fileURLToPath(new URL(`../assets/${p}`, import.meta.url));
// The sheets name Aptos Narrow, Calibri and Arial. None of the three may be
// embedded here (licensing), and PDF/A forbids relying on a font being
// installed wherever the record is later opened — so every family the
// document asks for is mapped onto the vendored, freely-redistributable
// DejaVu family, which IS embedded: DejaVu Sans for body text in either
// weight, DejaVu Sans Mono for codes and for values somebody entered. The
// sheet's SIZES are honoured exactly; only the typeface is substituted.
const REGULAR = asset('fonts/DejaVuSans.ttf');
const BOLD = asset('fonts/DejaVuSans-Bold.ttf');
const MONO = asset('fonts/DejaVuSansMono.ttf');
const ICC = asset('sRGB.icc');

const PAGE_MARGIN = 28;
const HEADER_HEIGHT = 46;
// The grid model measures column widths in CSS pixels and row heights in
// points (Excel's own unit for a row). One conversion, stated once.
const PT_PER_PX = 0.75;
// One sheet border unit (borderPen's `weight`, in CSS pixels) as a PDF stroke
// width. `thin` is 1 unit and `medium` 2, so gridlines stroke at 0.6pt and
// section frames at 1.2pt: the 2:1 contrast the document declares, kept, with
// the lighter of the two still above the ~0.5pt where a rule starts to drop
// out on a laser printer.
const PEN_PT = 0.6;
const CELL_PAD = 1.5;
// The strip the sign-off blocks occupy, reserved out of the sheet's own
// budget so the record still comes out as the one page the form declares.
const SIGNOFF_HEIGHT = 78;
// How far the fit may go before the record stops being legible. Reaching
// either floor means the document genuinely does not fit one page and it
// paginates on a row boundary instead — never truncated, never illegible.
const MIN_SCALE = 0.3;
const MIN_FONT_PT = 4;
// How far one cell's own type may shrink, relative to the size the sheet
// gives it, so it still prints on the line the form prints it on. This is the
// price of substituting DejaVu for Aptos Narrow/Calibri: the substitute is a
// wider face, so a cell that fits on paper can overrun by a few per cent
// here. Shrinking that cell slightly is far closer to the printed document
// than breaking its label across four lines.
const SHRINK_FLOOR = 0.6;

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
export async function renderRecordPdf({ form, submission, snapshot, values, signatures, rejections = [], grid, identity = null, notice = '', cellFor = null, titleCell = null }) {
  // `identity` is the controlled document as it stood WHEN THIS RECORD WAS
  // SIGNED (stamped on the submission at creation — see server/workflow.js).
  // The live catalog row is only a fallback for records created before those
  // columns existed: a record must never be retitled by a later revision of
  // its source form.
  const id = {
    title: identity?.title || form?.title || form?.file_name || '',
    doc_number: identity?.doc_number ?? form?.doc_number ?? '',
    revision: identity?.revision ?? form?.revision ?? ''
  };
  const doc = new PDFDocument({
    pdfVersion: '1.7', subset: 'PDF/A-2', tagged: true, lang: 'en-GB',
    size: 'A4', margin: PAGE_MARGIN, bufferPages: true,
    info: {
      Title: `${id.title} — ${submission.machine_id}`,
      Author: 'Preventive maintenance records',
      Subject: `${id.doc_number} rev ${id.revision}`,
      CreationDate: new Date(submission.created_at)
    }
  });
  doc.registerFont('body', REGULAR);
  doc.registerFont('bold', BOLD);
  doc.registerFont('mono', MONO);
  doc.font('body');

  forcePdfA2u(doc);
  attachOutputIntent(doc, readFileSync(ICC));

  const ctx = { identity: id, submission, notice };
  drawHeader(doc, ctx);
  doc.y = PAGE_MARGIN + HEADER_HEIGHT;
  doc.on('pageAdded', () => {
    drawHeader(doc, ctx);
    doc.y = PAGE_MARGIN + HEADER_HEIGHT;
  });

  // What the technician recorded goes ON THE FORM, in the boxes the document
  // prints for it — the same coordinates the live preview writes into (see
  // server/cell-map.js), so the archived record and the preview show the same
  // record the same way. Anything the sheet has no box for still prints
  // below, so no recorded value can be lost by being unmappable.
  const entries = entriesForSheet({ grid, cellFor, titleCell, submission, values, signatures });
  const leftovers = unmappedFields(snapshot, values, entries.painted);

  const valuesPlan = planValues(doc, leftovers, values);
  drawGrid(doc, grid, {
    form: { doc_number: id.doc_number, file_name: id.title },
    entries,
    budget: sheetBudget(doc, grid, (signatures?.length ? SIGNOFF_HEIGHT : 0) + valuesPlan.height)
  });
  drawValues(doc, valuesPlan);
  drawRejections(doc, rejections);
  drawSignatures(doc, signatures);

  stampPageNumbers(doc);

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

function drawHeader(doc, { identity, submission, notice }) {
  const top = PAGE_MARGIN;
  const width = doc.page.width - PAGE_MARGIN * 2;

  doc.font('bold').fontSize(12).fillColor('#000')
    .text(identity.title, PAGE_MARGIN, top, { width: width * 0.6, height: 14, ellipsis: true });
  doc.font('body').fontSize(8).fillColor('#333')
    .text(`Machine ${submission.machine_id} — ${submission.frequency} interval`, PAGE_MARGIN, top + 15, { width: width * 0.6 });

  // The source form is no longer byte-identical to the one this record was
  // signed against (or could not be read at all). The record still renders —
  // it must remain retrievable — but it says so on its own face, on every
  // page, in full-strength ink. A reader must never be able to mistake this
  // document for one whose printed instructions still match its source.
  if (notice) {
    doc.font('bold').fontSize(6.5).fillColor('#000')
      .text(notice, PAGE_MARGIN, top + 27, { width: width * 0.6, height: 9, ellipsis: true });
  }

  const codeWidth = width * 0.36;
  const codeX = PAGE_MARGIN + width * 0.64;
  // The page indicator is NOT drawn here: the total is unknown until every
  // page exists, so stampPageNumbers writes it once, at the end. Drawing a
  // placeholder now and painting over it later left both strings in the text
  // layer, so an extractor read "PAGE 1 PAGE 1 / 4" — noise in the very layer
  // that makes this document archival.
  doc.font('mono').fontSize(8).fillColor('#000')
    .text(`DOC ${identity.doc_number || '-'}`, codeX, top, { width: codeWidth, align: 'right' })
    .text(`REV ${identity.revision || '-'}`, codeX, top + 11, { width: codeWidth, align: 'right' });

  doc.moveTo(PAGE_MARGIN, top + HEADER_HEIGHT - 6).lineTo(PAGE_MARGIN + width, top + HEADER_HEIGHT - 6)
    .lineWidth(1).strokeColor('#000').stroke();
}

// After all content is drawn, revisit each buffered page and stamp the
// header's page indicator with the final "n / N" count — the total page
// count is not known until every page has been produced. Nothing was drawn
// there earlier, so this writes onto clean paper and the text layer carries
// each page's indicator exactly once.
function stampPageNumbers(doc) {
  const total = doc.bufferedPageRange().count;
  const width = doc.page.width - PAGE_MARGIN * 2;
  const codeWidth = width * 0.36;
  const codeX = PAGE_MARGIN + width * 0.64;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(i);
    doc.font('mono').fontSize(8).fillColor('#000')
      .text(`PAGE ${i + 1} / ${total}`, codeX, PAGE_MARGIN + 22, { width: codeWidth, align: 'right' });
  }
}

// --- The sheet ------------------------------------------------------------
//
// The controlled document is drawn the way it PRINTS, not the way a column of
// text happens to flow:
//
//  - it is SCALED to the page rather than wrapped into it. The forms declare
//    fitToWidth 1 / fitToHeight 1 and a 72-80% scale of their own; that is the
//    author saying "this is a one-page document", and the archived record has
//    to be one. Wrapping instead of scaling is what turned a one-page form
//    into four pages;
//  - an unwrapped cell SPILLS across the empty cells to its right, exactly as
//    the preview draws it and exactly as Excel prints it (layoutRow, shared);
//  - each side of each cell carries the WEIGHT the sheet declares, so the
//    medium frames around the sections still read as frames against the thin
//    gridlines inside them;
//  - a `filler` placeholder is not part of the document and draws NOTHING —
//    no border, no fill, no text — which is the difference between the printed
//    form and a page of empty boxes;
//  - nothing is ever truncated. Where the substituted font needs more room
//    than the sheet allots, the cell's own type shrinks a little; only if that
//    reaches its floor does the row grow, and only if a single row cannot fit
//    a whole page does the old visible-ellipsis-plus-warning path apply.
//
// Pagination, if the sheet genuinely will not fit, happens on ROW boundaries:
// a row — including the full footprint of a cell spanning several rows — is
// never split across pages.

// How much of the page the sheet itself may use.
//
// Normally the whole page less what the sign-off strip and any unmappable
// values need after it, which is what keeps the record to the one page the
// form declares itself to be.
//
// But not at any price. Two of the twelve documents print no single Status
// column — they record each task against per-machine columns instead — so
// every task result has to be listed below the form, and squeezing the form
// into what is left would set a controlled document at four-point type to save
// a page. Below LEGIBLE_PT the trade is refused: the sheet takes the page at a
// readable size and the appendix follows on the next one. A record nobody can
// read is not a better record for being one page long.
//
// The value is a judgement, and it was made by LOOKING at the rendered pages
// rather than by arithmetic: at 4.9pt the densest of the twelve (a form
// carrying a full calibration table under its task list) is still comfortably
// readable, so the floor sits just below that. One of the twelve falls under
// it and takes an appendix page.
const LEGIBLE_PT = 4.5;
function sheetBudget(doc, grid, wanted) {
  const usable = doc.page.height - PAGE_MARGIN - (PAGE_MARGIN + HEADER_HEIGHT);
  const naturalHeight = (grid?.rows ?? []).reduce((s, r) => s + (r.height ?? 15), 0) || 1;
  const budget = usable - Math.min(usable * 0.5, wanted);
  const legibleScale = LEGIBLE_PT / (grid?.defaults?.size || 10);
  return budget / naturalHeight < legibleScale ? usable : budget;
}

// Column geometry at a given scale: where each column starts and how wide it
// is, and the box a cell starting at `col` and covering `cols` columns gets.
function columnGeometry(grid, scale) {
  const positions = [];
  const indexOf = new Map();
  let x = PAGE_MARGIN;
  for (const col of grid.columns) {
    indexOf.set(col.index, positions.length);
    const width = col.width * PT_PER_PX * scale;
    positions.push({ x, width });
    x += width;
  }
  return (col, cols) => {
    const i = indexOf.get(col);
    if (i === undefined) return null;
    const start = positions[i];
    const end = positions[Math.min(positions.length - 1, i + Math.max(1, cols) - 1)];
    return { x: start.x, width: end.x + end.width - start.x };
  };
}

// Fit one cell's text into the box the document gives it.
//
// A cell the sheet does not wrap prints on ONE line — that is the whole point
// of the spill above — so the type shrinks (a little, to a floor) rather than
// the word breaking. A cell the sheet DOES wrap wraps inside its own width, as
// the sheet does, and shrinks only to stay inside the height the row allows.
// Either way the text is never clipped: whatever it still needs after
// shrinking is reported back as the height the row must grow to.
function fitCell(doc, { text, bold, align, wrap, boxWidth, runWidth, boxHeight, nominal }) {
  const font = bold ? 'bold' : 'body';
  const width = Math.max(1, boxWidth - CELL_PAD * 2);
  const run = Math.max(width, (runWidth ?? boxWidth) - CELL_PAD * 2);
  const lines = String(text).split('\n');
  const floor = Math.max(MIN_FONT_PT, nominal * SHRINK_FLOOR);
  let size = Math.max(MIN_FONT_PT, nominal);
  let wrapped = !!wrap;
  let drawWidth = width;

  if (wrap) {
    const room = Math.max(1, boxHeight - CELL_PAD * 2);
    while (size > floor) {
      doc.font(font).fontSize(size);
      if (doc.heightOfString(text, { width, align }) <= room) break;
      size = Math.max(floor, size * 0.94);
    }
  } else {
    const widest = () => Math.max(...lines.map((l) => doc.widthOfString(l)));
    // 1) The size the sheet sets, inside the cell's own box.
    doc.font(font).fontSize(size);
    if (widest() > width) {
      // 2) Shrink, but only inside the box, and only as far as the floor.
      while (size > floor) {
        size = Math.max(floor, size * 0.94);
        doc.font(font).fontSize(size);
        if (widest() <= width) break;
      }
      // 3) Still too wide, and there are empty columns beside it: let the ink
      // RUN, at the sheet's own size, exactly as Excel prints it. The columns
      // it runs over keep their own borders — nothing is covered, nothing is
      // absorbed, and the row does not grow.
      if (widest() > width && run > width) {
        size = Math.max(MIN_FONT_PT, nominal);
        doc.font(font).fontSize(size);
        while (size > floor && widest() > run) {
          size = Math.max(floor, size * 0.94);
          doc.font(font).fontSize(size);
        }
        if (widest() <= run) drawWidth = run;
      }
      // 4) Nowhere left to go. Wrapping is then the only honest option: a
      // maintenance instruction is never clipped to keep the layout tidy.
      if (widest() > drawWidth) wrapped = true;
    }
  }

  // Whatever else happens, no WORD is ever broken across lines. That is the
  // defect this whole file exists to correct — a label the form prints whole
  // came out of the archived record as "Requir / ed:" — and it is not only a
  // spill problem: a cell that genuinely has to wrap can still split a word
  // whose glyphs are a fraction wider than its box. So a wrapping cell shrinks
  // until its LONGEST WORD fits, past the ordinary floor if it has to, because
  // a word broken in half reads worse than a word set small.
  if (wrapped) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const longest = () => (words.length ? Math.max(...words.map((w) => doc.widthOfString(w))) : 0);
    doc.font(font).fontSize(size);
    while (size > MIN_FONT_PT && longest() > width - 0.5) {
      size = Math.max(MIN_FONT_PT, size * 0.94);
      doc.font(font).fontSize(size);
    }
  }

  doc.font(font).fontSize(size);
  const textHeight = wrapped
    ? doc.heightOfString(text, { width, align })
    : doc.currentLineHeight() * lines.length;
  return { font, size, wrapped, lines, width: wrapped ? width : drawWidth, textHeight, height: textHeight + CELL_PAD * 2 };
}

// Everything about how the sheet lands on the page, at one scale: every row's
// final height and every cell's box, type and fitted text. Pure measurement —
// nothing is drawn — so the scale can be tried, judged against the page and
// tried again before a single mark is made.
function measureSheet(doc, grid, entries, scale) {
  const boxFor = columnGeometry(grid, scale);
  const defaultSize = grid.defaults?.size ?? 10;
  const rows = [];
  let total = 0;
  let required = 0;

  for (const row of grid.rows) {
    let height = Math.max(2, (row.height ?? 15) * scale);
    let maxSpanRows = 1;
    const items = [];

    for (const { cell, cols, overflow } of layoutRow(row.cells ?? [])) {
      // A placeholder holds a column open and states nothing else. It is not
      // a cell of the document, so it is not measured and never drawn.
      if (cell.filler === true) continue;
      const box = boxFor(cell.col, cols);
      if (!box) continue;
      // How far the ink may run if the cell's own box is too narrow for the
      // line the form prints — the empty columns beside it, which keep their
      // own borders while the text passes over them.
      const run = overflow > 0 ? (boxFor(cell.col, cols + overflow)?.width ?? box.width) : box.width;
      const spanRows = Math.max(1, cell.span?.rows ?? 1);
      maxSpanRows = Math.max(maxSpanRows, spanRows);

      const item = { cell, box, spanRows, text: entries.textAt(row.index, cell), entered: entries.enteredAt(row.index, cell) };
      if (item.text) {
        item.fit = fitCell(doc, {
          text: item.text,
          bold: cell.bold || item.entered,
          align: cell.align || 'left',
          wrap: cell.wrap,
          boxWidth: box.width,
          runWidth: run,
          boxHeight: Math.max(2, (row.height ?? 15) * scale * spanRows),
          nominal: (cell.size ?? defaultSize) * scale
        });
        // A cell spanning several rows divides its need across them, so
        // growing THIS row by that share means the cell's full footprint
        // covers what it needs once drawn.
        height = Math.max(height, item.fit.height / spanRows);
      }
      items.push(item);
    }

    rows.push({ row, items, height, maxSpanRows });
    // What the sheet actually needs is not the sum of its rows: a cell
    // spanning several rows has its FULL footprint reserved before it is
    // drawn (so a page break never lands inside it), and a span in the last
    // few rows therefore reaches further down the page than the row total
    // suggests. Judging the fit on the sum alone broke the tallest form onto
    // a second page while every arithmetic check said it fitted.
    required = Math.max(required, total + height * maxSpanRows);
    total += height;
  }
  return { rows, total, required, scale };
}

function drawGrid(doc, grid, { form, entries, budget }) {
  if (!grid || !grid.columns?.length || !grid.rows?.length) return;

  const contentWidth = doc.page.width - PAGE_MARGIN * 2;
  const naturalWidth = grid.columns.reduce((s, c) => s + c.width, 0) * PT_PER_PX || 1;
  const naturalHeight = grid.rows.reduce((s, r) => s + (r.height ?? 15), 0) || 1;

  // The author's own shrink factor is an upper bound, never something to
  // exceed: where they said 75%, this document is not printed larger than 75%.
  // Nothing is ever scaled UP — a form is not enlarged to fill the paper.
  const declared = grid.pageSetup?.scale;
  const authorCap = typeof declared === 'number' && declared > 0 && declared <= 100 ? declared / 100 : 1;
  const fullPage = doc.page.height - PAGE_MARGIN - (PAGE_MARGIN + HEADER_HEIGHT);

  // Fit the height too. Measuring is what settles it rather than arithmetic on
  // the row heights alone: the substituted font may need a row to grow, and
  // that growth has to be inside the page budget, not discovered after the
  // fact. Row heights and type scale together, so one correction very nearly
  // lands it and the loop converges in two or three passes.
  const fitTo = (room) => {
    let s = Math.min(1, authorCap, contentWidth / naturalWidth);
    let p = measureSheet(doc, grid, entries, s);
    for (let attempt = 0; attempt < 5 && p.required > room && s > MIN_SCALE; attempt++) {
      s = Math.max(MIN_SCALE, s * (room / p.required) * 0.985);
      p = measureSheet(doc, grid, entries, s);
    }
    return { scale: s, plan: p };
  };

  let { scale, plan } = fitTo(budget);
  // The legibility floor has the last word, and it has to be applied to the
  // scale actually ARRIVED AT, not to the one the budget predicted: a sheet
  // whose rows grow under the substituted font ends up smaller than the
  // arithmetic said, and one form was landing at five-point type — a page
  // saved by making the controlled document unreadable, which is no saving at
  // all on a record somebody has to check. Where that happens the sheet takes
  // the whole page at a readable size and the appendix follows on the next.
  const legible = LEGIBLE_PT / (grid.defaults?.size || 10);
  if (scale < legible && budget < fullPage) ({ scale, plan } = fitTo(fullPage));

  let y = doc.y;

  for (const planned of plan.rows) {
    if (!planned.items.length) { y += planned.height; continue; }

    // A row taller than a whole page can never be placed. It does not happen
    // on any real form — the fit above sees to that — but if it ever did, the
    // row is capped and its overflowing cells print a VISIBLE ellipsis and
    // log, rather than a border being drawn off the bottom of the page.
    // `fullPage` is the most vertical space a row could ever be given: an
    // entirely fresh page, below the repeated header, down to the bottom margin.
    const perRowCap = Math.max(1, fullPage / planned.maxSpanRows);
    const capped = planned.height > perRowCap;
    const height = capped ? perRowCap : planned.height;
    const blockHeight = height * planned.maxSpanRows;

    if (y + blockHeight > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      y = PAGE_MARGIN + HEADER_HEIGHT;
    }

    for (const item of planned.items) drawCell(doc, item, y, height, capped ? form : null, planned.row.index);
    y += height;
  }

  doc.y = y;
  doc.moveDown(0.4);
}

function drawCell(doc, item, top, rowHeight, cappedForm, rowIndex) {
  const { cell, box, spanRows } = item;
  const height = rowHeight * spanRows;

  // Shading the sheet declares, under everything else the cell draws.
  if (cell.fill) doc.rect(box.x, top, box.width, height).fill(cell.fill);
  drawCellBorders(doc, cell.borders, box.x, top, box.width, height);
  if (!item.text) return;

  const { font, size, wrapped, lines, width, textHeight } = item.fit;
  const align = cell.align || 'left';
  // Excel's vertical alignment, honoured as the sheet states it. Anything
  // unrecognised sits at the top, which is Excel's own default for these
  // documents.
  const slack = Math.max(0, height - CELL_PAD * 2 - textHeight);
  const offset = cell.valign === 'middle' ? slack / 2 : cell.valign === 'bottom' ? slack : 0;
  const x = box.x + CELL_PAD;
  const y = top + CELL_PAD + offset;

  // A value somebody entered is set in the vendored mono face, the same
  // distinction the live preview draws between what the document PRINTS and
  // what was written onto it.
  doc.font(item.entered ? 'mono' : font).fontSize(size).fillColor('#000');

  const overflows = cappedForm && textHeight > height - CELL_PAD * 2 + 0.5;
  if (overflows) {
    warnTruncation(cappedForm, rowIndex, cell.col);
    doc.text(item.text, x, y, { width, align, height: Math.max(1, height - CELL_PAD * 2), ellipsis: true });
    return;
  }

  if (wrapped) {
    doc.text(item.text, x, y, { width, align });
    return;
  }
  // Unwrapped: one line per line the author typed, and `lineBreak: false` so
  // nothing can re-break a label the form prints whole. The width was already
  // fitted above, so this cannot overrun the box it was measured into.
  const lineHeight = doc.currentLineHeight();
  lines.forEach((line, i) => doc.text(line, x, y + i * lineHeight, { width, align, lineBreak: false }));
}

function warnTruncation(form, rowIndex, col) {
  const label = form?.doc_number || form?.file_name || 'unknown form';
  // eslint-disable-next-line no-console -- deliberate operator-facing warning, not debug noise
  console.warn(
    `[pdf-record] "${label}": grid row ${rowIndex}, column ${col} did not fit even a full ` +
    'fresh page and was truncated with a visible ellipsis in the archival PDF.'
  );
}

// Each side at the weight the sheet declares for it. The weights come from
// the shared pen table, so a `medium` section frame is heavier here for the
// same reason and by the same rule that it is heavier in the preview.
function drawCellBorders(doc, borders, x, y, w, h) {
  if (!borders) return;
  const edges = { t: [x, y, x + w, y], b: [x, y + h, x + w, y + h], l: [x, y, x, y + h], r: [x + w, y, x + w, y + h] };
  for (const [side, style] of Object.entries(borders)) {
    const edge = edges[side];
    if (!edge || !style) continue;
    const pen = borderPen(style);
    doc.lineWidth(Math.max(0.25, pen.weight * PEN_PT)).strokeColor('#000');
    if (pen.line === 'dashed') doc.dash(2, { space: 1.5 });
    else if (pen.line === 'dotted') doc.dash(0.5, { space: 1.2 });
    else doc.undash();
    doc.moveTo(edge[0], edge[1]).lineTo(edge[2], edge[3]).stroke();
    // A double rule is two lines, as the sheet draws it.
    if (pen.line === 'double') {
      const [dx, dy] = side === 't' ? [0, 1.4] : side === 'b' ? [0, -1.4] : side === 'l' ? [1.4, 0] : [-1.4, 0];
      doc.moveTo(edge[0] + dx, edge[1] + dy).lineTo(edge[2] + dx, edge[3] + dy).stroke();
    }
  }
  doc.undash();
}

// --- What the technician recorded, placed on the form itself --------------
//
// The preview draws the record INTO the sheet, at the coordinates
// server/cell-map.js reports; the archived PDF now draws it in the same
// places, from the same map. That is what makes the two agree, and it is also
// what makes the record fit the one page the form is: a separate list of every
// value costs a third of a page that the printed document does not spend.
//
// A coordinate the map does not name, or names outside this grid, yields
// nothing here — and the field then prints below instead, so no recorded value
// is ever lost to an unmappable cell.
function entriesForSheet({ grid, cellFor, titleCell, submission, values, signatures }) {
  const byCoord = new Map();
  const painted = new Set();
  const byKey = new Map((values ?? []).map((v) => [v.field_key, v.value]));
  const signed = new Map((signatures ?? []).map((s) => [s.stage, s]));

  const rendered = new Set();
  for (const row of grid?.rows ?? []) {
    for (const cell of row.cells ?? []) {
      if (cell.filler !== true) rendered.add(`${row.index}:${cell.col}`);
    }
  }

  for (const [key, cell] of Object.entries(cellFor ?? {})) {
    if (!cell) continue;
    const coord = `${cell.row}:${cell.col}`;
    if (!rendered.has(coord)) continue;
    const text = key.startsWith('sig_')
      ? signatureLine(signed.get(key.slice(4)))
      : (byKey.get(key) ?? '');
    if (!String(text ?? '').trim()) continue;
    byCoord.set(coord, String(text).trim());
    painted.add(key);
  }

  // The machine ID is not written into a cell of its own: it fills the blank
  // the printed title leaves for it, by the shared rule the preview uses.
  const machineId = submission?.machine_id;
  const titleCoord = titleCell ? `${titleCell.row}:${titleCell.col}` : null;
  if (titleCoord && rendered.has(titleCoord) && String(machineId ?? '').trim()) painted.add('machine_id');

  return {
    textAt(rowIndex, cell) {
      const coord = `${rowIndex}:${cell.col}`;
      if (coord === titleCoord) return fillTitleBlank(cell.text ?? '', machineId);
      return byCoord.get(coord) ?? cell.text ?? '';
    },
    enteredAt(rowIndex, cell) {
      return byCoord.has(`${rowIndex}:${cell.col}`);
    },
    painted
  };
}

function signatureLine(signature) {
  if (!signature) return '';
  return [signature.full_name, formatTimestamp(signature.signed_at)].filter(Boolean).join(' · ');
}

// A parts row nobody wrote anything in is not an omission — most maintenance
// visits replace no parts at all — so it prints nothing rather than four empty
// labelled lines. A row with ANY of its four boxes filled prints all four, so
// it still reads as a row of the table. Rows are judged whole: a part number
// with no quantity beside it says something, and dropping the empty box would
// hide that.
function usedPartsRows(snapshot, byKey) {
  const used = new Set();
  for (const field of snapshot) {
    const part = parsePartsKey(field.field_key);
    if (part && String(byKey.get(field.field_key) ?? '').trim()) used.add(part.row);
  }
  return used;
}

// The recorded values the SHEET has no box for — a remark the form prints no
// blank for, or a field on a document whose layout the map cannot place (a
// task's status on the two documents with no Status column). Those print
// below the form; everything else is already on it, in the box the document
// prints for it. A record whose every value is placed on the form — or whose
// only leftover fields are ones nobody actually wrote anything in — prints
// nothing here at all.
//
// A field with NOTHING entered is not a recorded value: it is an untouched
// optional field (this is what "Remarks" was on every one of the twelve real
// forms before this filter existed — always present in the snapshot, never
// mapped to a cell, and so always forcing an appendix onto an otherwise
// one-page record even when nobody had written a remark). Nothing was
// recorded, so there is nothing to append. This mirrors the same "filled"
// test completenessFor already uses (server/workflow.js): non-empty after
// trimming, so whitespace does not count as an entry either.
//
// Parts rows are the one exception, and deliberately so: they are judged
// WHOLE by usedPartsRows below, not box by box, so a used row still prints
// its own blank boxes (a part number with no quantity beside it still says
// something) rather than looking like three separate missing fields.
//
// Signature fields never appear here (the sign-off blocks carry those).
export function unmappedFields(snapshot, values, painted = new Set()) {
  if (!snapshot?.length) return [];
  const byKey = new Map((values ?? []).map((v) => [v.field_key, v.value]));
  const used = usedPartsRows(snapshot, byKey);
  return snapshot.filter((f) => {
    if (f.kind === 'signature') return false;
    if (painted.has(f.field_key)) return false;
    const part = parsePartsKey(f.field_key);
    if (part) return used.has(part.row);
    return String(byKey.get(f.field_key) ?? '').trim() !== '';
  });
}

// How the leftovers will be laid out — MEASURED, then drawn from the very same
// plan. The measurement is what the sheet's own page budget is computed
// against, so a plan that disagreed with the drawing by a dozen points would
// push a record onto a second page for no visible reason; there is therefore
// one function and one answer, not an estimate and a renderer that may drift
// from it.
//
// Grouped by section, and flowed into two columns once there are enough of
// them to be worth it. Most of these are a short label against a two-letter
// result: two of the twelve documents print no Status column at all, so every
// one of their task results lands here, and a single tall column of them costs
// a third of a page the printed form never spends.
const VALUES_COLUMN_GAP = 12;
function planValues(doc, fields, values) {
  const blocks = [];
  if (!fields?.length) return { blocks, height: 0 };

  const byKey = new Map((values ?? []).map((v) => [v.field_key, v.value]));
  const full = doc.page.width - PAGE_MARGIN * 2;
  const columns = fields.length > 8 ? 2 : 1;
  const columnWidth = (full - VALUES_COLUMN_GAP * (columns - 1)) / columns;

  doc.font('bold').fontSize(9);
  let height = doc.currentLineHeight() + 4;
  // "RECORDED VALUES" implied a complete list, which stopped being true once
  // every placeable value moved onto the sheet itself (entriesForSheet,
  // above) — this block now carries only the remainder: entries the form has
  // no printed space for. The heading says exactly that, honestly, rather
  // than implying "here is everything".
  blocks.push({ kind: 'title', text: 'ENTRIES WITH NO SPACE ON THE FORM', height });

  // Section by section, so a heading always sits above its own fields.
  const sections = [];
  for (const field of fields) {
    const name = field.section || '';
    if (!sections.length || sections[sections.length - 1].name !== name) sections.push({ name, fields: [] });
    sections[sections.length - 1].fields.push(field);
  }

  for (const section of sections) {
    if (section.name) {
      doc.font('bold').fontSize(8);
      const h = doc.currentLineHeight();
      blocks.push({ kind: 'section', text: section.name, height: h });
      height += h;
    }
    const items = section.fields.map((field) => ({
      label: `${field.label}: `,
      value: String(byKey.get(field.field_key) ?? '')
    }));
    for (let i = 0; i < items.length; i += columns) {
      const row = items.slice(i, i + columns).map((item, c) => ({
        ...item,
        x: PAGE_MARGIN + c * (columnWidth + VALUES_COLUMN_GAP),
        width: columnWidth
      }));
      doc.font('body').fontSize(8);
      const h = Math.max(...row.map((item) => doc.heightOfString(`${item.label}${item.value}`, { width: item.width })));
      blocks.push({ kind: 'row', row, height: h });
      height += h;
    }
  }
  return { blocks, height: height + 4 };
}

function drawValues(doc, plan) {
  if (!plan?.blocks.length) return;
  doc.moveDown(0.3);
  for (const block of plan.blocks) {
    ensureSpace(doc, block.height);
    if (block.kind === 'title') {
      doc.font('bold').fontSize(9).fillColor('#000').text(block.text, PAGE_MARGIN, doc.y);
      continue;
    }
    if (block.kind === 'section') {
      doc.font('bold').fontSize(8).fillColor('#333').text(block.text, PAGE_MARGIN, doc.y);
      continue;
    }
    const top = doc.y;
    for (const item of block.row) {
      doc.font('body').fontSize(8).fillColor('#000')
        .text(item.label, item.x, top, { width: item.width, continued: true })
        .font('bold').text(item.value);
    }
    doc.y = top + block.height;
  }
}

// A record that was sent back for correction says so on its own face. The
// signatures that rejection invalidated are gone from the database — they
// were claims about content that then changed — but the fact that a named
// reviewer sent it back, from which stage, when, and why, is part of what
// happened to this record and belongs on the archived document.
//
// Deliberately short: one heading and one block per rejection. A clean record
// prints nothing at all here, so this never becomes standing furniture on the
// 99% of documents that were never rejected.
function drawRejections(doc, rejections) {
  if (!rejections?.length) return;

  const width = doc.page.width - PAGE_MARGIN * 2;
  ensureSpace(doc, 24);
  doc.moveDown(0.6);
  doc.font('bold').fontSize(9).fillColor('#000').text('REJECTION HISTORY', PAGE_MARGIN, doc.y);
  doc.moveDown(0.3);

  for (const r of rejections) {
    const reason = String(r.reason ?? '');
    // Reserve the block's REAL height before drawing any of it, the same
    // discipline drawGrid uses: a long reason must break onto a new page
    // whole rather than have its first line orphaned under the heading. No
    // explicit `height` is ever passed to .text(), so a reason longer than a
    // page flows onto the next one instead of being silently clipped — the
    // exact defect that was found and fixed in the task grid.
    doc.font('body').fontSize(8);
    ensureSpace(doc, 22 + doc.heightOfString(reason, { width }));

    doc.font('bold').fontSize(8).fillColor('#000')
      .text(`${rejectionStageLabel(r.stage)} — ${r.full_name || ''}`, PAGE_MARGIN, doc.y, { width });
    doc.font('mono').fontSize(6).fillColor('#333')
      .text(formatTimestamp(r.rejected_at), PAGE_MARGIN, doc.y, { width });
    doc.font('body').fontSize(8).fillColor('#000')
      .text(reason, PAGE_MARGIN, doc.y, { width });
    doc.moveDown(0.4);
  }
}

function rejectionStageLabel(stage) {
  return ({ team_leader: 'Rejected by Team Leader', engineer: 'Rejected by Engineer' })[stage]
    || `Rejected at stage ${stage}`;
}

// The three sign-off blocks, in workflow order, each with the signature's own
// ink, the signatory's name and the SERVER's timestamp.
//
// Compact deliberately: this strip is reserved out of the sheet's page budget,
// so every point it takes is a point the controlled document above is scaled
// down by. It stays a strip rather than a page of its own because the record
// is a one-page document and its sign-off belongs on the same page as the work
// it attests to.
function drawSignatures(doc, signatures) {
  if (!signatures?.length) return;

  const headingHeight = 11;
  const blockHeight = SIGNOFF_HEIGHT - headingHeight - 4;
  ensureSpace(doc, SIGNOFF_HEIGHT);
  doc.moveDown(0.3);
  doc.font('bold').fontSize(8).fillColor('#000').text('SIGN-OFF', PAGE_MARGIN, doc.y);
  doc.moveDown(0.2);

  const blockWidth = (doc.page.width - PAGE_MARGIN * 2) / 3;
  ensureSpace(doc, blockHeight);
  const top = doc.y;

  signatures.forEach((sig, i) => {
    const x = PAGE_MARGIN + i * blockWidth;
    const inner = blockWidth - 14;
    doc.lineWidth(0.5).strokeColor('#000').undash().rect(x, top, blockWidth - 6, blockHeight).stroke();

    if (sig.image_png) {
      try {
        const base64 = String(sig.image_png).replace(/^data:image\/png;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        doc.image(buf, x + 4, top + 3, { fit: [inner, 26], align: 'left' });
      } catch {
        // A corrupt or malformed signature image must never abort the whole
        // record — skip the image, still record the name and timestamp.
      }
    }

    doc.font('body').fontSize(6).fillColor('#000')
      .text(stageLabel(sig.stage), x + 4, top + blockHeight - 24, { width: inner, height: 8, ellipsis: true });
    doc.font('bold').fontSize(7.5).fillColor('#000')
      .text(sig.full_name || '', x + 4, top + blockHeight - 16, { width: inner, height: 10, ellipsis: true });
    doc.font('mono').fontSize(5.5).fillColor('#333')
      .text(formatTimestamp(sig.signed_at), x + 4, top + blockHeight - 7, { width: inner, height: 8, ellipsis: true });
  });

  doc.y = top + blockHeight + 4;
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
