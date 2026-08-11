import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { renderRecordPdf } from '../server/pdf-record.js';

// Scan every content stream in a PDF for raw path-construction operators
// (`x y m` / `x y l` — moveto/lineto, one per line as PDFKit emits them) and
// return every y-coordinate found. Used to catch a cell BORDER drawn past
// the page, which a text-only extractor (pdftotext) cannot see at all —
// confirmed by hand: reintroducing the span-overflow bug produced a `28 842
// m` / `567.28 842 l` border on an A4 page only 841.89pt tall, with no word
// anywhere near that y, so a text-bounding-box check alone missed it.
function extractPathYCoordinates(pdfBuffer) {
  const text = pdfBuffer.toString('latin1');
  const objectRe = /\d+ 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  const ys = [];
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
    for (const line of raw.toString('latin1').split('\n')) {
      const m = /^(-?\d+\.?\d*) (-?\d+\.?\d*) [ml]$/.exec(line.trim());
      if (m) ys.push(Number(m[2]));
    }
  }
  return ys;
}

const FIXTURE = {
  form: { file_name: 'x.xlsx', title: 'Sample Record', doc_number: 'DOC 001', revision: 'A', file_type: 'xlsx' },
  submission: { id: 1, machine_id: 'AA01', frequency: 'Y', state: 'approved', created_at: '2026-08-01T00:00:00Z' },
  snapshot: [
    { field_key: 'machine_id', label: 'Machine ID', section: 'Record', kind: 'text' },
    { field_key: 'task_28', label: 'Check the widget', section: 'Tasks', kind: 'text' }
  ],
  values: [{ field_key: 'machine_id', value: 'AA01' }, { field_key: 'task_28', value: 'OK' }],
  signatures: [{ stage: 'technician', full_name: 'A Person', image_png: null, signed_at: '2026-08-02T09:00:00Z' }],
  grid: { columns: [{ index: 1, width: 60 }], rows: [{ index: 1, height: 15, cells: [
    { col: 1, span: { rows: 1, cols: 1 }, text: 'Header', bold: true, align: 'left',
      borders: { t: true, r: true, b: true, l: true } }] }] }
};

test('produces a PDF carrying every PDF/A-2u structure', async () => {
  const buf = await renderRecordPdf(FIXTURE);
  const s = buf.toString('latin1');
  assert.match(s.slice(0, 9), /^%PDF-1\.7/);
  assert.ok(s.includes('FontFile2'), 'font must be embedded');
  assert.ok(s.includes('ToUnicode'), 'text must carry a Unicode map — this is what the "u" means');
  assert.ok(s.includes('ICCBased'), 'OutputIntent needs a real ICC profile stream');
  assert.ok(s.includes('OutputIntent'), 'PDF/A requires an OutputIntent');
  assert.match(s, /pdfaid:part[^0-9]*2/, 'must declare part 2');
  assert.match(s, /pdfaid:conformance[^A-Z]*U/, 'must declare conformance U, not the PDFKit default B');
  assert.ok(!s.includes('/Encrypt'), 'PDF/A forbids encryption');
});

test('embeds a signature image when present', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const buf = await renderRecordPdf({ ...FIXTURE,
    signatures: [{ stage: 'technician', full_name: 'A Person', image_png: png, signed_at: '2026-08-02T09:00:00Z' }] });
  assert.ok(buf.toString('latin1').includes('/Image'), 'signature image should be drawn');
});

test('a malformed signature image does not abort the record', async () => {
  // A record must still be producible even if one signature blob is corrupt.
  const buf = await renderRecordPdf({ ...FIXTURE,
    signatures: [{ stage: 'technician', full_name: 'A Person', image_png: 'data:image/png;base64,NOTVALID', signed_at: 'x' }] });
  assert.ok(buf.length > 1000);
});

// Real conformance is a claim an archive will reject if wrong. Validate it for
// real where veraPDF is available, and skip cleanly where it is not.
const hasVera = (() => {
  try { execFileSync('verapdf', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('veraPDF confirms PDF/A-2U conformance', { skip: hasVera ? false : 'veraPDF not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pdfa-'));
  try {
    const file = join(dir, 'r.pdf');
    writeFileSync(file, await renderRecordPdf(FIXTURE));
    const out = execFileSync('verapdf', ['-f', '2u', '--format', 'text', file], { encoding: 'utf8' });
    assert.match(out, /PASS/, `veraPDF reported: ${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Fix round 1 — a 236-char safety instruction was found silently truncated
// mid-sentence by PDFKit's fixed-height text box, with no visual or logged
// trace. drawGrid now measures each cell and grows the row to fit instead.
// Verify with a real text extractor (pdftotext, from poppler) rather than
// trusting our own measurement math — skip cleanly if it is not installed,
// the same pattern already used for the veraPDF test above.
const hasPdftotext = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const LONG_INSTRUCTION = 'Perform a full visual and functional inspection of the pick ' +
  'and place head assembly, verify bondhead initialization position, and confirm ESD ' +
  'grounding is below 1.0 ohm at all measurement points before returning the machine to ' +
  'production use.';

test('a long task instruction is never silently truncated', { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
  assert.ok(LONG_INSTRUCTION.length > 200, 'fixture sentence must actually be 200+ chars');
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const buf = await renderRecordPdf({ ...FIXTURE,
    grid: { columns: [{ index: 1, width: 60 }], rows: [
      { index: 1, height: 26, cells: [{ col: 1, span: { rows: 1, cols: 1 }, text: LONG_INSTRUCTION,
        bold: false, align: 'left', borders: { t: true, r: true, b: true, l: true } }] }
    ] } });
  const dir = mkdtempSync(join(tmpdir(), 'pdftext-'));
  try {
    const file = join(dir, 'r.pdf');
    writeFileSync(file, buf);
    const extracted = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
    const normalized = extracted.replace(/\s+/g, ' ').trim();
    assert.ok(normalized.includes(LONG_INSTRUCTION),
      `full instruction missing from extracted text — it was truncated. Extracted: "${normalized}"`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A merged (span.rows > 1) cell positioned so that ITS OWN row would fit on
// the current page but its full multi-row footprint would not. Before the
// fix, ensureSpace only reserved the single-row height, so the tall cell's
// BORDER (not just its text) could be drawn past the bottom margin — a text
// extractor alone misses this, since the cell's own text can sit well above
// the overflowing border. Verified by hand: reintroducing the old
// single-row-only ensureSpace call reproduced a `28 842 m` / `567.28 842 l`
// border on an A4 page only 841.89pt tall (843pt > page height), while every
// WORD (including "SPANCELL" itself) stayed within bounds — proving a
// word-bounding-box check alone is not sufficient here. This test therefore
// checks both: word boxes via pdftotext -tsv, AND raw path-operator
// coordinates via extractPathYCoordinates.
test('a spanning cell near a page boundary does not overflow past the bottom margin',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // The sheet is now SCALED to the page rather than drawn at a fixed row
  // height, so the old fixture's arithmetic (44 rows of 26 units landing the
  // next row at y=778) no longer picks out a page boundary — that sheet simply
  // shrinks until it fits one page, and the case goes untested.
  //
  // So this fixture is built to be genuinely unpageable: far more rows than
  // even the smallest permitted scale can fit, which FORCES real page breaks,
  // with a 4-row spanning cell every tenth row so that one of them is bound to
  // land near a boundary. The column is wide enough that scaling never squeezes
  // a word out of it, which is a separate concern with its own guard.
  const rows = [];
  for (let i = 1; i <= 150; i++) {
    const spanning = i % 10 === 0;
    rows.push({ index: i, height: 26, cells: [{ col: 1,
      span: { rows: spanning ? 4 : 1, cols: 1 },
      text: spanning ? `SPANCELL ${i}` : `Row ${i}`,
      bold: false, align: 'left', borders: { t: true, r: true, b: true, l: true } }] });
  }

  const buf = await renderRecordPdf({ ...FIXTURE, grid: { columns: [{ index: 1, width: 420 }], rows } });
  const dir = mkdtempSync(join(tmpdir(), 'pdftsv-'));
  try {
    const file = join(dir, 'r.pdf');
    writeFileSync(file, buf);

    const tsv = execFileSync('pdftotext', ['-tsv', file, '-'], { encoding: 'utf8' });
    const lines = tsv.split('\n').filter(Boolean);
    const header = lines[0].split('\t');
    const pageHeights = new Map();
    let sawSpanCell = false;
    const overflowingWords = [];
    for (const line of lines.slice(1)) {
      const cols = line.split('\t');
      const row = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
      const page = Number(row.page_num);
      if (row.text === '###PAGE###') { pageHeights.set(page, Number(row.height)); continue; }
      if (row.level !== '5') continue; // word-level rows only
      if (row.text.includes('SPANCELL')) sawSpanCell = true;
      const bottom = Number(row.top) + Number(row.height);
      const pageHeight = pageHeights.get(page);
      const maxAllowed = pageHeight - 28 + 1; // PAGE_MARGIN, +1pt tolerance
      if (bottom > maxAllowed) overflowingWords.push({ page, text: row.text, bottom, maxAllowed });
    }
    assert.ok(sawSpanCell, 'the spanning cell\'s text should be present somewhere in the document');
    // ...and the document must genuinely have broken across pages, or none of
    // the above tested a page boundary at all.
    assert.ok(pageHeights.size > 1,
      `this fixture must force a page break to be worth anything; it produced ${pageHeights.size} page(s)`);
    assert.deepEqual(overflowingWords, [], 'no word should be drawn past the bottom margin on any page');

    // A4 height (841.89pt) minus PAGE_MARGIN (28pt), the same page geometry
    // server/pdf-record.js uses.
    const maxAllowedPathY = 841.89 - 28 + 1;
    const overflowingPaths = extractPathYCoordinates(buf).filter((y) => y > maxAllowedPathY);
    assert.deepEqual(overflowingPaths, [],
      `a border/line was drawn past the bottom margin (y > ${maxAllowedPathY}): ${overflowingPaths}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Rejection history on the archival record ----------------------------
//
// A rejection is part of what happened to the record. Clearing the
// signatures removes the (now false) claim that someone approved this
// content; it must not remove the fact that the record was sent back, by
// whom, when and why. Text invented for this test, as everywhere else here.
const REJECTIONS = [
  { stage: 'team_leader', full_name: 'Bea Reviewer', rejected_at: '2026-08-02T11:15:00Z',
    reason: 'Torque values were left blank on the third task and the interval looks wrong.' },
  { stage: 'engineer', full_name: 'Cal Engineer', rejected_at: '2026-08-03T08:05:00Z',
    reason: 'Grounding measurement is missing its unit.' }
];

test('a record with no rejections carries no rejection section', async () => {
  const buf = await renderRecordPdf({ ...FIXTURE, rejections: [] });
  assert.ok(!buf.toString('latin1').includes('REJECTION'), 'a clean record must not print an empty history block');
});

test('the rejection reason and the rejecter\'s name appear in the generated PDF',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const buf = await renderRecordPdf({ ...FIXTURE, rejections: REJECTIONS });
  const dir = mkdtempSync(join(tmpdir(), 'pdfrej-'));
  try {
    const file = join(dir, 'r.pdf');
    writeFileSync(file, buf);
    const normalized = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ').trim();
    for (const r of REJECTIONS) {
      assert.ok(normalized.includes(r.reason), `reason missing from the archived record: "${r.reason}"`);
      assert.ok(normalized.includes(r.full_name), `rejecter's name missing: "${r.full_name}"`);
    }
    assert.ok(/2026-08-02/.test(normalized), 'the rejection timestamp must be printed');
    assert.ok(/Team Leader/i.test(normalized) && /Engineer/i.test(normalized),
      'the stage each rejection came from must be printed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a record carrying rejection history still passes veraPDF as PDF/A-2U',
  { skip: hasVera ? false : 'veraPDF not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pdfa-rej-'));
  try {
    const file = join(dir, 'r.pdf');
    writeFileSync(file, await renderRecordPdf({ ...FIXTURE, rejections: REJECTIONS }));
    const out = execFileSync('verapdf', ['-f', '2u', '--format', 'text', file], { encoding: 'utf8' });
    assert.match(out, /PASS/, `veraPDF reported: ${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- The Parts Required table on the archived record -----------------------
// A parts snapshot the way scanner.js emits it: four fields per ruled row,
// keyed by the sheet row. Two rows here — the first used, the second left
// blank, which is the ordinary case on a maintenance visit.
const PARTS_SNAPSHOT = [
  ...FIXTURE.snapshot,
  { field_key: 'part_11_no', label: 'Part No', section: 'Parts required', kind: 'text' },
  { field_key: 'part_11_desc', label: 'Description', section: 'Parts required', kind: 'text' },
  { field_key: 'part_11_qty', label: 'Qty', section: 'Parts required', kind: 'text' },
  { field_key: 'part_11_remarks', label: 'Remarks', section: 'Parts required', kind: 'text' },
  { field_key: 'part_12_no', label: 'Part No', section: 'Parts required', kind: 'text' },
  { field_key: 'part_12_desc', label: 'Description', section: 'Parts required', kind: 'text' },
  { field_key: 'part_12_qty', label: 'Qty', section: 'Parts required', kind: 'text' },
  { field_key: 'part_12_remarks', label: 'Remarks', section: 'Parts required', kind: 'text' }
];
const PARTS_VALUES = [
  ...FIXTURE.values,
  { field_key: 'part_11_no', value: 'WX-4417-A' },
  { field_key: 'part_11_desc', value: 'Drive belt' },
  { field_key: 'part_11_qty', value: '2' },
  { field_key: 'part_11_remarks', value: 'Worn' }
];

test('values entered in the parts table appear in the generated record',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pdf-parts-'));
  try {
    const file = join(dir, 'r.pdf');
    writeFileSync(file, await renderRecordPdf({ ...FIXTURE, snapshot: PARTS_SNAPSHOT, values: PARTS_VALUES }));
    const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
    assert.match(text, /Parts required/i, 'the parts section is named on the record');
    assert.match(text, /WX-4417-A/, 'the part number is on the archived record');
    assert.match(text, /Drive belt/, 'the description is on the archived record');
    assert.match(text, /Qty: 2/, 'the quantity is on the archived record');
    assert.match(text, /Worn/, 'the parts remark is on the archived record');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a parts row nobody filled in prints nothing at all',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
  // Most visits replace no parts. Printing four empty labelled lines per
  // unused row would make every clean record look half-finished.
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pdf-parts-blank-'));
  try {
    const used = join(dir, 'used.pdf');
    writeFileSync(used, await renderRecordPdf({ ...FIXTURE, snapshot: PARTS_SNAPSHOT, values: PARTS_VALUES }));
    const usedText = execFileSync('pdftotext', [used, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
    // Exactly one "Part No:" line — row 11's. Row 12 is blank and prints none.
    assert.equal((usedText.match(/Part No:/g) ?? []).length, 1, 'only the used row prints');

    const none = join(dir, 'none.pdf');
    writeFileSync(none, await renderRecordPdf({ ...FIXTURE, snapshot: PARTS_SNAPSHOT, values: FIXTURE.values }));
    const noneText = execFileSync('pdftotext', [none, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
    assert.doesNotMatch(noneText, /Part No:/, 'a record with no parts prints no parts lines');
    assert.doesNotMatch(noneText, /Parts required/i, 'and no empty Parts required heading');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a record carrying parts values still passes veraPDF as PDF/A-2U',
  { skip: hasVera ? false : 'veraPDF not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pdfa-parts-'));
  try {
    const file = join(dir, 'r.pdf');
    writeFileSync(file, await renderRecordPdf({ ...FIXTURE, snapshot: PARTS_SNAPSHOT, values: PARTS_VALUES }));
    const out = execFileSync('verapdf', ['-f', '2u', '--format', 'text', file], { encoding: 'utf8' });
    assert.match(out, /PASS/, `veraPDF reported: ${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- The leftover appendix: only for a value the sheet has no cell for ------
//
// server/cell-map.js supplies `cellFor`, coordinate for coordinate, the same
// map the live preview uses. A value whose field IS in that map is already
// printed in its own box on the sheet (see entriesForSheet above) and must
// not be repeated below it. Only a value the map genuinely cannot place —
// because the field has no cell at all (this fixture's `note_1`, standing in
// for the real forms' Remarks, which no document prints a blank for), or
// because the document itself has no Status column for a task (F04/F09 on
// the real forms) — belongs in the leftover block.
//
// A tiny grid with ONE task row and its own Status cell, mapped by cellFor
// exactly as server/cell-map.js would map a real Status column.
const STATUS_GRID = {
  columns: [{ index: 1, width: 260 }, { index: 2, width: 40 }],
  rows: [{ index: 1, height: 15, cells: [
    { col: 1, span: { rows: 1, cols: 1 }, text: 'Check the widget', bold: false, align: 'left',
      borders: { t: true, r: true, b: true, l: true } },
    { col: 2, span: { rows: 1, cols: 1 }, text: '', bold: false, align: 'center',
      borders: { t: true, r: true, b: true, l: true } }
  ] }]
};
const STATUS_CELL_FOR = { task_1: { row: 1, col: 2 } };

test('a form WITH a status column, fully filled, produces no leftover appendix and stays one page',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pdf-noappendix-'));
  try {
    const file = join(dir, 'r.pdf');
    const buf = await renderRecordPdf({
      ...FIXTURE,
      // 'note_1' models a field with NO cell on this document (like Remarks
      // on the real forms) that nobody wrote anything in — the exact shape
      // that used to force an appendix onto every otherwise-complete record.
      snapshot: [
        { field_key: 'task_1', label: 'Check the widget', section: 'Tasks', kind: 'text' },
        { field_key: 'note_1', label: 'Remarks', section: 'Record', kind: 'text' }
      ],
      values: [{ field_key: 'task_1', value: 'OK' }],
      grid: STATUS_GRID,
      cellFor: STATUS_CELL_FOR,
      titleCell: null
    });
    writeFileSync(file, buf);
    const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
    assert.doesNotMatch(text, /RECORDED VALUES/i, 'the old blanket heading must be gone');
    assert.doesNotMatch(text, /Remarks:/, 'an untouched field with no cell must not print an empty appendix line');
    assert.equal((text.match(/\bOK\b/g) ?? []).length, 1, 'the task value should print exactly once, on the sheet');
    const pageMatch = /PAGE 1 \/ (\d+)/.exec(text);
    assert.ok(pageMatch, 'page indicator should be present');
    assert.equal(pageMatch[1], '1', `record should be one page, was ${pageMatch[1]}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a form WITHOUT a status column still records its task result somewhere in the PDF',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pdf-nostatus-'));
  try {
    const file = join(dir, 'r.pdf');
    const buf = await renderRecordPdf({
      ...FIXTURE,
      snapshot: [{ field_key: 'task_1', label: 'Check the widget', section: 'Tasks', kind: 'text' }],
      values: [{ field_key: 'task_1', value: 'PASS-NOSTATUS' }],
      grid: STATUS_GRID,
      // No status column on this document — cell-map.js reports no coordinate
      // for the task, exactly as it does for F04/F09 on the real forms.
      cellFor: {},
      titleCell: null
    });
    writeFileSync(file, buf);
    const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
    assert.match(text, /PASS-NOSTATUS/, 'a task result with nowhere on the sheet to go must still be recorded');
    assert.match(text, /Check the widget/, 'and labelled, so the recorded value is identifiable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a field with no cell mapping on any form is still recorded, heading says so honestly',
  { skip: hasPdftotext ? false : 'pdftotext not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pdf-unmapped-'));
  try {
    const file = join(dir, 'r.pdf');
    const buf = await renderRecordPdf({
      ...FIXTURE,
      snapshot: [
        { field_key: 'task_1', label: 'Check the widget', section: 'Tasks', kind: 'text' },
        { field_key: 'note_1', label: 'Remarks', section: 'Record', kind: 'text' }
      ],
      values: [{ field_key: 'task_1', value: 'OK' }, { field_key: 'note_1', value: 'Filter replaced early' }],
      grid: STATUS_GRID,
      cellFor: STATUS_CELL_FOR,
      titleCell: null
    });
    writeFileSync(file, buf);
    const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
    assert.match(text, /Filter replaced early/, 'the unmappable value must not be lost');
    assert.doesNotMatch(text, /RECORDED VALUES/i, 'the heading must not claim to be a complete list');
    assert.match(text, /no space on the form/i, 'the heading should say these are entries the form has no printed space for');
    assert.equal((text.match(/\bOK\b/g) ?? []).length, 1, 'the mapped task value must not also be repeated in the leftover block');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a leftover appendix does not break veraPDF PDF/A-2U conformance',
  { skip: hasVera ? false : 'veraPDF not installed' }, async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pdfa-leftover-'));
  try {
    const file = join(dir, 'r.pdf');
    const buf = await renderRecordPdf({
      ...FIXTURE,
      snapshot: [
        { field_key: 'task_1', label: 'Check the widget', section: 'Tasks', kind: 'text' },
        { field_key: 'note_1', label: 'Remarks', section: 'Record', kind: 'text' }
      ],
      values: [{ field_key: 'task_1', value: 'OK' }, { field_key: 'note_1', value: 'Filter replaced early' }],
      grid: STATUS_GRID,
      cellFor: STATUS_CELL_FOR,
      titleCell: null
    });
    writeFileSync(file, buf);
    const out = execFileSync('verapdf', ['-f', '2u', '--format', 'text', file], { encoding: 'utf8' });
    assert.match(out, /PASS/, `veraPDF reported: ${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The Calibration Record's Pass / Fail mark
// ---------------------------------------------------------------------------
// Every (x, y) a path operator names, so a mark drawn as vector strokes — a
// tick has no text at all — can be located. pdftotext cannot see it; nor can
// the y-only extractor above.
function extractPathPoints(pdfBuffer) {
  const text = pdfBuffer.toString('latin1');
  const objectRe = /\d+ 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  const points = [];
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
    for (const line of raw.toString('latin1').split('\n')) {
      const m = /^(-?\d+\.?\d*) (-?\d+\.?\d*) [ml]$/.exec(line.trim());
      if (m) points.push({ x: Number(m[1]), y: Number(m[2]) });
    }
  }
  return points;
}

// A sheet with one calibration row: a Reading box and the two ruled boxes the
// document prints for Pass and Fail. Invented content only.
const CAL_FIXTURE = (result) => ({
  ...FIXTURE,
  snapshot: [
    { field_key: 'cal_2_reading', label: 'Generic measurement A (0 - 1 unit)', section: 'Calibration record', kind: 'text' },
    { field_key: 'cal_2_result', label: 'Generic measurement A (0 - 1 unit)', section: 'Calibration record', kind: 'text', options: 'Pass\nFail' }
  ],
  values: [
    { field_key: 'cal_2_reading', value: '0.5' },
    ...(result ? [{ field_key: 'cal_2_result', value: result }] : [])
  ],
  cellFor: { cal_2_reading: { row: 2, col: 1 } },
  calibrationCells: { 2: { Pass: { row: 2, col: 2 }, Fail: { row: 2, col: 3 } } },
  grid: {
    columns: [{ index: 1, width: 90 }, { index: 2, width: 40 }, { index: 3, width: 40 }],
    rows: [
      { index: 1, height: 15, cells: [1, 2, 3].map((col) => ({
        col, span: { rows: 1, cols: 1 }, text: ['Reading', 'Pass', 'Fail'][col - 1],
        bold: true, align: 'center', borders: { t: true, r: true, b: true, l: true } })) },
      { index: 2, height: 18, cells: [1, 2, 3].map((col) => ({
        col, span: { rows: 1, cols: 1 }, text: '', align: 'center',
        borders: { t: true, r: true, b: true, l: true } })) }
    ]
  }
});

test('a Pass answer marks the Pass box, and a Fail answer marks the other one', async () => {
  const blank = extractPathPoints(await renderRecordPdf(CAL_FIXTURE(null)));
  const pass = extractPathPoints(await renderRecordPdf(CAL_FIXTURE('Pass')));
  const fail = extractPathPoints(await renderRecordPdf(CAL_FIXTURE('Fail')));

  // A tick is a three-point polyline: one moveto and two linetos.
  assert.equal(pass.length - blank.length, 3, 'a Pass answer draws exactly one tick');
  assert.equal(fail.length - blank.length, 3, 'a Fail answer draws exactly one tick');

  // And in DIFFERENT boxes. Pass is the left column of the two, so its mark
  // must be to the left of Fail's — the whole point of two printed boxes is
  // that a record shows which one was ticked.
  const added = (points) => {
    const seen = new Map();
    for (const p of blank) seen.set(`${p.x},${p.y}`, (seen.get(`${p.x},${p.y}`) ?? 0) + 1);
    return points.filter((p) => {
      const k = `${p.x},${p.y}`;
      if (seen.get(k)) { seen.set(k, seen.get(k) - 1); return false; }
      return true;
    });
  };
  const passMark = added(pass);
  const failMark = added(fail);
  assert.equal(passMark.length, 3);
  assert.equal(failMark.length, 3);
  assert.ok(Math.max(...passMark.map((p) => p.x)) < Math.min(...failMark.map((p) => p.x)),
    'the Pass mark sits entirely left of the Fail mark');
});

test('an unanswered measurement is marked nowhere, and an unknown answer is not guessed at', async () => {
  const blank = extractPathPoints(await renderRecordPdf(CAL_FIXTURE(null)));
  for (const answer of ['', 'Marginal', 'pass', 'N/A']) {
    const points = extractPathPoints(await renderRecordPdf(CAL_FIXTURE(answer)));
    assert.equal(points.length, blank.length, `"${answer}" marks nothing`);
  }
});

test('a Pass/Fail answer is not ALSO printed in the leftover appendix', async () => {
  // It is already on the sheet, as a tick in the box the document prints. A
  // record that showed it twice — once as a mark, once as the word "Pass" in
  // a list below — would read as two separate findings.
  const buf = await renderRecordPdf(CAL_FIXTURE('Pass'));
  const s = buf.toString('latin1');
  assert.ok(!/Not on the form/i.test(s), 'nothing was pushed into the leftover appendix');
});
