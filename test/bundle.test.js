import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { seedDemoUsers } from '../server/seed.js';
import { scanFolder } from '../server/scanner.js';

// Same synthetic-workbook style as test/api.test.js: minimal content the
// parser accepts, invented and generic ("Widget check" style) — never real
// form text.
async function writeSyntheticWorkbook(path, tasksByFreq) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getRow(1).getCell(1).value = 'No';
  ws.getRow(1).getCell(2).value = 'Freq.';
  ws.getRow(1).getCell(3).value = 'Instruction';
  ws.getRow(1).getCell(4).value = 'Status';
  tasksByFreq.forEach(([freq, instruction], i) => {
    const row = ws.getRow(i + 2);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = freq;
    row.getCell(3).value = instruction;
  });
  await wb.xlsx.writeFile(path);
  return path;
}

async function boot() {
  const db = openDb(':memory:');
  seedDemoUsers(db, { silent: true });
  const app = createApp({ db });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, path, body, headers) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(headers ?? {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { db, server, call };
}

test('GET /api/bundle returns every ready xlsx form with fields, tasks, cellFor and grid, and omits a needs_setup form', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-bundle-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form-a.xlsx'), [
      ['1M', 'Widget check A'],
      ['3M', 'Widget check B']
    ]);
    await writeSyntheticWorkbook(join(dir, 'form-b.xlsx'), [
      ['Y', 'Widget check C']
    ]);
    const { db, server, call } = await boot();
    try {
      await scanFolder(db, dir);

      // A form with no worksheet at all is left needs_setup by the scanner
      // (see the pdf/blank-file fixtures elsewhere in the suite) — the
      // simplest way to get a genuine needs_setup row here is to insert one
      // directly, since scanFolder's own classification rules are exercised
      // elsewhere and are not what this test is about.
      db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
        values ('/nowhere/needs-setup.xlsx','needs-setup.xlsx','xlsx','needs_setup')`).run();

      await call('POST', '/api/login', { username: 'tech', password: 'tech' });
      const res = await call('GET', '/api/bundle');
      assert.equal(res.status, 200);
      assert.ok(res.body.generated_at, 'generated_at must be present');
      assert.equal(typeof res.body.generated_at, 'string');
      assert.ok(Array.isArray(res.body.forms));
      assert.ok(Array.isArray(res.body.skipped));
      assert.equal(res.body.skipped.length, 0);

      assert.equal(res.body.forms.length, 2, 'only the two ready xlsx forms belong in the bundle');
      const names = res.body.forms.map((f) => f.form.file_name).sort();
      assert.deepEqual(names, ['form-a.xlsx', 'form-b.xlsx']);
      assert.equal(res.body.forms.some((f) => f.form.file_name === 'needs-setup.xlsx'), false,
        'a needs_setup form must not appear in the bundle');

      const a = res.body.forms.find((f) => f.form.file_name === 'form-a.xlsx');
      assert.ok(a.fields.length > 0, 'fields must be present');
      assert.ok(a.fields.some((f) => f.field_key === 'task_2'));
      assert.ok(a.tasks.length > 0, 'tasks must be present');
      assert.deepEqual(a.cellFor.task_2, { row: 2, col: 4 });
      assert.ok(a.grid, 'grid must be present');
      assert.ok(Array.isArray(a.grid.columns), 'grid.columns must be present');
      assert.ok(Array.isArray(a.grid.rows), 'grid.rows must be present');
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- what the form row may and may not carry to a device (M1) ---

test('the bundled form row carries no server-internal columns (no file_path, no parse_error) but keeps its identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-bundle-privacy-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form-e.xlsx'), [['Y', 'Widget check A']]);
    const { db, server, call } = await boot();
    try {
      await scanFolder(db, dir);
      // A parse_error left on a ready row (the scanner clears it, so this is
      // planted deliberately) proves the column is stripped by the route, not
      // merely absent by luck of the fixture.
      db.prepare("update form_catalog set parse_error='internal detail from /some/server/path' where file_name='form-e.xlsx'").run();

      await call('POST', '/api/login', { username: 'tech', password: 'tech' });
      const res = await call('GET', '/api/bundle');
      assert.equal(res.status, 200);
      const bundled = res.body.forms.find((f) => f.form.file_name === 'form-e.xlsx');
      assert.ok(bundled, 'the form must appear in the bundle');

      assert.equal('file_path' in bundled.form, false,
        'the server\'s absolute path to the controlled document must never reach a device');
      assert.equal('parse_error' in bundled.form, false,
        'an internal scanner diagnostic must never reach a device');
      // Nothing else may have been stripped along with them: the whole
      // payload is useless to the app without these.
      assert.ok(bundled.form.id);
      assert.equal(bundled.form.file_name, 'form-e.xlsx');
      assert.ok('content_hash' in bundled.form, 'content_hash is document identity and must survive');
      assert.ok('title' in bundled.form && 'doc_number' in bundled.form && 'revision' in bundled.form);
      assert.equal(bundled.form.state, 'ready');

      // Belt and braces: the path must not have leaked anywhere else in the
      // payload either (grid, cellFor, skipped, ...).
      const raw = JSON.stringify(res.body);
      assert.equal(raw.includes(dir), false, 'no filesystem path may appear anywhere in the bundle payload');
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a field\'s options column (allowed answers) is carried through into the bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-bundle-opts-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form-c.xlsx'), [['Y', 'Widget check A']]);
    const { db, server, call } = await boot();
    try {
      await scanFolder(db, dir);
      const form = db.prepare("select * from form_catalog where file_name='form-c.xlsx'").get();
      // A calibration-style result field, the one shape in this codebase
      // that carries options — inserted directly, same technique
      // test/api.test.js uses, rather than depending on the parser
      // recognising a full calibration table in a synthetic workbook.
      db.prepare(`insert into form_fields (form_id, field_key, label, section, kind, sort_order, source, options)
        values (?,'cal_1_result','Generic measurement A','Calibration record','text',99,'parsed','Pass\nFail')`)
        .run(form.id);

      await call('POST', '/api/login', { username: 'tech', password: 'tech' });
      const res = await call('GET', '/api/bundle');
      assert.equal(res.status, 200);
      const bundled = res.body.forms.find((f) => f.form.file_name === 'form-c.xlsx');
      assert.ok(bundled, 'the form must parse and appear in the bundle');
      const field = bundled.fields.find((f) => f.field_key === 'cal_1_result');
      assert.ok(field, 'the options-bearing field must be present');
      assert.equal(field.options, 'Pass\nFail');
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/bundle is refused without authentication', async () => {
  const { server, call } = await boot();
  try {
    const res = await call('GET', '/api/bundle');
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('GET /api/bundle is reachable with a Bearer device token, no session cookie', async () => {
  const { server, call } = await boot();
  try {
    const login = await call('POST', '/api/login', { username: 'tech', password: 'tech', wantDeviceToken: true });
    assert.equal(login.status, 200);
    const token = login.body.device_token;
    assert.match(token, /^[0-9a-f]{64}$/);

    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/bundle`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.forms));
  } finally {
    server.close();
  }
});

test('a form whose file fails to parse is skipped, not a 500 for the whole bundle', async () => {
  const { db, server, call } = await boot();
  try {
    db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
      values ('/nonexistent/gone.xlsx','gone.xlsx','xlsx','ready')`).run();
    const { id } = db.prepare("select id from form_catalog where file_name='gone.xlsx'").get();

    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    const res = await call('GET', '/api/bundle');
    assert.equal(res.status, 200);
    assert.equal(res.body.forms.length, 0);
    assert.equal(res.body.skipped.length, 1);
    assert.equal(res.body.skipped[0].id, id);
    assert.ok(res.body.skipped[0].error);

    // The whole point: the process must have survived. Prove it with one
    // more ordinary request on the same server.
    const me = await call('GET', '/api/me');
    assert.equal(me.status, 200);
  } finally {
    server.close();
  }
});

// --- One parse per form, not two -------------------------------------------
//
// Bundling a form used to call parseWorkbook TWICE: once inside formSpec (for
// tasks/frequencies/cellFor) and once more, redundantly, right before
// buildGrid -- two full reads and XLSX parses of the same file per form, in
// the one endpoint whose whole point is a single bulk sync call. It also left
// a window where the two parses of the same file could observe different
// content if a rescan/write raced mid-request.
//
// ExcelJS's workbook.xlsx.readFile ultimately opens the file via
// fs.createReadStream (node_modules/exceljs/lib/xlsx/xlsx.js) -- both
// parseWorkbook (server/excel-parser.js) and buildGrid's own internal,
// SEPARATE workbook read (server/grid-model.js: buildGrid always does its own
// `new ExcelJS.Workbook(); await wb.xlsx.readFile(path)`, regardless of
// whether a `definition` is passed -- that second argument only supplies
// taskRows, never a parsed workbook to reuse) go through it, so counting
// calls against this one form's path is a reliable proxy for how many times
// its file was opened during one bundle request.
test('bundling a form opens its file exactly twice: formSpec\'s one parseWorkbook call, plus buildGrid\'s own separate read -- never a redundant extra parse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmforms-bundle-singleparse-'));
  try {
    await writeSyntheticWorkbook(join(dir, 'form-d.xlsx'), [['Y', 'Widget check A']]);
    const { db, server, call } = await boot();
    try {
      await scanFolder(db, dir);
      const form = db.prepare("select * from form_catalog where file_name='form-d.xlsx'").get();
      const target = form.file_path;

      const orig = fs.createReadStream;
      let opens = 0;
      fs.createReadStream = function (...args) {
        if (args[0] === target) opens++;
        return orig.apply(this, args);
      };

      let res;
      try {
        await call('POST', '/api/login', { username: 'tech', password: 'tech' });
        res = await call('GET', '/api/bundle');
      } finally {
        fs.createReadStream = orig;
      }

      assert.equal(res.status, 200);
      assert.ok(res.body.forms.some((f) => f.form.file_name === 'form-d.xlsx'), 'the form must have parsed');
      // 2, not 3: formSpec's single parseWorkbook call, plus buildGrid's own
      // structurally-separate read of the same path (also present,
      // unchanged, in the pre-existing GET /forms/:id/grid route). A third
      // open here would mean the bundle route went back to calling
      // parseWorkbook a second time on top of formSpec's.
      assert.equal(opens, 2,
        'expected exactly two opens of the form file: formSpec\'s parseWorkbook and buildGrid\'s own read -- a redundant extra parseWorkbook call would make this 3');
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
