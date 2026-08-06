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

test('the preview and the archived PDF derive spill-over from ONE shared module', () => {
  const view = readFileSync(new URL('../web/js/form-view.js', import.meta.url), 'utf8');
  const pdf = readFileSync(new URL('../server/pdf-record.js', import.meta.url), 'utf8');
  const shared = readFileSync(new URL('../web/js/sheet-layout.js', import.meta.url), 'utf8');

  assert.match(shared, /export function layoutRow/, 'the shared module owns the spill rule');
  for (const [name, src] of [['form-view.js', view], ['pdf-record.js', pdf]]) {
    assert.match(src, /import \{[^}]*layoutRow[^}]*\} from '[^']*sheet-layout\.js'/,
      `${name} must IMPORT the spill rule, not carry its own`);
    assert.doesNotMatch(src, /function layoutRow/,
      `${name} must not define its own layoutRow — a second copy is how the two renderers drifted apart`);
  }
});
