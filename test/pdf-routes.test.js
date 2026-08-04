import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { seedDemoUsers } from '../server/seed.js';
import { scanFolder } from '../server/scanner.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

// A minimal synthetic workbook the parser accepts — invented/generic content,
// never real form text, mirroring test/api.test.js's own fixture builder.
async function writeSyntheticWorkbook(path) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getRow(1).getCell(1).value = 'No';
  ws.getRow(1).getCell(2).value = 'Freq.';
  ws.getRow(1).getCell(3).value = 'Instruction';
  ws.getRow(1).getCell(4).value = 'Status';
  ws.getRow(2).getCell(1).value = 1;
  ws.getRow(2).getCell(2).value = 'Y';
  ws.getRow(2).getCell(3).value = 'Widget check A';
  await wb.xlsx.writeFile(path);
  return path;
}

async function boot(dir) {
  const db = openDb(':memory:');
  seedDemoUsers(db, { silent: true });
  await scanFolder(db, dir);
  const form = db.prepare("select * from form_catalog where file_name='form.xlsx'").get();
  const app = createApp({ db });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    // A PDF response is binary — never call .json() on it. Only the JSON
    // error/success responses in this suite are parsed that way; anything
    // else is read as a raw buffer so the leading %PDF bytes and the
    // content-disposition header can both be asserted on directly.
    const contentType = res.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    return {
      status: res.status,
      headers: res.headers,
      body: isJson ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer())
    };
  };
  return { db, server, call, form };
}

async function login(call, username, password) {
  const res = await call('POST', '/api/login', { username, password });
  assert.equal(res.status, 200, `login as ${username} should succeed`);
}

test('a team leader cannot preview before signing, and can after', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-pdf-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form.xlsx'));
    const { server, call, form } = await boot(dir);

    await login(call, 'tech', 'tech');
    const sub = (await call('POST', '/api/submissions', { formId: form.id, machineId: 'ED04', frequency: 'Y' })).body;
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG }); // draft -> pending_lead

    await login(call, 'lead', 'lead');
    const before = await call('GET', `/api/submissions/${sub.id}/pdf`);
    assert.equal(before.status, 403);

    const signed = await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG }); // pending_lead -> pending_engineer
    assert.equal(signed.status, 200);

    const after = await call('GET', `/api/submissions/${sub.id}/pdf`);
    assert.equal(after.status, 200);
    assert.equal(after.headers.get('content-disposition')?.includes('inline'), true);
    assert.equal(after.body.subarray(0, 4).toString('latin1'), '%PDF');

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a technician is refused the pdf in every state, including approved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-pdf-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form.xlsx'));
    const { server, call, form } = await boot(dir);

    await login(call, 'tech', 'tech');
    const sub = (await call('POST', '/api/submissions', { formId: form.id, machineId: 'ED04', frequency: 'Y' })).body;

    // draft — before anyone has signed
    assert.equal((await call('GET', `/api/submissions/${sub.id}/pdf`)).status, 403);

    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG }); // -> pending_lead
    // Still the technician's own session — pending_lead now, but a
    // technician is refused regardless of the record's state.
    assert.equal((await call('GET', `/api/submissions/${sub.id}/pdf`)).status, 403);

    await login(call, 'lead', 'lead');
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG }); // -> pending_engineer
    await login(call, 'eng', 'eng');
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG }); // -> approved

    await login(call, 'tech', 'tech');
    const approved = await call('GET', `/api/submissions/${sub.id}/pdf`);
    assert.equal(approved.status, 403, 'a technician is never granted the PDF, even once the record is approved');

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an engineer who has signed can download, with an attachment disposition and a sanitised filename', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-pdf-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form.xlsx'));
    const { server, call, form } = await boot(dir);

    const rawMachineId = 'ED-04/A #1 spare';
    await login(call, 'tech', 'tech');
    const sub = (await call('POST', '/api/submissions', { formId: form.id, machineId: rawMachineId, frequency: 'Y' })).body;
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });

    await login(call, 'lead', 'lead');
    await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });

    await login(call, 'eng', 'eng');
    // Before the engineer signs: still refused, same as every other role.
    assert.equal((await call('GET', `/api/submissions/${sub.id}/pdf`)).status, 403);

    const advanced = await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: PNG });
    assert.equal(advanced.status, 200);
    assert.equal(advanced.body.state, 'approved');

    const preview = await call('GET', `/api/submissions/${sub.id}/pdf`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-disposition')?.includes('inline'), true);

    const download = await call('GET', `/api/submissions/${sub.id}/pdf?download=1`);
    assert.equal(download.status, 200);
    const disposition = download.headers.get('content-disposition') ?? '';
    assert.ok(disposition.includes('attachment'), `expected an attachment disposition, got "${disposition}"`);
    // Only alphanumerics, dash, dot and underscore may survive a spreadsheet
    // machine id on its way into a response header — this is what stops a
    // crafted machine id from injecting header content.
    const expectedName = rawMachineId.replace(/[^A-Za-z0-9._-]/g, '') + '.pdf';
    assert.ok(disposition.includes(expectedName), `expected filename "${expectedName}" in "${disposition}"`);
    assert.equal(download.body.subarray(0, 4).toString('latin1'), '%PDF');

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown submission returns 404, not a stack trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-pdf-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form.xlsx'));
    const { server, call } = await boot(dir);

    await login(call, 'admin', 'admin');
    const res = await call('GET', '/api/submissions/999999/pdf');
    assert.equal(res.status, 404);
    const raw = JSON.stringify(res.body);
    assert.ok(!/\bat\s+\S+\s*\(/.test(raw), 'response must not contain stack-trace frames');
    assert.ok(!raw.includes(process.cwd()), 'response must not contain an absolute filesystem path');
    assert.ok(!raw.includes('/'), 'response must not contain any path-like fragment');

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an admin can preview a record even before anyone has signed it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-pdf-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form.xlsx'));
    const { server, call, form } = await boot(dir);

    await login(call, 'tech', 'tech');
    const sub = (await call('POST', '/api/submissions', { formId: form.id, machineId: 'ED04', frequency: 'Y' })).body;

    await login(call, 'admin', 'admin');
    const res = await call('GET', `/api/submissions/${sub.id}/pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.body.subarray(0, 4).toString('latin1'), '%PDF');

    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
