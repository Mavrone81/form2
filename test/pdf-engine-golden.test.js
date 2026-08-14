import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { renderRecordPdf } from '../server/pdf-record.js';

// The offline preview the Android app draws must not be a lookalike of the
// archived record — it must BE the record. The app renders with a browser
// bundle of this very renderer (mobile/pdf-engine), so the only honest test is
// to run both and compare the bytes: anything the bundle's shims get subtly
// wrong (a different deflate, a different font subset, a wider Buffer
// conversion) shows up here as a byte that moved, not as a preview somebody
// has to eyeball.
//
// The bundle is a build artefact and is gitignored, so a checkout without it
// skips — the same discipline test/helpers/fixtures.js uses for the sensitive
// form fixtures.
const BUNDLE = new URL('../mobile/pdf-engine/dist/pdf-engine.js', import.meta.url).pathname;
const SKIP = 'no pdf-engine bundle — run `npm install && node build.mjs` in mobile/pdf-engine';

// A 1x1 transparent PNG. Synthetic — no form content anywhere in this file.
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Deliberately exercises every branch that reaches a shim: three registered
// TTFs, the vendored ICC profile, a PNG (png-js + deflate), a leftover value
// that forces the appendix, a rejection block, and a frequency band whose
// checkboxes are measured against the fitted font.
const FIXTURE = {
  form: { file_name: 'sample.xlsx', title: 'Sample Record', doc_number: 'DOC 001', revision: 'A', file_type: 'xlsx' },
  submission: { id: 1, machine_id: 'AA01', frequency: '3M', state: 'approved', created_at: '2026-08-01T00:00:00Z' },
  notice: 'SOURCE FORM CHANGED SINCE THIS RECORD WAS SIGNED',
  snapshot: [
    { field_key: 'cal_2_reading', label: 'Generic measurement A (0 - 1 unit)', section: 'Calibration record', kind: 'text' },
    { field_key: 'cal_2_result', label: 'Generic measurement A (0 - 1 unit)', section: 'Calibration record', kind: 'text', options: 'Pass\nFail' },
    { field_key: 'note_1', label: 'Generic note', section: 'Notes', kind: 'text' }
  ],
  values: [
    { field_key: 'cal_2_reading', value: '0.5' },
    { field_key: 'cal_2_result', value: 'Pass' },
    { field_key: 'note_1', value: 'Generic remark the sheet prints no box for' }
  ],
  signatures: [
    { stage: 'technician', full_name: 'A Person', image_png: PNG_1x1, signed_at: '2026-08-02T09:00:00Z' },
    { stage: 'team_leader', full_name: 'B Person', image_png: null, signed_at: '2026-08-02T10:00:00Z' }
  ],
  rejections: [
    { stage: 'team_leader', full_name: 'B Person', rejected_at: '2026-08-01T12:00:00Z', reason: 'Generic correction request.' }
  ],
  cellFor: { cal_2_reading: { row: 2, col: 1 } },
  calibrationCells: { 2: { Pass: { row: 2, col: 2 }, Fail: { row: 2, col: 3 } } },
  intervalCells: {
    '1M': { row: 3, col: 1, start: 0, end: 12, text: 'Monthly (1M)', tickedBy: ['1M', '3M'] },
    '3M': { row: 3, col: 1, start: 14, end: 32, text: 'Three Monthly (3M)', tickedBy: ['3M'] }
  },
  grid: {
    defaults: { size: 10 },
    columns: [{ index: 1, width: 120 }, { index: 2, width: 40 }, { index: 3, width: 40 }],
    rows: [
      { index: 1, height: 15, cells: [1, 2, 3].map((col) => ({
        col, span: { rows: 1, cols: 1 }, text: ['Reading', 'Pass', 'Fail'][col - 1],
        bold: true, align: 'center', borders: { t: true, r: 'medium', b: true, l: true } })) },
      { index: 2, height: 18, cells: [1, 2, 3].map((col) => ({
        col, span: { rows: 1, cols: 1 }, text: '', align: 'center',
        borders: { t: true, r: true, b: true, l: true } })) },
      { index: 3, height: 15, cells: [
        { col: 1, span: { rows: 1, cols: 3 }, text: 'Monthly (1M)  Three Monthly (3M)', align: 'left',
          borders: { t: true, r: true, b: 'double', l: true } }] }
    ]
  }
};

// PDFKit derives the file ID from the info dictionary (md5 of Producer,
// Creator, Title, Author, Subject and CreationDate), and CreationDate comes
// from submission.created_at — so on this fixture both renderers already agree
// on it. It is still normalised away rather than trusted: the /ID is the ONE
// field PDFKit could ever make non-deterministic, and a golden test that would
// silently start comparing a random value is a test that stops meaning
// anything. Both IDs are md5, so both replacements are the same length and the
// comparison stays byte-for-byte over identical offsets.
const ID_RE = /\/ID \[<[0-9a-fA-F]+> <[0-9a-fA-F]+>\]/g;
function normalizeId(buffer) {
  const text = buffer.toString('latin1');
  const seen = text.match(ID_RE) ?? [];
  const normalized = text.replace(ID_RE, (m) => `/ID [<${'0'.repeat(32)}> <${'0'.repeat(32)}>]`);
  return { bytes: Buffer.from(normalized, 'latin1'), seen };
}

// Run the IIFE bundle exactly as a WebView would: no CommonJS, no Node
// builtins reachable from inside it (every one it needs was bundled as a
// shim), just a `window` to hang the export off.
function loadBundle() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const win = {};
  globalThis.window = win;
  try {
    runInThisContext(readFileSync(BUNDLE, 'utf8'), { filename: BUNDLE });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  }
  assert.equal(typeof win.renderRecordPdf, 'function', 'the bundle must expose window.renderRecordPdf');
  return win.renderRecordPdf;
}

test('the browser bundle renders the same bytes as the server renderer', { skip: existsSync(BUNDLE) ? false : SKIP }, async () => {
  const render = loadBundle();

  const fromServer = await renderRecordPdf(structuredClone(FIXTURE));
  // JSON is what actually crosses into the WebView, so that is what is fed in.
  const fromBundle = await render(JSON.stringify(FIXTURE));

  assert.ok(fromBundle instanceof Uint8Array, 'the bundle must resolve to a Uint8Array');
  const bundleBytes = Buffer.from(fromBundle);

  assert.ok(fromServer.length > 20000, 'sanity: the server rendered a real document');
  assert.equal(bundleBytes.length, fromServer.length,
    `byte counts differ: server ${fromServer.length}, bundle ${bundleBytes.length}`);

  const server = normalizeId(fromServer);
  const bundle = normalizeId(bundleBytes);
  assert.equal(server.seen.length, 1, 'the server document must carry exactly one /ID trailer array');
  assert.equal(bundle.seen.length, 1, 'the bundle document must carry exactly one /ID trailer array');

  if (!server.bytes.equals(bundle.bytes)) {
    let at = 0;
    while (at < server.bytes.length && server.bytes[at] === bundle.bytes[at]) at++;
    const window = (b) => JSON.stringify(b.toString('latin1', Math.max(0, at - 60), at + 60));
    assert.fail(`first difference at byte ${at}\n  server: ${window(server.bytes)}\n  bundle: ${window(bundle.bytes)}`);
  }
});

test('the bundle is deterministic across calls', { skip: existsSync(BUNDLE) ? false : SKIP }, async () => {
  const render = loadBundle();
  const first = Buffer.from(await render(JSON.stringify(FIXTURE)));
  const second = Buffer.from(await render(JSON.stringify(FIXTURE)));
  assert.ok(first.equals(second), 'two renders of one submission must produce identical bytes');
});
