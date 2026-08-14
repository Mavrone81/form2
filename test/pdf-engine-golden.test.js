import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { inflateSync, deflateSync } from 'node:zlib';
import { renderRecordPdf } from '../server/pdf-record.js';

// The offline preview the Android app draws must not be a lookalike of the
// archived record — it must BE the record. The app renders with a browser
// bundle of this very renderer (mobile/pdf-engine), so the only honest test is
// to run both and compare what they produced: anything the bundle's shims get
// subtly wrong (a different font subset, a wider Buffer conversion, a decode
// that fires in a different order) shows up here as content that moved, not as
// a preview somebody has to eyeball.
//
// WHAT "THE SAME" MEANS, precisely. When both renders run over the same
// deflate implementation the files are byte-identical and that is asserted
// directly — the strictest possible check, and the one that holds on any one
// machine. Across environments it CANNOT hold: the server compresses its
// streams with Node's bundled zlib, which changes output between Node patch
// releases (v22.23.1 and v22.23.2 compress the same bytes differently), while
// the bundle carries its own fixed pako. The bytes INSIDE the streams — every
// drawing operator, every glyph, every tick — are what make the document the
// record, and those must be identical everywhere. So: byte-equality as the
// fast path, and when the containers differ, object-by-object equality of the
// DECOMPRESSED content, with the comparator itself proven below by a
// recompressed copy (must pass) and a tampered stream (must fail).
//
// The bundle is a build artefact and is gitignored, so a checkout without it
// skips — the same discipline test/helpers/fixtures.js uses for the sensitive
// form fixtures.
// fileURLToPath, not `.pathname`: a URL percent-encodes, so under a checkout
// whose path contains a space (or any other reserved character) `.pathname`
// yields a path existsSync cannot find — and the guard below would then report
// the bundle missing while it sits there built, telling the developer to build
// what they already built.
const BUNDLE = fileURLToPath(new URL('../mobile/pdf-engine/dist/pdf-engine.js', import.meta.url));
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

// ---------------------------------------------------------------------------
// Content comparison: the document, independent of its deflate container
// ---------------------------------------------------------------------------
// A PDF body is a sequence of `N 0 obj … endobj` objects; everything after the
// body (xref table, trailer, startxref) is byte offsets and bookkeeping that
// legitimately shift when a stream compresses to a different size. Each object
// is either a dictionary alone or a dictionary plus a stream. The dictionary
// is compared with its /Length normalised (it counts COMPRESSED bytes); a
// /FlateDecode stream is compared by its inflated bytes; any other stream by
// its raw bytes. Object numbers must match position for position — both sides
// run the same code, so a reordered object is itself a difference worth
// failing on.
const OBJ_RE = /(\d+) 0 obj\b([\s\S]*?)endobj/g;

function parseObjects(buffer) {
  const text = buffer.toString('latin1');
  const objects = [];
  for (const m of text.matchAll(OBJ_RE)) {
    const [, num, body] = m;
    const streamAt = body.search(/stream\r?\n/);
    if (streamAt === -1) {
      objects.push({ num: Number(num), dict: body.trim(), stream: null });
      continue;
    }
    const dict = body.slice(0, streamAt).trim();
    const payloadStart = streamAt + /stream\r?\n/.exec(body.slice(streamAt))[0].length;
    const endAt = body.lastIndexOf('endstream');
    // The spec puts an EOL before `endstream`; strip exactly one if present.
    let payload = body.slice(payloadStart, endAt).replace(/\r?\n$/, '');
    objects.push({ num: Number(num), dict, stream: Buffer.from(payload, 'latin1') });
  }
  return objects;
}

const normalizeDict = (dict) => dict
  .replace(/\/Length \d+/g, '/Length 0')
  .replace(ID_RE, '/ID [<0> <0>]');

// Streams whose dictionaries declare /FlateDecode are compared inflated;
// everything else raw. Returns null when equal, else a one-line description.
function compareObjects(a, b) {
  if (a.length !== b.length) return `object counts differ: ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.num !== y.num) return `object ${i} numbered ${x.num} vs ${y.num}`;
    if (normalizeDict(x.dict) !== normalizeDict(y.dict)) return `object ${x.num}: dictionaries differ`;
    if (!!x.stream !== !!y.stream) return `object ${x.num}: stream present on one side only`;
    if (!x.stream) continue;
    const flate = /\/FlateDecode/.test(x.dict);
    let xs = x.stream, ys = y.stream;
    if (flate) {
      try { xs = inflateSync(x.stream); ys = inflateSync(y.stream); }
      catch (err) { return `object ${x.num}: stream failed to inflate (${err.message})`; }
    }
    if (!xs.equals(ys)) {
      let at = 0;
      while (at < xs.length && xs[at] === ys[at]) at++;
      return `object ${x.num}: ${flate ? 'inflated ' : ''}stream differs at byte ${at} ` +
        `(lengths ${xs.length} vs ${ys.length})`;
    }
  }
  return null;
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

test('the browser bundle renders the same document as the server renderer', { skip: existsSync(BUNDLE) ? false : SKIP }, async () => {
  const render = loadBundle();

  const fromServer = await renderRecordPdf(structuredClone(FIXTURE));
  // JSON is what actually crosses into the WebView, so that is what is fed in.
  const fromBundle = await render(JSON.stringify(FIXTURE));

  assert.ok(fromBundle instanceof Uint8Array, 'the bundle must resolve to a Uint8Array');
  const bundleBytes = Buffer.from(fromBundle);

  assert.ok(fromServer.length > 20000, 'sanity: the server rendered a real document');

  const server = normalizeId(fromServer);
  const bundle = normalizeId(bundleBytes);
  assert.equal(server.seen.length, 1, 'the server document must carry exactly one /ID trailer array');
  assert.equal(bundle.seen.length, 1, 'the bundle document must carry exactly one /ID trailer array');

  // Fast path: same deflate implementation → the files are identical outright.
  if (server.bytes.equals(bundle.bytes)) return;

  // Containers differ (a zlib version gap between Node's and the bundle's
  // pako). The DOCUMENT must still be identical: same objects, same
  // dictionaries, same decompressed stream bytes.
  const verdict = compareObjects(parseObjects(server.bytes), parseObjects(bundle.bytes));
  assert.equal(verdict, null, `documents differ beyond their deflate containers — ${verdict}`);
});

// The content comparator is itself load-bearing now, so it is proven both
// ways against the real render: a copy whose streams are RECOMPRESSED (what a
// zlib version gap actually does) must compare equal, and a copy with one
// byte of CONTENT changed inside a stream must not.
test('the content comparator tolerates recompression and catches tampering', { skip: existsSync(BUNDLE) ? false : SKIP }, async () => {
  const fromServer = await renderRecordPdf(structuredClone(FIXTURE));
  const original = parseObjects(normalizeId(fromServer).bytes);

  const rebuild = (mutate) => original.map((o) => {
    if (!o.stream || !/\/FlateDecode/.test(o.dict)) return o;
    let inflated = inflateSync(o.stream);
    if (mutate) inflated = mutate(inflated);
    // level 1 vs PDFKit's default: guaranteed different container bytes.
    return { ...o, stream: deflateSync(inflated, { level: 1 }) };
  });

  const recompressed = rebuild(null);
  assert.equal(compareObjects(original, recompressed), null,
    'recompressed streams carry the same content and must compare equal');

  let mutated = false;
  const tampered = rebuild((inflated) => {
    if (mutated || inflated.length < 10) return inflated;
    const copy = Buffer.from(inflated);
    copy[5] ^= 0xff;
    mutated = true;
    return copy;
  });
  assert.ok(mutated, 'sanity: the tamper actually landed on a stream');
  const verdict = compareObjects(original, tampered);
  assert.match(String(verdict), /stream differs/,
    'a changed byte inside a stream must be reported, not absorbed');
});

test('the bundle is deterministic across calls', { skip: existsSync(BUNDLE) ? false : SKIP }, async () => {
  const render = loadBundle();
  const first = Buffer.from(await render(JSON.stringify(FIXTURE)));
  const second = Buffer.from(await render(JSON.stringify(FIXTURE)));
  assert.ok(first.equals(second), 'two renders of one submission must produce identical bytes');
});

// The same 1x1 PNG, structurally intact — signature, IHDR, IDAT and IEND all
// where a decoder expects them — but with the IDAT's deflate payload replaced
// by a valid zlib header over garbage. png-js gets far enough to start
// inflating and then fails, which is the failure that happens a TURN LATE:
// PDFKit is decoding the image from inside a callback by then, so the throw
// has no caller, the document's stream never ends, and the render's promise
// used to sit pending for ever. In the app that is a preview spinner that
// never stops — the technician is told nothing at all, which is worse than
// being told the record could not be drawn.
const PNG_CORRUPT_IDAT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' +
  'CAYAAAAfFcSJAAAADUlEQVR4nP//////////////hKmMIQAAAABJRU5ErkJggg==';

test('a render that cannot finish rejects rather than hanging', { skip: existsSync(BUNDLE) ? false : SKIP }, async () => {
  const render = loadBundle();
  const record = {
    ...FIXTURE,
    signatures: [{ stage: 'technician', full_name: 'A Person', image_png: PNG_CORRUPT_IDAT, signed_at: '2026-08-02T09:00:00Z' }]
  };

  // The whole point is that the promise SETTLES, so a hang has to fail the
  // test rather than hang the suite. Note this is asserted for the bundle
  // only: the server's own behaviour on this input is a separate matter, and
  // rendering it here would take the test process with it.
  // Not unref'd: the timer must actually fire and name the failure, rather
  // than letting the event loop drain and leaving the runner to report a
  // pending promise. It is always cleared below, so it cannot hold the suite
  // open on a passing run.
  let timer;
  const hung = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HUNG')), 3000); });

  await assert.rejects(
    Promise.race([render(JSON.stringify(record)), hung]).finally(() => clearTimeout(timer)),
    (err) => {
      assert.notEqual(err.message, 'HUNG',
        'the bundle never settled — a deferred image-decode failure must reject, not hang');
      return true;
    }
  );

  // And the failure is not contagious: the next record still renders.
  const good = Buffer.from(await render(JSON.stringify(FIXTURE)));
  assert.ok(good.length > 20000, 'a later render must still succeed');
});
