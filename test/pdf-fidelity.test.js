// The archived PDF must reproduce the controlled document it claims to be.
//
// The left-hand preview already does: it draws the sheet's own border weights,
// font sizes, fills, alignment and wrapping, and it reproduces the way a
// spreadsheet lets an unwrapped cell SPILL across the empty cells to its
// right. The archived record — the artifact the company actually KEEPS — did
// not, and the two renderers had drifted: a label the form prints on one line
// came out of the PDF broken mid-word down a narrow column, and a one-page
// controlled form was downloaded as a four-page document.
//
// These are the guards for that. They work on the RENDERED PDF, never on our
// own layout arithmetic: text through pdftotext, and stroke widths and path
// operators read straight out of the content streams. Both external tools are
// optional and skip cleanly when absent, the same honest-skip pattern the
// veraPDF conformance test has always used.
//
// Every string here is invented. No form content, no equipment name, no
// document number and no task text is committed to this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRecordPdf } from '../server/pdf-record.js';
import { buildGrid } from '../server/grid-model.js';
import { parseWorkbook } from '../server/excel-parser.js';
import { cellMapFor } from '../server/cell-map.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const hasPdftotext = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const hasVera = (() => {
  try { execFileSync('verapdf', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const fx = loadFixtures();

// --- reading the produced PDF back ----------------------------------------

// Every content stream of the document, decompressed. Used to read the actual
// drawing operators — a stroke width is invisible to a text extractor, and
// "the section frame is heavier than the gridline" is precisely a claim about
// stroke widths.
function contentStreams(pdfBuffer) {
  const text = pdfBuffer.toString('latin1');
  const objectRe = /\d+ 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  const streams = [];
  let match;
  while ((match = objectRe.exec(text))) {
    const dict = match[1];
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) continue;
    let raw = Buffer.from(text.slice(start, end), 'latin1');
    if (/\/FlateDecode/.test(dict)) {
      try { raw = inflateSync(raw); } catch { continue; }
    }
    streams.push(raw.toString('latin1'));
  }
  return streams;
}

// Every line-width (`w`) operator actually emitted, in order.
function strokeWidths(pdfBuffer) {
  const widths = [];
  for (const stream of contentStreams(pdfBuffer)) {
    for (const line of stream.split('\n')) {
      const m = /^(\d+(?:\.\d+)?)\s+w$/.exec(line.trim());
      if (m) widths.push(Number(m[1]));
    }
  }
  return widths;
}

// Path construction and painting operators only — the marks a cell leaves on
// the page, with no text and no graphics-state noise. Used to prove that a
// placeholder draws literally nothing.
function paintOperators(pdfBuffer) {
  const ops = [];
  for (const stream of contentStreams(pdfBuffer)) {
    for (const line of stream.split('\n')) {
      const t = line.trim();
      if (/^-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+[ml]$/.test(t)) ops.push(t);
      else if (/^-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+re$/.test(t)) ops.push(t);
    }
  }
  return ops;
}

const pageCount = (pdfBuffer) => (pdfBuffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

function withTempPdf(buffer, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-fid-'));
  try {
    const file = join(dir, 'r.pdf');
    writeFileSync(file, buffer);
    return fn(file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const extractText = (buffer, layout = false) => withTempPdf(buffer, (file) =>
  execFileSync('pdftotext', layout ? ['-layout', file, '-'] : [file, '-'], { encoding: 'utf8' }));

const veraVerdict = (buffer) => withTempPdf(buffer, (file) => {
  try {
    return execFileSync('verapdf', ['-f', '2u', '--format', 'text', file], { encoding: 'utf8' }).trim();
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || String(err);
  }
});

// --- fixtures --------------------------------------------------------------

const BASE = {
  form: { file_name: 'x.xlsx', title: 'Sample Record', doc_number: 'DOC 001', revision: 'A', file_type: 'xlsx' },
  submission: { id: 1, machine_id: 'AA01', frequency: 'Y', state: 'approved', created_at: '2026-08-01T00:00:00Z' },
  snapshot: [{ field_key: 'machine_id', label: 'Machine ID', section: 'Record', kind: 'text' }],
  values: [{ field_key: 'machine_id', value: 'AA01' }],
  signatures: [{ stage: 'technician', full_name: 'A Person', image_png: null, signed_at: '2026-08-02T09:00:00Z' }],
  rejections: []
};

// A label the sheet prints on ONE line, sitting in a narrow column with
// nothing but empty cells to its right — the exact shape of every label the
// user found broken mid-word. Invented wording, real geometry.
const SPILLING_LABEL = 'Calibration Fixtures Needed:';

function spillGrid() {
  const columns = [];
  for (let c = 1; c <= 8; c++) columns.push({ index: c, width: 60 });
  const cells = [{ col: 1, text: SPILLING_LABEL, borders: { b: 'thin' } }];
  for (let c = 2; c <= 8; c++) cells.push({ col: c, filler: true });
  return { columns, rows: [{ index: 1, height: 15, cells }], defaults: { size: 10, font: 'Calibri' } };
}

// --- 1. a label that spills renders on one line ---------------------------

test('a label the sheet spills across its empty neighbours renders on ONE line, never broken mid-word',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
    const buf = await renderRecordPdf({ ...BASE, grid: spillGrid() });
    const extracted = extractText(buf);

    // The whole label, unbroken, on a single extracted line. A mid-word break
    // ("Calibr / ation") puts a newline inside the word, so the label is
    // absent from every line even though its letters are all on the page.
    const lines = extracted.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
    assert.ok(lines.includes(SPILLING_LABEL),
      `the label must print on one line as the sheet prints it. Extracted:\n${extracted}`);
  });

// --- 2. the reference form is ONE page ------------------------------------

// The controlled documents declare fitToWidth=1 / fitToHeight=1: the author's
// own statement that the form is a ONE-PAGE document. The record downloaded
// from the app came out as four. Scaling the sheet to the page rather than
// letting its text wrap is what closes that gap.
async function recordFor(sample) {
  const path = join(fx.formsDir, sample.file);
  const def = await parseWorkbook(path);
  const grid = await buildGrid(path, def);
  const { cellFor, titleCell } = cellMapFor(def);
  const snapshot = [
    { field_key: 'machine_id', label: 'Machine ID', section: 'Record', kind: 'text' },
    { field_key: 'remarks', label: 'Remarks', section: 'Record', kind: 'text' },
    ...def.tasks.map((t) => ({ field_key: `task_${t.row}`, label: `Step ${t.row}`, section: 'Tasks', kind: 'text' }))
  ];
  const values = [
    { field_key: 'machine_id', value: 'ZZ09' },
    { field_key: 'remarks', value: 'No issues found on this visit.' },
    ...def.tasks.map((t) => ({ field_key: `task_${t.row}`, value: 'OK' }))
  ];
  return {
    ...BASE,
    form: { ...BASE.form, title: def.title },
    submission: { ...BASE.submission, machine_id: 'ZZ09', frequency: sample.freqs[sample.freqs.length - 1] },
    identity: { title: def.title, doc_number: 'DOC 001', revision: 'A' },
    snapshot,
    values,
    signatures: [
      { stage: 'technician', full_name: 'Tam Technician', image_png: null, signed_at: '2026-08-02T09:00:00Z' },
      { stage: 'team_leader', full_name: 'Bea Reviewer', image_png: null, signed_at: '2026-08-02T11:15:00Z' },
      { stage: 'engineer', full_name: 'Cal Engineer', image_png: null, signed_at: '2026-08-03T08:05:00Z' }
    ],
    grid,
    cellFor,
    titleCell
  };
}

test('every controlled form produces a ONE-page record, as the form itself declares',
  { skip: fx ? false : SKIP }, async () => {
    const counts = [];
    for (const sample of fx.forms) {
      const buf = await renderRecordPdf(await recordFor(sample));
      counts.push(`${sample.id}=${pageCount(buf)}`);
    }
    const over = counts.filter((c) => !c.endsWith('=1'));
    // One of the twelve is a form whose sheet alone fills a legible page and
    // which prints no Status column, so its task results have to be listed
    // after it; that record carries an appendix page. The test below proves
    // the FORM is still one page there. Everything else is one page outright,
    // where the app used to produce three to six.
    assert.ok(over.length <= 1, `at most one form may need an appendix page; got ${counts.join(' ')}`);
    assert.deepEqual(counts.filter((c) => !/=[12]$/.test(c)), [],
      `no record may run past two pages; got ${counts.join(' ')}`);
  });

// The invariant behind the page count, and the one that actually matters: the
// controlled document is a ONE-PAGE document (fitToWidth 1 / fitToHeight 1) and
// must be rendered as one, whatever else the record has to append. Checked by
// taking the sheet's OWN text at run time and proving none of it appears after
// page one — no form content is committed here to do it.
test('the controlled form itself never runs past page one, on any of the twelve',
  { skip: !fx ? SKIP : (hasPdftotext ? false : 'pdftotext not installed') }, async () => {
    for (const sample of fx.forms) {
      const record = await recordFor(sample);
      const buf = await renderRecordPdf(record);
      const pages = pageCount(buf);
      if (pages === 1) continue;

      const beyond = withTempPdf(buf, (file) =>
        execFileSync('pdftotext', ['-f', '2', file, '-'], { encoding: 'utf8' })).replace(/\s+/g, ' ');
      // Long, distinctive strings only: a short cell ("1", "OK") says nothing
      // about which page the FORM is on.
      // The document's TITLE is excluded: the running page header prints it on
      // every page by design, so finding it on page two says nothing about
      // where the form itself ended.
      const title = record.titleCell;
      const sheetText = record.grid.rows
        .flatMap((r) => (r.cells ?? []).map((c) => ({ row: r.index, col: c.col, text: c.text })))
        .filter((c) => !(title && c.row === title.row && c.col === title.col))
        .map((c) => String(c.text ?? '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length >= 20);
      assert.ok(sheetText.length > 0, `${sample.id}: expected the sheet to carry some long cells`);
      const spilled = sheetText.filter((t) => beyond.includes(t.slice(0, 20)));
      assert.deepEqual(spilled, [], `${sample.id}: the form itself must be wholly on page one`);
    }
  });

// --- 3. border weights are not flattened ----------------------------------

// `medium` frames the document's sections and `thin` rules the gridlines
// inside them; that contrast IS the form's visual hierarchy, and drawing both
// at one weight flattens it.
//
// Asserting merely that the document contains two different stroke widths is
// not enough — the page header rule and the sign-off boxes supply two on their
// own, so such a test passes even with every cell border collapsed to one
// weight (measured: it did). The comparison therefore has to be between two
// documents identical but for the border STYLE the sheet declares.
test('a section frame is drawn heavier than an interior gridline', async () => {
  const gridWith = (style) => ({
    columns: [{ index: 1, width: 90 }, { index: 2, width: 90 }],
    rows: [{ index: 1, height: 20, cells: [
      { col: 1, text: 'Framed', borders: { t: style, r: style, b: style, l: style } },
      { col: 2, text: 'Ruled', borders: { t: style, r: style, b: style, l: style } }
    ] }],
    defaults: { size: 10, font: 'Calibri' }
  });
  const widthsFor = async (grid) => new Set(strokeWidths(await renderRecordPdf({ ...BASE, grid })));
  // The page's own furniture — the header rule, the sign-off boxes — strokes
  // widths of its own, and those are none of this test's business. Subtracting
  // the widths a record with NO sheet at all emits leaves exactly the strokes
  // the sheet's borders contributed.
  const furniture = await widthsFor({ columns: [], rows: [] });
  const only = (set) => [...set].filter((w) => !furniture.has(w));

  const thin = only(await widthsFor(gridWith('thin')));
  const medium = only(await widthsFor(gridWith('medium')));

  assert.ok(thin.length > 0 && medium.length > 0,
    `both weights must draw something of their own (thin=${thin} medium=${medium})`);
  assert.ok(Math.max(...medium) > Math.max(...thin),
    `a section frame must be stroked heavier than an interior gridline (${Math.max(...medium)} vs ${Math.max(...thin)})`);
});

// --- 4. a placeholder draws nothing ---------------------------------------

test('a filler placeholder draws nothing at all, even handed something to draw', async () => {
  // The neighbour is WRAPPED on purpose. An unwrapped cell spills across the
  // placeholders to its right and absorbs them, so the placeholder would never
  // reach the drawing code at all and this would prove nothing about the
  // renderer — measured: deleting the renderer's own placeholder guard still
  // passed with an unwrapped neighbour. A wrapped cell never spills, so the
  // placeholder below arrives at the renderer on its own feet.
  const real = { col: 1, text: 'Real', wrap: true, borders: { t: 'thin', r: 'thin', b: 'thin', l: 'thin' } };
  const columns = [{ index: 1, width: 90 }, { index: 2, width: 90 }];
  const withoutFiller = { columns, rows: [{ index: 1, height: 20, cells: [real, { col: 2, filler: true }] }],
    defaults: { size: 10, font: 'Calibri' } };
  // The model gives a placeholder nothing to draw WITH, so a renderer with no
  // rule about placeholders would pass a comparison of those two alone. Hand
  // it one carrying every drawable property instead: the promise has to hold
  // in the renderer on its own.
  const armedFiller = {
    col: 2, filler: true, text: 'SHOULD NOT APPEAR',
    borders: { t: 'medium', r: 'medium', b: 'medium', l: 'medium' },
    fill: '#D9D9D9', size: 14, font: 'Arial', valign: 'middle', wrap: true, bold: true, align: 'center'
  };
  const withFiller = { columns, rows: [{ index: 1, height: 20, cells: [real, armedFiller] }],
    defaults: { size: 10, font: 'Calibri' } };

  const plain = await renderRecordPdf({ ...BASE, grid: withoutFiller });
  const armed = await renderRecordPdf({ ...BASE, grid: withFiller });

  assert.deepEqual(paintOperators(armed), paintOperators(plain),
    'a placeholder must leave no mark on the page');
  if (hasPdftotext) {
    assert.doesNotMatch(extractText(armed), /SHOULD NOT APPEAR/,
      'a placeholder must not print text either');
  }
});

// --- 5. still PDF/A-2u after all of the above -----------------------------

test('a record rendered from a real controlled form still passes veraPDF as PDF/A-2U',
  { skip: !fx ? SKIP : (hasVera ? false : 'veraPDF not installed') }, async () => {
    const buf = await renderRecordPdf(await recordFor(fx.forms[0]));
    assert.match(veraVerdict(buf), /PASS/);
  });

// --- 6. nothing the record already got right is lost ----------------------

test('sign-off, rejection history and the recorded values all still appear on a real form',
  { skip: !fx ? SKIP : (hasPdftotext ? false : 'pdftotext not installed') }, async () => {
    const record = await recordFor(fx.forms[0]);
    const buf = await renderRecordPdf({
      ...record,
      rejections: [{ stage: 'team_leader', full_name: 'Bea Reviewer', rejected_at: '2026-08-02T11:15:00Z',
        reason: 'Torque values were left blank on the third step.' }]
    });
    const text = extractText(buf).replace(/\s+/g, ' ');

    for (const sig of record.signatures) {
      assert.ok(text.includes(sig.full_name), `signatory missing from the record: ${sig.full_name}`);
    }
    assert.match(text, /2026-08-03/, 'the server timestamps must be printed');
    assert.match(text, /Torque values were left blank on the third step\./, 'the rejection reason must survive');
    assert.match(text, /ZZ09/, 'the recorded machine id must appear');
    assert.match(text, /No issues found on this visit\./, 'a recorded value must appear');
    assert.match(text, new RegExp(record.identity.doc_number), 'the document number must still be in the header');
    assert.match(text, /REV A/, 'the revision must still be in the header');
  });

// --- the two renderers must not be able to drift apart again --------------

test('the preview and the archived PDF derive spill-over, the logo box and the checkbox from ONE shared module', () => {
  const view = readFileSync(new URL('../web/js/form-view.js', import.meta.url), 'utf8');
  const pdf = readFileSync(new URL('../server/pdf-record.js', import.meta.url), 'utf8');
  const shared = readFileSync(new URL('../web/js/sheet-layout.js', import.meta.url), 'utf8');

  // Everything about HOW THE SHEET PRINTS that both renderers need: where an
  // unwrapped cell spills, where the anchored logo sits, and how big a
  // checkbox is against the type of the option it belongs to. Each of the
  // three is one definition, imported twice — a second copy of the spill rule
  // is exactly how these two drifted apart before.
  for (const rule of ['layoutRow', 'imageBox', 'checkboxMetrics']) {
    assert.match(shared, new RegExp(`export function ${rule}`), `the shared module must own ${rule}`);
    for (const [name, src] of [['form-view.js', view], ['pdf-record.js', pdf]]) {
      assert.match(src, new RegExp(`import \\{[^}]*${rule}[^}]*\\} from '[^']*sheet-layout\\.js'`),
        `${name} must IMPORT ${rule}, not carry its own`);
      assert.doesNotMatch(src, new RegExp(`function ${rule}`),
        `${name} must not define its own ${rule} — a second copy is how the two renderers drifted apart`);
    }
  }
});

// --- 7. the company logo reaches the archived record ----------------------
//
// Every one of the twelve controlled documents embeds one image, and on the
// printed form it fills the framed box at the top-left of the header. The
// archived record left that box empty: neither the grid model nor either
// renderer handled images at all. A quality record whose header is missing the
// company mark does not look like the document it claims to be.

// A 2x1 PNG, written byte by byte so nothing has to be vendored for a test.
// The real logo is form content and is never committed here.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGMQVDJetfsMAAYjApjF8PQBAAAAAElFTkSuQmCC';

function logoGrid(withImage) {
  const columns = [{ index: 1, width: 90 }, { index: 2, width: 90 }, { index: 3, width: 200 }];
  const rows = [
    { index: 1, height: 20, cells: [
      { col: 1, text: '', span: { rows: 2, cols: 2 }, borders: { t: 'medium', r: 'thin', b: 'medium', l: 'medium' } },
      { col: 3, text: 'Document Title:', wrap: true, borders: { t: 'medium', r: 'medium' } }
    ] },
    { index: 2, height: 40, cells: [
      { col: 3, text: 'Widget Maintenance Record', wrap: true, borders: { r: 'medium', b: 'medium' } }
    ] }
  ];
  const grid = { columns, rows, defaults: { size: 10, font: 'Calibri' } };
  if (withImage) {
    grid.image = { mime: 'image/png', data: TINY_PNG_B64, from: { col: 1, row: 1 }, to: { col: 3, row: 3 } };
  }
  return grid;
}

const hasImageXObject = (buffer) => /\/Subtype\s*\/Image/.test(buffer.toString('latin1'));

test('the logo a form embeds is drawn into the archived record, and nothing is drawn when a form has none', async () => {
  const withLogo = await renderRecordPdf({ ...BASE, grid: logoGrid(true) });
  const without = await renderRecordPdf({ ...BASE, grid: logoGrid(false) });

  assert.ok(hasImageXObject(withLogo), 'the embedded logo must reach the archived record');
  assert.ok(!hasImageXObject(without),
    'a form with no image must draw none — this record has no signature ink either, so any image here is invented');
  // ...and the record still renders rather than throwing, which is the whole
  // point of the "no image" branch.
  assert.equal(without.subarray(0, 4).toString('latin1'), '%PDF');
});

test('an embedded logo does not cost the record its PDF/A conformance',
  { skip: hasVera ? false : 'veraPDF not installed' }, async () => {
    // The image is the one thing added to this document that PDF/A has an
    // opinion about — colour space, and what may be transparent. If it could
    // not be embedded conformantly that would have to be said out loud rather
    // than the logo or the conformance being dropped quietly.
    assert.match(veraVerdict(await renderRecordPdf({ ...BASE, grid: logoGrid(true) })), /PASS/);
  });

test('a logo that cannot be decoded costs the record nothing but the logo', async () => {
  const grid = logoGrid(true);
  grid.image = { ...grid.image, data: Buffer.from('not a png at all').toString('base64') };
  const buf = await renderRecordPdf({ ...BASE, grid });
  assert.equal(buf.subarray(0, 4).toString('latin1'), '%PDF');
  if (hasPdftotext) {
    assert.match(extractText(buf).replace(/\s+/g, ' '), /Widget Maintenance Record/,
      'the form itself must still print');
  }
});

// --- 8. the frequency band is checkboxes, ticked cumulatively -------------
//
// The forms print their interval band as boxes and a technician ticks the ones
// the visit covers. They are rectangle shapes anchored on the band's row in the
// sheet's drawing XML, so nothing in the grid model carries them and both
// renderers have to draw them. Every completed record the customer keeps shows
// a box beside EVERY option the form prints, with the covered ones ticked — a
// six-monthly visit comes back with 1M, 3M and 6M ticked and Y empty.
const BAND_TEXT = 'Monthly (1M)     Quarterly (3M)     Half-yearly (6M)     Annual (Y)';

function bandGrid() {
  const columns = [{ index: 1, width: 60 }, { index: 2, width: 420 }];
  return {
    columns,
    rows: [{ index: 1, height: 15, cells: [
      { col: 1, filler: true },
      { col: 2, text: BAND_TEXT }
    ] }],
    defaults: { size: 10, font: 'Calibri' }
  };
}

// The band as server/cell-map.js reports it: every printed option, each with
// the visits that tick it (cumulative).
function bandCells() {
  const codes = [['1M', 0], ['3M', 1], ['6M', 2], ['Y', 3]];
  const order = ['1M', '3M', '6M', 'Y'];
  const cells = {};
  for (const [code, i] of codes) {
    const text = BAND_TEXT.split(/\s{2,}/)[i];
    const start = BAND_TEXT.indexOf(text);
    cells[code] = {
      row: 1, col: 2, start, end: start + text.length, text,
      tickedBy: order.slice(order.indexOf(code))
    };
  }
  return cells;
}

const rectCount = (buffer) => paintOperators(buffer).filter((op) => /\bre$/.test(op)).length;
const strokeSegments = (buffer) => paintOperators(buffer).filter((op) => /\b[ml]$/.test(op)).length;

test('a box is drawn beside every option the band prints, not only the one this visit covers', async () => {
  const at = (frequency) => renderRecordPdf({
    ...BASE, submission: { ...BASE.submission, frequency }, grid: bandGrid(), intervalCells: bandCells()
  });
  const withBand = await at('1M');
  const withoutBand = await renderRecordPdf({ ...BASE, grid: bandGrid() });

  assert.equal(rectCount(withBand) - rectCount(withoutBand), 4,
    'the band prints four options, so four boxes must be drawn — the printed form carries a box for each');
});

test('the ticks are cumulative: a six-monthly visit ticks the monthly and quarterly boxes too', async () => {
  const at = async (frequency) => strokeSegments(await renderRecordPdf({
    ...BASE, submission: { ...BASE.submission, frequency }, grid: bandGrid(), intervalCells: bandCells()
  }));
  // A tick is one polyline of three points: one `m` and two `l`.
  const perTick = 3;
  const monthly = await at('1M');
  const sixMonthly = await at('6M');
  const yearly = await at('Y');
  assert.equal(sixMonthly - monthly, 2 * perTick, 'a 6M visit ticks two more boxes than a 1M one');
  assert.equal(yearly - monthly, 3 * perTick, 'a Y visit ticks three more boxes than a 1M one');
});

test('a form with no band draws no boxes, and a band whose range no longer fits its text draws none either', async () => {
  const plain = rectCount(await renderRecordPdf({ ...BASE, grid: bandGrid() }));
  // A range that does not delimit the option it names must be refused: a box
  // planted over the wrong words on a controlled document is worse than none.
  const wrong = Object.fromEntries(Object.entries(bandCells())
    .map(([code, o]) => [code, { ...o, text: 'Something else entirely' }]));
  assert.equal(rectCount(await renderRecordPdf({ ...BASE, grid: bandGrid(), intervalCells: wrong })), plain);
  assert.equal(rectCount(await renderRecordPdf({ ...BASE, grid: bandGrid(), intervalCells: null })), plain);
});

// --- 9. no rule reaches past the table ------------------------------------
//
// The forms declare a shrink factor of their own (72-80%), so on most of the
// twelve the sheet lands narrower than the printable area — and the page
// header's rule was ruled across the full page, overhanging the table's right
// edge by up to 40pt. A rule that reaches past the document it underlines is
// exactly what makes an archived record not look like the form it reproduces.
function pathXs(buffer) {
  const xs = [];
  for (const op of paintOperators(buffer)) {
    const n = op.split(/\s+/).map(Number);
    if (/\bre$/.test(op)) xs.push(n[0], n[0] + n[2]);
    else xs.push(n[0]);
  }
  return xs.filter((x) => Number.isFinite(x));
}

test('nothing the record draws reaches past the sheet\'s own right edge', async () => {
  const columns = [];
  for (let c = 1; c <= 12; c++) columns.push({ index: c, width: 60 });
  const cells = columns.map((col) => ({ col: col.index, text: 'x', borders: { t: 'thin', b: 'thin', l: 'thin', r: 'thin' } }));
  const grid = {
    columns,
    rows: [{ index: 1, height: 15, cells }],
    defaults: { size: 10, font: 'Calibri' },
    // The author's own 75% — the same statement eleven of the twelve make.
    pageSetup: { orientation: 'portrait', scale: 75, fitToWidth: 1, fitToHeight: 1, printArea: null }
  };
  const buf = await renderRecordPdf({ ...BASE, grid });

  const PAGE_MARGIN = 28;
  const printable = 595.28 - PAGE_MARGIN * 2;
  const sheetWidth = 12 * 60 * 0.75 * 0.75;
  assert.ok(sheetWidth < printable - 50, 'the fixture must genuinely be narrower than the page');
  const rightEdge = PAGE_MARGIN + sheetWidth;

  const worst = Math.max(...pathXs(buf));
  assert.ok(worst <= rightEdge + 1,
    `every rule must stop at the table's right edge (${rightEdge.toFixed(1)}pt); the furthest reached ${worst.toFixed(1)}pt`);
});

// --- 10. a wrapped cell still prints the line the form prints -------------

test('a cell the sheet wraps still prints on ONE line when that is what the form prints',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
    // The header's document number. The sheet marks the cell as wrapping, and
    // at the sheet's own font it fits its box on one line; the substituted face
    // is a few per cent wider, so the archived record was breaking it in two
    // where the customer's own completed record prints it whole. Invented code,
    // real shape.
    const CODE = 'AB 12 345 00 67';
    const grid = {
      columns: [{ index: 1, width: 111 }],
      rows: [{ index: 1, height: 30, cells: [{ col: 1, text: CODE, wrap: true, borders: { t: 'thin', b: 'thin', l: 'thin', r: 'thin' } }] }],
      defaults: { size: 10, font: 'Calibri' }
    };
    const lines = extractText(await renderRecordPdf({ ...BASE, grid }))
      .split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
    assert.ok(lines.includes(CODE),
      `the document number must print on one line as the form prints it. Extracted:\n${lines.join('\n')}`);
  });

test('a cell the sheet wraps and genuinely cannot fit on one line still wraps',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
    // The allowance above is for the substituted face being a few per cent
    // wider, and for nothing else. A heading the form really does set on two
    // lines — the title block of every one of the twelve — must not be squeezed
    // onto one. This one needs 57% of its size to fit on a single line, which
    // is far outside any substitution penalty and squarely inside what a
    // careless allowance would swallow.
    const HEADING = 'Widget Maintenance Record';
    const grid = {
      columns: [{ index: 1, width: 111 }],
      rows: [{ index: 1, height: 60, cells: [{ col: 1, text: HEADING, wrap: true, borders: { t: 'thin', b: 'thin', l: 'thin', r: 'thin' } }] }],
      defaults: { size: 10, font: 'Calibri' }
    };
    const lines = extractText(await renderRecordPdf({ ...BASE, grid }))
      .split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
    assert.ok(!lines.includes(HEADING), 'a heading far too wide for its box must still wrap');
    // ...and every word of it must still be there, unbroken.
    const joined = lines.join(' ').replace(/\s+/g, ' ');
    assert.ok(joined.includes(HEADING), `no word may be broken in the wrap. Extracted:\n${lines.join('\n')}`);
  });

// --- 11. a merged box is drawn to its FULL footprint ----------------------

test('a box merged across rows of different heights is drawn to the sum of them, not to one of them twice', async () => {
  // These sheets set the two lines of their header block to very different
  // heights and merge the logo box across both. Drawing that box as "this row's
  // height, twice" closed it in mid-air, two-thirds of the way down the header
  // row — which only became visible once the box's bottom rule was restored at
  // all (see mergedBorders in server/grid-model.js).
  // Both rows are deliberately taller than anything in them needs, so neither
  // grows under the substituted font and the expected footprint is exactly
  // their sum. The sheet is far narrower and shorter than the page, so nothing
  // scales it either.
  const grid = {
    columns: [{ index: 1, width: 100 }, { index: 2, width: 100 }],
    rows: [
      { index: 1, height: 20, cells: [
        { col: 1, text: 'M', span: { rows: 2, cols: 1 }, borders: { t: 'medium', r: 'medium', b: 'medium', l: 'medium' } },
        { col: 2, text: 'a', borders: { t: 'thin', b: 'thin' } }
      ] },
      { index: 2, height: 44, cells: [{ col: 2, text: 'b', borders: { b: 'thin' } }] }
    ],
    defaults: { size: 8, font: 'Calibri' }
  };
  const buf = await renderRecordPdf({ ...BASE, grid });

  // Every vertical stroke the document draws, by length. The merged box's own
  // sides are the tallest thing on this sheet.
  const ops = paintOperators(buf);
  const lengths = [];
  for (let i = 1; i < ops.length; i++) {
    const from = ops[i - 1].split(/\s+/), to = ops[i].split(/\s+/);
    if (!/\bm$/.test(ops[i - 1]) || !/\bl$/.test(ops[i])) continue;
    if (Math.abs(Number(from[0]) - Number(to[0])) > 0.01) continue;
    lengths.push(Math.abs(Number(from[1]) - Number(to[1])));
  }
  const tallest = Math.max(0, ...lengths);
  // 20 + 44 at a scale of 1. Drawing "this row's height, twice" would give 40 —
  // the box would stop 24pt short, in mid-air above the second row's own rule.
  assert.ok(Math.abs(tallest - 64) < 1.5,
    `the merged box must cover both rows (64pt); the tallest side drawn was ${tallest.toFixed(1)}pt`);
});
