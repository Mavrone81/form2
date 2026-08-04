import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renderRecordPdf } from '../server/pdf-record.js';

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
