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

  // Matches server/pdf-record.js constants: PAGE_MARGIN=28, HEADER_HEIGHT=46,
  // GRID_ROW_SCALE=0.62 -> a 26-unit row becomes a 16pt row. 44 filler rows
  // land the next row at y=778 on an A4 page (841.89pt tall): a single 16pt
  // row would still fit (778+16=794 < 813.89), but a 4-row span (778+64=842)
  // would not — exactly the gap the old code missed.
  const rows = [];
  for (let i = 1; i <= 44; i++) {
    rows.push({ index: i, height: 26, cells: [{ col: 1, span: { rows: 1, cols: 1 }, text: `Row ${i}`,
      bold: false, align: 'left', borders: { t: true, r: true, b: true, l: true } }] });
  }
  rows.push({ index: 45, height: 26, cells: [{ col: 1, span: { rows: 4, cols: 1 }, text: 'SPANCELL near boundary',
    bold: false, align: 'left', borders: { t: true, r: true, b: true, l: true } }] });

  const buf = await renderRecordPdf({ ...FIXTURE, grid: { columns: [{ index: 1, width: 60 }], rows } });
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
