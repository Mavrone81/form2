# PM Form Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web app that indexes preventive maintenance forms from an admin-configured folder and runs a technician → team leader → engineer sign-off workflow, with the form rendered on the left and its fields on the right.

**Architecture:** A Node/Express server reads form files from a folder the admin configures, parses `.xlsx` into a form definition and a render grid, and stores catalog, users, submissions and signatures in SQLite. The browser gets a JSON API and a no-build vanilla-JS frontend. Business rules that affect compliance — cumulative interval scope, stage transitions — live on the server, never in the UI.

**Tech Stack:** Node 22, Express 4, better-sqlite3, ExcelJS, `node:test`, vanilla JS/CSS (no build step).

## Global Constraints

- Node >= 20. Declare `"engines": {"node": ">=20"}` and `"type": "module"` in `package.json`.
- Exactly four runtime dependencies: `express`, `express-session`, `better-sqlite3`, `exceljs`. Do not add others. PDFs are rendered by the browser; no PDF library.
- Tests use the built-in `node:test` runner and `node:assert/strict`. No test framework dependency.
- Source form files are **read-only**. Never write to, move, or rename anything in the forms folder.
- Never commit form files or anything derived from their content. `.gitignore` already covers `*.xlsx`, `*.xls`, `*.pdf`, `Sample of Forms/`, `docs/design/`.
- Interval order is `1M < 3M < 6M < Y` and scope is **cumulative**: selecting an interval includes every shorter one.
- Sheets are addressed **by index, never by name**.
- The task table terminates on a blank **Instruction** cell, never on a blank `No`.
- Contrast: instruction and frequency text is never faded or greyed. Every form control declares its own `color`, and light panels declare `color-scheme: light`.
- Passwords are hashed with `node:crypto` `scrypt`. Never store or log a plaintext password.
- Signature timestamps come from the server clock, never the client.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore` (already exists — verify only)
- Create: `test/smoke.test.js`

**Interfaces:**
- Produces: `npm test` runs the `node:test` runner over `test/`.

- [ ] **Step 1: Write the failing test**

`test/smoke.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package declares ESM and a node engine floor', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.engines.node.startsWith('>=2'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — no `package.json` / cannot find module.

- [ ] **Step 3: Create package.json**

```json
{
  "name": "pm-forms",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server/index.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "better-sqlite3": "^11.5.0",
    "exceljs": "^4.4.0",
    "express": "^4.21.1",
    "express-session": "^1.18.1"
  }
}
```

- [ ] **Step 4: Install and run tests**

Run: `npm install && npm test`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json test/smoke.test.js
git commit -m "Scaffold project with node:test runner"
```

---

### Task 2: Cumulative interval scope

The compliance rule, isolated as pure logic so it can be tested without a database, a file, or a browser. Everything else depends on it.

**Files:**
- Create: `server/intervals.js`
- Create: `test/intervals.test.js`

**Interfaces:**
- Produces:
  - `ORDER` — `['1M','3M','6M','Y']`
  - `covers(selected, taskFreq) -> boolean`
  - `tasksInScope(tasks, selected) -> Task[]` where `Task` is `{ no, freq, instruction, row }`
  - `scopeSummary(tasks, selected) -> { total, byFreq: {freq: count} }`

- [ ] **Step 1: Write the failing test**

`test/intervals.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { covers, tasksInScope, scopeSummary, ORDER } from '../server/intervals.js';

const T = (no, freq) => ({ no, freq, instruction: `task ${no}`, row: no + 10 });
// Shape of sample form F01: 14 x 3M, 3 x 6M, 1 x Y.
const F01 = [...Array(14)].map((_, i) => T(i + 1, '3M'))
  .concat([T(15, '6M'), T(16, '6M'), T(17, '6M'), T(18, 'Y')]);

test('order runs shortest to longest', () => {
  assert.deepEqual(ORDER, ['1M', '3M', '6M', 'Y']);
});

test('an interval covers itself and every shorter one', () => {
  assert.equal(covers('Y', '3M'), true);
  assert.equal(covers('Y', 'Y'), true);
  assert.equal(covers('6M', '3M'), true);
  assert.equal(covers('3M', '6M'), false);
  assert.equal(covers('1M', '3M'), false);
});

test('a yearly service pulls in the 3M and 6M work', () => {
  // The regression this whole module exists to prevent: a plain filter
  // would return 1 task and drop 17 required checks off a signed record.
  assert.equal(tasksInScope(F01, 'Y').length, 18);
  assert.equal(tasksInScope(F01, '6M').length, 17);
  assert.equal(tasksInScope(F01, '3M').length, 14);
  assert.equal(tasksInScope(F01, '1M').length, 0);
});

test('scope summary breaks the total down by frequency', () => {
  assert.deepEqual(scopeSummary(F01, '6M'), {
    total: 17, byFreq: { '3M': 14, '6M': 3 }
  });
});

test('unknown frequency values are excluded rather than throwing', () => {
  assert.equal(tasksInScope([T(1, 'WEEKLY')], 'Y').length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/intervals.test.js`
Expected: FAIL — cannot find module `../server/intervals.js`.

- [ ] **Step 3: Write the implementation**

`server/intervals.js`:
```js
// Interval scope is cumulative. Several forms state in their remarks that a
// yearly service requires the 3M and 6M work to be done at the same time, so
// selecting an interval brings every shorter interval into scope with it.
export const ORDER = ['1M', '3M', '6M', 'Y'];

export function covers(selected, taskFreq) {
  const s = ORDER.indexOf(selected);
  const t = ORDER.indexOf(taskFreq);
  if (s === -1 || t === -1) return false;
  return t <= s;
}

export function tasksInScope(tasks, selected) {
  return tasks.filter((t) => covers(selected, t.freq));
}

export function scopeSummary(tasks, selected) {
  const inScope = tasksInScope(tasks, selected);
  const byFreq = {};
  for (const t of inScope) byFreq[t.freq] = (byFreq[t.freq] ?? 0) + 1;
  return { total: inScope.length, byFreq };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/intervals.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/intervals.js test/intervals.test.js
git commit -m "Add cumulative interval scope"
```

---

### Task 3: Test fixtures for the real forms

Tests need the real files, but the files are sensitive and absent on any other machine. This task builds a git-ignored fixture map and a skip helper, so the suite runs everywhere and is thorough where the forms exist.

**Files:**
- Create: `scripts/build-fixtures.js`
- Create: `test/helpers/fixtures.js`
- Modify: `.gitignore` (add `test/fixtures.local.json`)

**Interfaces:**
- Consumes: nothing.
- Produces: `loadFixtures() -> { formsDir, forms: [{id, file, tasks, statusCol, freqs}] } | null` — returns `null` when the fixture file is absent.

- [ ] **Step 1: Write the failing test**

`test/helpers/fixtures.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures } from './fixtures.js';

test('returns null when no local fixture file is present', () => {
  const f = loadFixtures('/nonexistent/fixtures.json');
  assert.equal(f, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/helpers/fixtures.test.js`
Expected: FAIL — cannot find module `./fixtures.js`.

- [ ] **Step 3: Write the helper**

`test/helpers/fixtures.js`:
```js
import { readFileSync, existsSync } from 'node:fs';

const DEFAULT = new URL('../fixtures.local.json', import.meta.url).pathname;

// The real forms are sensitive and are not in the repo. Tests that need them
// call this and skip when it returns null, so the suite still runs elsewhere.
export function loadFixtures(path = DEFAULT) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const SKIP = 'no local form fixtures — run scripts/build-fixtures.js';
```

- [ ] **Step 4: Write the fixture builder**

`scripts/build-fixtures.js`:
```js
// Generates test/fixtures.local.json from a forms folder.
// Usage: node scripts/build-fixtures.js "/path/to/Sample of Forms"
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkbook } from '../server/excel-parser.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/build-fixtures.js <forms-folder>');
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$')).sort();
const forms = [];
for (const [i, file] of files.entries()) {
  const def = await parseWorkbook(join(dir, file));
  forms.push({
    id: `F${String(i + 1).padStart(2, '0')}`,
    file,
    tasks: def.tasks.length,
    statusCol: def.statusColumn,
    freqs: [...new Set(def.tasks.map((t) => t.freq))].sort()
  });
}
const out = new URL('../test/fixtures.local.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify({ formsDir: dir, forms }, null, 2));
console.log(`wrote ${forms.length} fixtures to ${out}`);
```

- [ ] **Step 5: Ignore the generated file, run tests, commit**

Append to `.gitignore`:
```
# Generated from the sensitive forms folder
test/fixtures.local.json
```

Run: `node --test test/helpers/fixtures.test.js`
Expected: PASS.

```bash
git add .gitignore scripts/build-fixtures.js test/helpers/
git commit -m "Add git-ignored fixture map for the real form files"
```

---

### Task 4: Excel parser

**Files:**
- Create: `server/excel-parser.js`
- Create: `test/excel-parser.test.js`

**Interfaces:**
- Consumes: `ORDER` from `server/intervals.js`.
- Produces: `parseWorkbook(path) -> Promise<FormDefinition>` where

```
FormDefinition = {
  title, docNumber, revision, page,          // strings, '' when absent
  frequencies: string[],                     // subset of ORDER, ascending
  statusColumn: string | null,               // e.g. 'M', or null
  tasks: [{ no, freq, instruction, row }],
  partsRows: number,                         // blank rows in the parts table
  sections: { safety, procedure, ppe: string[], remarks },
  signatures: [{ key, label }]               // three, in chain order
}
```

- [ ] **Step 1: Write the failing test**

`test/excel-parser.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseWorkbook } from '../server/excel-parser.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const fx = loadFixtures();

test('every sample form parses to its expected shape', { skip: fx ? false : SKIP }, async () => {
  for (const f of fx.forms) {
    const def = await parseWorkbook(join(fx.formsDir, f.file));
    assert.equal(def.tasks.length, f.tasks, `${f.id} task count`);
    assert.equal(def.statusColumn, f.statusCol, `${f.id} status column`);
    assert.deepEqual([...new Set(def.tasks.map((t) => t.freq))].sort(), f.freqs, `${f.id} freqs`);
    assert.ok(def.docNumber, `${f.id} has a document number`);
    assert.equal(def.signatures.length, 3, `${f.id} signature blocks`);
  }
});

test('a task row with a blank No is still a task', { skip: fx ? false : SKIP }, async () => {
  // Guards the truncation bug: terminating on a blank No cuts one sample
  // form from 11 tasks to 3.
  const eleven = fx.forms.find((f) => f.tasks === 11);
  assert.ok(eleven, 'expected a fixture with 11 tasks');
  const def = await parseWorkbook(join(fx.formsDir, eleven.file));
  assert.equal(def.tasks.length, 11);
  assert.ok(def.tasks.some((t) => t.no === null), 'expected one unnumbered task');
});

test('frequencies are ordered shortest to longest', { skip: fx ? false : SKIP }, async () => {
  const def = await parseWorkbook(join(fx.formsDir, fx.forms[0].file));
  const idx = def.frequencies.map((f) => ['1M', '3M', '6M', 'Y'].indexOf(f));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/excel-parser.test.js`
Expected: FAIL — cannot find module `../server/excel-parser.js`.

- [ ] **Step 3: Write the implementation**

`server/excel-parser.js`:
```js
import ExcelJS from 'exceljs';
import { ORDER } from './intervals.js';

const txt = (cell) => (cell?.value == null ? '' : String(cell.text ?? cell.value).trim());
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// Column letter for a 1-based column index: 1 -> A, 27 -> AA.
function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
}

function findCell(ws, predicate, maxRow = ws.rowCount) {
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= (row.cellCount || 0); c++) {
      const v = txt(row.getCell(c));
      if (v && predicate(norm(v))) return { row: r, col: c, value: v };
    }
  }
  return null;
}

function rightOf(ws, row, col) {
  for (let c = col + 1; c <= col + 12; c++) {
    const v = txt(ws.getRow(row).getCell(c));
    if (v) return v;
  }
  return '';
}

export async function parseWorkbook(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  // Sheet names are inconsistent and non-unique across files. Index only.
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('workbook has no worksheets');

  const titleAnchor = findCell(ws, (v) => v.startsWith('document title'), 6);
  const numAnchor = findCell(ws, (v) => v.startsWith('document number'), 6);
  const revAnchor = findCell(ws, (v) => v.startsWith('revision'), 6);
  const pageAnchor = findCell(ws, (v) => v === 'page', 6);
  const below = (a) => (a ? txt(ws.getRow(a.row + 1).getCell(a.col)) : '');

  // Task header: the row carrying No + Freq + Instruction together.
  let header = null;
  for (let r = 1; r <= ws.rowCount && !header; r++) {
    const row = ws.getRow(r);
    let no = null, freq = null, instr = null, status = null;
    for (let c = 1; c <= (row.cellCount || 0); c++) {
      const v = norm(txt(row.getCell(c)));
      if (v === 'no') no = c;
      else if (v.startsWith('freq')) freq = c;
      else if (v.startsWith('instruction')) instr = c;
      else if (v.startsWith('status')) status = c;
    }
    if (no != null && freq != null && instr != null) header = { r, no, freq, instr, status };
  }
  if (!header) throw new Error('no task table found');

  // Terminate on a blank Instruction, never on a blank No: one sample form
  // has a real task with an empty No cell and a gap in its numbering.
  const tasks = [];
  for (let r = header.r + 1; r <= ws.rowCount; r++) {
    const instruction = txt(ws.getRow(r).getCell(header.instr));
    if (!instruction) break;
    const rawNo = txt(ws.getRow(r).getCell(header.no));
    tasks.push({
      no: /^\d+$/.test(rawNo) ? Number(rawNo) : null,
      freq: txt(ws.getRow(r).getCell(header.freq)).toUpperCase(),
      instruction,
      row: r
    });
  }

  const partsAnchor = findCell(ws, (v) => v.startsWith('parts required'));
  let partsRows = 0;
  if (partsAnchor) {
    for (let r = partsAnchor.row + 1; r < header.r; r++) {
      if (txt(ws.getRow(r).getCell(partsAnchor.col + 3))) break;
      partsRows++;
    }
  }

  const ppeAnchor = findCell(ws, (v) => v.startsWith('ppe required'));
  const ppe = [];
  if (ppeAnchor) {
    for (let r = ppeAnchor.row; r < ppeAnchor.row + 8; r++) {
      const v = rightOf(ws, r, ppeAnchor.col + 1);
      if (v) ppe.push(v);
    }
  }
  const sectionText = (start) => {
    const a = findCell(ws, (v) => v.startsWith(start));
    return a ? rightOf(ws, a.row, a.col) : '';
  };

  const freqs = ORDER.filter((f) => tasks.some((t) => t.freq === f));

  return {
    title: below(titleAnchor),
    docNumber: below(numAnchor),
    revision: below(revAnchor),
    page: below(pageAnchor),
    frequencies: freqs,
    statusColumn: header.status ? colLetter(header.status) : null,
    tasks,
    partsRows,
    sections: {
      safety: sectionText('safety'),
      procedure: sectionText('procedure'),
      ppe,
      remarks: sectionText('remarks')
    },
    signatures: [
      { key: 'technician', label: 'Maintenance performed by' },
      { key: 'team_leader', label: 'Verified by (Workshop Team Leader)' },
      { key: 'engineer', label: 'Verified by (Workshop Supervisor/Engr)' }
    ]
  };
}
```

- [ ] **Step 4: Build fixtures, then run the tests**

Run:
```bash
node scripts/build-fixtures.js "$(pwd)/Sample of Forms"
node --test test/excel-parser.test.js
```
Expected: PASS, 3 tests. If a task count disagrees with `docs/design/form-fixtures.local.md`, the parser is wrong — fix the parser, not the fixture.

- [ ] **Step 5: Commit**

```bash
git add server/excel-parser.js test/excel-parser.test.js
git commit -m "Add Excel form parser"
```

---

### Task 5: Render grid model

**Files:**
- Create: `server/grid-model.js`
- Create: `test/grid-model.test.js`

**Interfaces:**
- Produces: `buildGrid(path) -> Promise<Grid>` where

```
Grid = {
  columns: [{ index, width }],
  rows: [{ index, height, cells: [{ col, span:{rows,cols}, text, bold, align, borders:{t,r,b,l} }] }]
}
```
Cells hidden by a merge are omitted entirely; the anchor cell carries the span.

- [ ] **Step 1: Write the failing test**

`test/grid-model.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildGrid } from '../server/grid-model.js';
import { loadFixtures, SKIP } from './helpers/fixtures.js';

const fx = loadFixtures();

test('grid carries merges, widths and text', { skip: fx ? false : SKIP }, async () => {
  const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
  assert.ok(grid.columns.length > 5);
  assert.ok(grid.rows.length > 20);
  const merged = grid.rows.flatMap((r) => r.cells).filter((c) => c.span.cols > 1);
  assert.ok(merged.length > 0, 'expected merged cells');
  const allText = grid.rows.flatMap((r) => r.cells).map((c) => c.text).join(' ');
  assert.match(allText, /Instruction/);
});

test('cells hidden by a merge are omitted', { skip: fx ? false : SKIP }, async () => {
  const grid = await buildGrid(join(fx.formsDir, fx.forms[0].file));
  for (const row of grid.rows) {
    const cols = row.cells.map((c) => c.col);
    assert.deepEqual(cols, [...new Set(cols)], 'no duplicate columns in a row');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/grid-model.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`server/grid-model.js`:
```js
import ExcelJS from 'exceljs';

const DEFAULT_COL_WIDTH = 8.43;
const PX_PER_CHAR = 7.5;

export async function buildGrid(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];

  const maxCol = ws.columnCount;
  const columns = [];
  for (let c = 1; c <= maxCol; c++) {
    const w = ws.getColumn(c).width ?? DEFAULT_COL_WIDTH;
    columns.push({ index: c, width: Math.round(w * PX_PER_CHAR) });
  }

  // Map every cell covered by a merge to its anchor, so covered cells can be
  // skipped and the anchor can carry the span.
  const spans = new Map();
  const covered = new Set();
  for (const range of Object.values(ws.model.merges ?? {})) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (!m) continue;
    const toNum = (s) => [...s].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);
    const c1 = toNum(m[1]), r1 = Number(m[2]), c2 = toNum(m[3]), r2 = Number(m[4]);
    spans.set(`${r1}:${c1}`, { rows: r2 - r1 + 1, cols: c2 - c1 + 1 });
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++)
        if (!(r === r1 && c === c1)) covered.add(`${r}:${c}`);
  }

  const side = (b) => (b?.style ? true : false);
  const rows = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= maxCol; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = row.getCell(c);
      const text = cell.value == null ? '' : String(cell.text ?? cell.value).trim();
      const b = cell.border ?? {};
      const hasBorder = side(b.top) || side(b.right) || side(b.bottom) || side(b.left);
      if (!text && !hasBorder && !spans.has(`${r}:${c}`)) continue;
      cells.push({
        col: c,
        span: spans.get(`${r}:${c}`) ?? { rows: 1, cols: 1 },
        text,
        bold: Boolean(cell.font?.bold),
        align: cell.alignment?.horizontal ?? 'left',
        borders: { t: side(b.top), r: side(b.right), b: side(b.bottom), l: side(b.left) }
      });
    }
    rows.push({ index: r, height: Math.round(row.height ?? 15), cells });
  }
  return { columns, rows };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/grid-model.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/grid-model.js test/grid-model.test.js
git commit -m "Add render grid model"
```

---

### Task 6: Database schema

**Files:**
- Create: `server/db.js`
- Create: `test/db.test.js`

**Interfaces:**
- Produces: `openDb(path = 'data/pm.sqlite') -> Database` with the schema applied and foreign keys on. `':memory:'` is a valid path for tests.

- [ ] **Step 1: Write the failing test**

`test/db.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';

test('schema creates every table', () => {
  const db = openDb(':memory:');
  const names = db.prepare("select name from sqlite_master where type='table'")
    .all().map((r) => r.name);
  for (const t of ['settings', 'form_catalog', 'form_fields', 'users',
                   'submissions', 'submission_fields', 'signatures']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test('foreign keys are enforced', () => {
  const db = openDb(':memory:');
  assert.throws(() => db.prepare(
    'insert into signatures (submission_id, stage, user_id, full_name, image_png, signed_at) values (?,?,?,?,?,?)'
  ).run(999, 'technician', 1, 'X', 'data:', '2026-01-01T00:00:00Z'));
});

test('applying the schema twice is safe', () => {
  const db = openDb(':memory:');
  assert.doesNotThrow(() => openDb(':memory:'));
  assert.ok(db);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`server/db.js`:
```js
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists form_catalog (
  id integer primary key,
  file_path text not null unique,
  file_name text not null,
  file_type text not null check (file_type in ('xlsx','pdf')),
  title text not null default '',
  doc_number text not null default '',
  revision text not null default '',
  state text not null check (state in ('ready','needs_setup','inactive')),
  parse_error text,
  content_hash text,
  last_scanned_at text
);

create table if not exists form_fields (
  id integer primary key,
  form_id integer not null references form_catalog(id) on delete cascade,
  field_key text not null,
  label text not null,
  section text not null default '',
  kind text not null check (kind in ('text','signature')),
  sort_order integer not null default 0,
  source text not null check (source in ('parsed','admin')),
  unique (form_id, field_key)
);

create table if not exists users (
  id integer primary key,
  username text not null unique,
  password_hash text not null,
  full_name text not null,
  role text not null check (role in ('technician','team_leader','engineer','admin')),
  active integer not null default 1,
  created_at text not null
);

create table if not exists submissions (
  id integer primary key,
  form_id integer not null references form_catalog(id),
  form_snapshot text not null,
  machine_id text not null default '',
  frequency text not null default '',
  state text not null,
  created_by integer not null references users(id),
  created_at text not null,
  updated_at text not null
);

create table if not exists submission_fields (
  id integer primary key,
  submission_id integer not null references submissions(id) on delete cascade,
  field_key text not null,
  label text not null,
  value text not null default '',
  unique (submission_id, field_key)
);

create table if not exists signatures (
  id integer primary key,
  submission_id integer not null references submissions(id) on delete cascade,
  stage text not null check (stage in ('technician','team_leader','engineer')),
  user_id integer not null references users(id),
  full_name text not null,
  image_png text not null,
  signed_at text not null,
  unique (submission_id, stage)
);

create index if not exists idx_sub_state on submissions(state);
create index if not exists idx_sub_creator on submissions(created_by);
`;

export function openDb(path = 'data/pm.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/db.js test/db.test.js
git commit -m "Add SQLite schema"
```

---

### Task 7: Folder scanner and catalog

**Files:**
- Create: `server/scanner.js`
- Create: `test/scanner.test.js`

**Interfaces:**
- Consumes: `openDb`, `parseWorkbook`.
- Produces:
  - `scanFolder(db, dir) -> Promise<{added, updated, deactivated, failed}>`
  - `listForms(db, {includeAll=false}) -> Form[]` — technicians get `ready` only.

- [ ] **Step 1: Write the failing test**

`test/scanner.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { scanFolder, listForms } from '../server/scanner.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pmforms-'));

test('a pdf lands as needs_setup and is hidden from technicians', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'guide.pdf'), '%PDF-1.4 test');
  const db = openDb(':memory:');
  const res = await scanFolder(db, dir);
  assert.equal(res.added, 1);
  assert.equal(listForms(db, { includeAll: true })[0].state, 'needs_setup');
  assert.equal(listForms(db).length, 0, 'technicians see no unmapped form');
  rmSync(dir, { recursive: true, force: true });
});

test('an unparseable xlsx is needs_setup, not a crash', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'broken.xlsx'), 'not really a workbook');
  const db = openDb(':memory:');
  const res = await scanFolder(db, dir);
  assert.equal(res.failed, 1);
  const [form] = listForms(db, { includeAll: true });
  assert.equal(form.state, 'needs_setup');
  assert.ok(form.parse_error);
  rmSync(dir, { recursive: true, force: true });
});

test('a removed file goes inactive rather than being deleted', async () => {
  const dir = tmp();
  const file = join(dir, 'gone.pdf');
  writeFileSync(file, '%PDF-1.4');
  const db = openDb(':memory:');
  await scanFolder(db, dir);
  rmSync(file);
  const res = await scanFolder(db, dir);
  assert.equal(res.deactivated, 1);
  assert.equal(listForms(db, { includeAll: true })[0].state, 'inactive');
  rmSync(dir, { recursive: true, force: true });
});

test('a missing folder reports an error without wiping the catalog', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.pdf'), '%PDF-1.4');
  const db = openDb(':memory:');
  await scanFolder(db, dir);
  await assert.rejects(() => scanFolder(db, join(dir, 'nope')));
  assert.equal(listForms(db, { includeAll: true }).length, 1, 'catalog survives');
  rmSync(dir, { recursive: true, force: true });
});

test('excel temp files are ignored', async () => {
  const dir = tmp();
  writeFileSync(join(dir, '~$draft.xlsx'), 'lock file');
  const db = openDb(':memory:');
  const res = await scanFolder(db, dir);
  assert.equal(res.added, 0);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scanner.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`server/scanner.js`:
```js
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseWorkbook } from './excel-parser.js';

const SUPPORTED = new Set(['.xlsx', '.pdf']);
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function fieldsFromDefinition(def) {
  const fields = [
    { field_key: 'machine_id', label: 'Machine ID', section: 'Record', kind: 'text' },
    { field_key: 'special_tools', label: 'Special tools required', section: 'Record', kind: 'text' }
  ];
  for (const t of def.tasks) {
    fields.push({
      field_key: `task_${t.row}`,
      label: t.instruction,
      section: 'Tasks',
      kind: 'text'
    });
  }
  fields.push({ field_key: 'remarks', label: 'Remarks', section: 'Record', kind: 'text' });
  for (const s of def.signatures) {
    fields.push({ field_key: `sig_${s.key}`, label: s.label, section: 'Sign-off', kind: 'signature' });
  }
  return fields.map((f, i) => ({ ...f, sort_order: i, source: 'parsed' }));
}

export async function scanFolder(db, dir) {
  // Throws if the folder is gone — the caller surfaces it and the existing
  // catalog is left untouched.
  const entries = readdirSync(dir).filter((f) => {
    if (f.startsWith('~$') || f.startsWith('.')) return false;
    return SUPPORTED.has(extname(f).toLowerCase()) && statSync(join(dir, f)).isFile();
  });

  const res = { added: 0, updated: 0, deactivated: 0, failed: 0 };
  const now = new Date().toISOString();
  const seen = new Set();

  for (const name of entries) {
    const path = join(dir, name);
    seen.add(path);
    const type = extname(name).toLowerCase() === '.pdf' ? 'pdf' : 'xlsx';
    const h = hash(path);
    const existing = db.prepare('select * from form_catalog where file_path = ?').get(path);
    if (existing && existing.content_hash === h && existing.state !== 'inactive') continue;

    let title = '', docNumber = '', revision = '', state = 'needs_setup', parseError = null, def = null;
    if (type === 'xlsx') {
      try {
        def = await parseWorkbook(path);
        ({ title, docNumber, revision } = def);
        state = 'ready';
      } catch (err) {
        parseError = String(err.message).slice(0, 500);
        res.failed++;
      }
    }

    const row = {
      file_path: path, file_name: name, file_type: type,
      title, doc_number: docNumber, revision, state,
      parse_error: parseError, content_hash: h, last_scanned_at: now
    };

    if (existing) {
      db.prepare(`update form_catalog set file_name=@file_name, file_type=@file_type,
        title=@title, doc_number=@doc_number, revision=@revision, state=@state,
        parse_error=@parse_error, content_hash=@content_hash, last_scanned_at=@last_scanned_at
        where file_path=@file_path`).run(row);
      res.updated++;
    } else {
      db.prepare(`insert into form_catalog
        (file_path,file_name,file_type,title,doc_number,revision,state,parse_error,content_hash,last_scanned_at)
        values (@file_path,@file_name,@file_type,@title,@doc_number,@revision,@state,@parse_error,@content_hash,@last_scanned_at)`)
        .run(row);
      res.added++;
    }

    if (def) {
      const { id } = db.prepare('select id from form_catalog where file_path = ?').get(path);
      db.prepare('delete from form_fields where form_id = ? and source = ?').run(id, 'parsed');
      const ins = db.prepare(`insert or replace into form_fields
        (form_id, field_key, label, section, kind, sort_order, source)
        values (?,?,?,?,?,?,?)`);
      for (const f of fieldsFromDefinition(def))
        ins.run(id, f.field_key, f.label, f.section, f.kind, f.sort_order, f.source);
    }
  }

  // Anything catalogued but no longer on disk becomes inactive. Never deleted:
  // old submissions must keep resolving to the form they were filled against.
  for (const row of db.prepare("select id, file_path from form_catalog where state != 'inactive'").all()) {
    if (!seen.has(row.file_path)) {
      db.prepare("update form_catalog set state='inactive' where id=?").run(row.id);
      res.deactivated++;
    }
  }
  return res;
}

export function listForms(db, { includeAll = false } = {}) {
  const sql = includeAll
    ? 'select * from form_catalog order by file_name'
    : "select * from form_catalog where state='ready' order by file_name";
  return db.prepare(sql).all();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scanner.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/scanner.js test/scanner.test.js
git commit -m "Add folder scanner and form catalog"
```

---

### Task 8: Authentication and roles

**Files:**
- Create: `server/auth.js`
- Create: `test/auth.test.js`

**Interfaces:**
- Produces:
  - `hashPassword(pw) -> string` (`scrypt$salt$hash`)
  - `verifyPassword(pw, stored) -> boolean`
  - `createUser(db, {username, password, fullName, role}) -> User`
  - `authenticate(db, username, password) -> User | null`
  - `requireRole(...roles) -> middleware` — 401 when signed out, 403 when the role is wrong
  - `ROLES` — `['technician','team_leader','engineer','admin']`

- [ ] **Step 1: Write the failing test**

`test/auth.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { hashPassword, verifyPassword, createUser, authenticate, requireRole } from '../server/auth.js';

test('hashing is salted and verifies', () => {
  const a = hashPassword('correct horse');
  const b = hashPassword('correct horse');
  assert.notEqual(a, b, 'same password must not produce the same hash');
  assert.ok(verifyPassword('correct horse', a));
  assert.equal(verifyPassword('wrong', a), false);
});

test('stored hash never contains the plaintext', () => {
  assert.equal(hashPassword('hunter2').includes('hunter2'), false);
});

test('authenticate accepts the right password and rejects the wrong one', () => {
  const db = openDb(':memory:');
  createUser(db, { username: 'tech1', password: 'pw', fullName: 'Tech One', role: 'technician' });
  assert.ok(authenticate(db, 'tech1', 'pw'));
  assert.equal(authenticate(db, 'tech1', 'nope'), null);
  assert.equal(authenticate(db, 'ghost', 'pw'), null);
});

test('an inactive user cannot authenticate', () => {
  const db = openDb(':memory:');
  const u = createUser(db, { username: 'gone', password: 'pw', fullName: 'G', role: 'technician' });
  db.prepare('update users set active = 0 where id = ?').run(u.id);
  assert.equal(authenticate(db, 'gone', 'pw'), null);
});

test('requireRole answers 401 signed out and 403 for the wrong role', () => {
  const run = (user, roles) => {
    const req = { session: user ? { user } : {} };
    let code = 200;
    const res = { status(c) { code = c; return this; }, json() { return this; } };
    let nexted = false;
    requireRole(...roles)(req, res, () => { nexted = true; });
    return { code, nexted };
  };
  assert.equal(run(null, ['admin']).code, 401);
  assert.equal(run({ role: 'technician' }, ['admin']).code, 403);
  assert.equal(run({ role: 'admin' }, ['admin']).nexted, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/auth.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`server/auth.js`:
```js
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const ROLES = ['technician', 'team_leader', 'engineer', 'admin'];
const KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function createUser(db, { username, password, fullName, role }) {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  const info = db.prepare(
    'insert into users (username, password_hash, full_name, role, active, created_at) values (?,?,?,?,1,?)'
  ).run(username, hashPassword(password), fullName, role, new Date().toISOString());
  return db.prepare('select * from users where id = ?').get(info.lastInsertRowid);
}

export function authenticate(db, username, password) {
  const user = db.prepare('select * from users where username = ? and active = 1').get(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

export function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (!roles.includes(user.role))
      return res.status(403).json({ error: 'Your role cannot perform this action.' });
    next();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/auth.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/auth.js test/auth.test.js
git commit -m "Add authentication and role guards"
```

---

### Task 9: Workflow state machine

**Files:**
- Create: `server/workflow.js`
- Create: `test/workflow.test.js`

**Interfaces:**
- Consumes: `tasksInScope` from `intervals.js`.
- Produces:
  - `STAGES` — `[{state:'draft', actor:'technician', next:'pending_lead'}, ...]`
  - `createSubmission(db, {formId, userId, machineId, frequency}) -> Submission`
  - `saveFields(db, submissionId, {key: value}) -> void`
  - `assertCanEdit(db, submissionId, user) -> void` — throws unless this user owns the record's current stage
  - `signAndAdvance(db, {submissionId, user, signaturePng}) -> Submission` — throws on wrong role/state or missing signature
  - `queueFor(db, user) -> Submission[]`

- [ ] **Step 1: Write the failing test**

`test/workflow.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { createSubmission, signAndAdvance, queueFor, saveFields, assertCanEdit } from '../server/workflow.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function setup() {
  const db = openDb(':memory:');
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();
  const users = {
    tech: createUser(db, { username: 't', password: 'p', fullName: 'Tech', role: 'technician' }),
    lead: createUser(db, { username: 'l', password: 'p', fullName: 'Lead', role: 'team_leader' }),
    eng: createUser(db, { username: 'e', password: 'p', fullName: 'Eng', role: 'engineer' })
  };
  const sub = createSubmission(db, { formId: 1, userId: users.tech.id, machineId: 'ED04', frequency: 'Y' });
  return { db, users, sub };
}

test('a submission walks technician to team leader to engineer', () => {
  const { db, users, sub } = setup();
  assert.equal(sub.state, 'draft');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG }).state, 'pending_lead');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.lead, signaturePng: PNG }).state, 'pending_engineer');
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.eng, signaturePng: PNG }).state, 'approved');
});

test('signing is required before advancing', () => {
  const { db, users, sub } = setup();
  assert.throws(
    () => signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: '' }),
    /signature/i
  );
  assert.equal(db.prepare('select state from submissions where id=?').get(sub.id).state, 'draft');
});

test('the wrong role cannot advance, and state is untouched', () => {
  const { db, users, sub } = setup();
  assert.throws(() => signAndAdvance(db, { submissionId: sub.id, user: users.eng, signaturePng: PNG }), /cannot/i);
  assert.equal(db.prepare('select state from submissions where id=?').get(sub.id).state, 'draft');
});

test('an approved record is terminal', () => {
  const { db, users, sub } = setup();
  for (const u of [users.tech, users.lead, users.eng])
    signAndAdvance(db, { submissionId: sub.id, user: u, signaturePng: PNG });
  assert.throws(() => signAndAdvance(db, { submissionId: sub.id, user: users.eng, signaturePng: PNG }), /approved/i);
});

test('signature timestamp comes from the server, not the caller', () => {
  const { db, users, sub } = setup();
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG, signedAt: '1999-01-01T00:00:00Z' });
  const sig = db.prepare('select * from signatures where submission_id=?').get(sub.id);
  assert.ok(new Date(sig.signed_at).getFullYear() >= 2026);
});

test('queues show only what the role may act on', () => {
  const { db, users, sub } = setup();
  assert.equal(queueFor(db, users.lead).length, 0);
  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  assert.equal(queueFor(db, users.lead).length, 1);
  assert.equal(queueFor(db, users.eng).length, 0);
  assert.equal(queueFor(db, users.tech).length, 1, 'technician still sees their own');
});

test('only the current stage owner may edit fields', () => {
  const { db, users, sub } = setup();
  // Draft belongs to the technician who created it.
  assert.doesNotThrow(() => assertCanEdit(db, sub.id, users.tech));
  assert.throws(() => assertCanEdit(db, sub.id, users.lead), /cannot/i);

  signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG });
  // Now with the lead: the technician must no longer be able to alter it.
  assert.throws(() => assertCanEdit(db, sub.id, users.tech), /cannot/i);
  assert.doesNotThrow(() => assertCanEdit(db, sub.id, users.lead));
});

test('an approved record cannot be edited by anyone', () => {
  const { db, users, sub } = setup();
  for (const u of [users.tech, users.lead, users.eng])
    signAndAdvance(db, { submissionId: sub.id, user: u, signaturePng: PNG });
  for (const u of Object.values(users))
    assert.throws(() => assertCanEdit(db, sub.id, u), /approved/i);
});

test('fields save and overwrite by key', () => {
  const { db, sub } = setup();
  saveFields(db, sub.id, { task_28: 'OK', remarks: 'none' });
  saveFields(db, sub.id, { task_28: 'Replaced belt' });
  const rows = db.prepare('select field_key, value from submission_fields where submission_id=? order by field_key').all(sub.id);
  assert.deepEqual(rows, [
    { field_key: 'remarks', value: 'none' },
    { field_key: 'task_28', value: 'Replaced belt' }
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/workflow.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`server/workflow.js`:
```js
export const STAGES = [
  { state: 'draft', actor: 'technician', next: 'pending_lead' },
  { state: 'pending_lead', actor: 'team_leader', next: 'pending_engineer' },
  { state: 'pending_engineer', actor: 'engineer', next: 'approved' }
];

const stageFor = (state) => STAGES.find((s) => s.state === state);

export function createSubmission(db, { formId, userId, machineId = '', frequency = '', snapshot = null }) {
  const now = new Date().toISOString();
  const fields = snapshot ??
    db.prepare('select field_key, label, section, kind, sort_order from form_fields where form_id=? order by sort_order').all(formId);
  const info = db.prepare(`insert into submissions
    (form_id, form_snapshot, machine_id, frequency, state, created_by, created_at, updated_at)
    values (?,?,?,?, 'draft', ?,?,?)`)
    .run(formId, JSON.stringify(fields), machineId, frequency, userId, now, now);
  return db.prepare('select * from submissions where id=?').get(info.lastInsertRowid);
}

export function saveFields(db, submissionId, values) {
  const snapshot = JSON.parse(db.prepare('select form_snapshot from submissions where id=?').get(submissionId).form_snapshot);
  const labels = new Map(snapshot.map((f) => [f.field_key, f.label]));
  const stmt = db.prepare(`insert into submission_fields (submission_id, field_key, label, value)
    values (?,?,?,?)
    on conflict(submission_id, field_key) do update set value=excluded.value`);
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) stmt.run(submissionId, key, labels.get(key) ?? key, String(value ?? ''));
  });
  tx(Object.entries(values));
}

// A record may only be edited by whoever owns its current stage. Without this,
// any signed-in user could rewrite any record, including one already sitting
// with the engineer for approval.
export function assertCanEdit(db, submissionId, user) {
  const sub = db.prepare('select * from submissions where id=?').get(submissionId);
  if (!sub) throw new Error('Submission not found.');
  if (sub.state === 'approved') throw new Error('This record is approved and cannot be changed.');
  const stage = stageFor(sub.state);
  if (!stage || stage.actor !== user.role)
    throw new Error('Your role cannot edit this record at its current stage.');
  if (stage.actor === 'technician' && sub.created_by !== user.id)
    throw new Error('Your role cannot edit another technician\'s record.');
}

export function signAndAdvance(db, { submissionId, user, signaturePng }) {
  if (!signaturePng) throw new Error('A signature is required before submitting.');

  const tx = db.transaction(() => {
    // Re-read state inside the transaction so two concurrent actors cannot
    // both advance the same record.
    const sub = db.prepare('select * from submissions where id=?').get(submissionId);
    if (!sub) throw new Error('Submission not found.');
    if (sub.state === 'approved') throw new Error('This record is approved and cannot be changed.');

    const stage = stageFor(sub.state);
    if (!stage) throw new Error(`Unknown state: ${sub.state}`);
    if (stage.actor !== user.role) throw new Error('Your role cannot sign this record at its current stage.');
    if (stage.actor === 'technician' && sub.created_by !== user.id)
      throw new Error('Only the technician who created this record can submit it.');

    const now = new Date().toISOString();
    db.prepare(`insert into signatures (submission_id, stage, user_id, full_name, image_png, signed_at)
      values (?,?,?,?,?,?)`).run(submissionId, stage.actor, user.id, user.full_name ?? user.fullName ?? '', signaturePng, now);
    db.prepare('update submissions set state=?, updated_at=? where id=?').run(stage.next, now, submissionId);
    return db.prepare('select * from submissions where id=?').get(submissionId);
  });
  return tx();
}

export function queueFor(db, user) {
  if (user.role === 'admin') return db.prepare('select * from submissions order by updated_at desc').all();
  const stage = STAGES.find((s) => s.actor === user.role);
  if (user.role === 'technician') {
    return db.prepare('select * from submissions where created_by=? order by updated_at desc').all(user.id);
  }
  return db.prepare('select * from submissions where state=? order by updated_at desc').all(stage.state);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/workflow.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/workflow.js test/workflow.test.js
git commit -m "Add sign-off workflow state machine"
```

---

### Task 10: HTTP API and server wiring

**Files:**
- Create: `server/index.js`
- Create: `server/routes.js`
- Create: `server/seed.js`
- Create: `test/api.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `createApp({db}) -> express.Application`, and `seedDemoUsers(db, {silent}) -> {username, password, role}[]`.

Routes:

| Method | Path | Role | Does |
|---|---|---|---|
| POST | `/api/login` | any | Sign in |
| POST | `/api/logout` | any | Sign out |
| GET | `/api/me` | any | Current user or `null` |
| GET | `/api/forms` | signed in | Ready forms (all, for admin) |
| GET | `/api/forms/:id/grid` | signed in | Render grid for an xlsx form |
| GET | `/api/forms/:id/file` | signed in | Raw file (PDF viewer) |
| GET | `/api/forms/:id/fields` | signed in | Field spec + tasks + frequencies |
| POST | `/api/submissions` | technician | Create a draft |
| GET | `/api/submissions` | signed in | Queue for the role |
| GET | `/api/submissions/:id` | signed in | Full record + signatures |
| PATCH | `/api/submissions/:id` | acting role | Save field values |
| POST | `/api/submissions/:id/sign` | acting role | Sign and advance |
| GET | `/api/admin/settings` | admin | Forms folder |
| PUT | `/api/admin/settings` | admin | Set folder, rescan |
| POST | `/api/admin/rescan` | admin | Rescan current folder |
| GET/POST/PATCH | `/api/admin/users` | admin | List / create / edit users |
| PUT | `/api/admin/forms/:id/fields` | admin | Save a PDF field mapping |

- [ ] **Step 1: Write the failing test**

`test/api.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { seedDemoUsers } from '../server/seed.js';

async function boot() {
  const db = openDb(':memory:');
  seedDemoUsers(db, { silent: true });
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
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { db, server, call };
}

test('unauthenticated requests are refused', async () => {
  const { server, call } = await boot();
  assert.equal((await call('GET', '/api/forms')).status, 401);
  server.close();
});

test('a technician can sign in and is told who they are', async () => {
  const { server, call } = await boot();
  assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'tech' })).status, 200);
  const me = await call('GET', '/api/me');
  assert.equal(me.body.role, 'technician');
  server.close();
});

test('a technician cannot reach admin settings', async () => {
  const { server, call } = await boot();
  await call('POST', '/api/login', { username: 'tech', password: 'tech' });
  assert.equal((await call('GET', '/api/admin/settings')).status, 403);
  server.close();
});

test('a bad password is refused', async () => {
  const { server, call } = await boot();
  assert.equal((await call('POST', '/api/login', { username: 'tech', password: 'no' })).status, 401);
  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write seed, routes and server**

`server/seed.js`:
```js
import { createUser } from './auth.js';

const DEMO = [
  { username: 'tech',  password: 'tech',  fullName: 'Demo Technician',  role: 'technician' },
  { username: 'lead',  password: 'lead',  fullName: 'Demo Team Leader', role: 'team_leader' },
  { username: 'eng',   password: 'eng',   fullName: 'Demo Engineer',    role: 'engineer' },
  { username: 'admin', password: 'admin', fullName: 'Demo Admin',       role: 'admin' }
];

export function seedDemoUsers(db, { silent = false } = {}) {
  const count = db.prepare('select count(*) n from users').get().n;
  if (count > 0) return [];
  for (const u of DEMO) createUser(db, u);
  if (!silent) {
    console.log('\nDemo accounts created — change these before real use:');
    for (const u of DEMO) console.log(`  ${u.role.padEnd(12)} ${u.username} / ${u.password}`);
    console.log('');
  }
  return DEMO;
}
```

`server/routes.js` — mount every route from the table above. Each handler is thin: validate, call a server module, return JSON. Errors from `workflow.js` become `400` with `{error: err.message}`; role failures come from `requireRole`.

```js
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { authenticate, requireRole, createUser, ROLES } from './auth.js';
import { listForms, scanFolder } from './scanner.js';
import { buildGrid } from './grid-model.js';
import { parseWorkbook } from './excel-parser.js';
import { tasksInScope, scopeSummary } from './intervals.js';
import { createSubmission, saveFields, signAndAdvance, queueFor, assertCanEdit } from './workflow.js';

const signedIn = requireRole(...ROLES);

export function makeRoutes(db) {
  const r = Router();
  const setting = (k) => db.prepare('select value from settings where key=?').get(k)?.value ?? '';

  r.post('/login', (req, res) => {
    const user = authenticate(db, req.body?.username ?? '', req.body?.password ?? '');
    if (!user) return res.status(401).json({ error: 'Username or password is incorrect.' });
    req.session.user = user;
    res.json(user);
  });
  r.post('/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
  r.get('/me', (req, res) => res.json(req.session?.user ?? null));

  r.get('/forms', signedIn, (req, res) =>
    res.json(listForms(db, { includeAll: req.session.user.role === 'admin' })));

  r.get('/forms/:id/grid', signedIn, async (req, res) => {
    const form = db.prepare('select * from form_catalog where id=?').get(req.params.id);
    if (!form || form.file_type !== 'xlsx') return res.status(404).json({ error: 'No grid for this form.' });
    res.json(await buildGrid(form.file_path));
  });

  r.get('/forms/:id/file', signedIn, (req, res) => {
    const form = db.prepare('select * from form_catalog where id=?').get(req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    res.type(form.file_type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(readFileSync(form.file_path));
  });

  r.get('/forms/:id/fields', signedIn, async (req, res) => {
    const form = db.prepare('select * from form_catalog where id=?').get(req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found.' });
    const fields = db.prepare('select * from form_fields where form_id=? order by sort_order').all(form.id);
    let tasks = [], frequencies = [];
    if (form.file_type === 'xlsx' && form.state === 'ready') {
      const def = await parseWorkbook(form.file_path);
      tasks = def.tasks; frequencies = def.frequencies;
    }
    const selected = String(req.query.frequency ?? '');
    res.json({
      form, fields, frequencies, tasks,
      inScope: selected ? tasksInScope(tasks, selected).map((t) => t.row) : tasks.map((t) => t.row),
      summary: selected ? scopeSummary(tasks, selected) : null
    });
  });

  r.post('/submissions', requireRole('technician'), (req, res) => {
    const { formId, machineId, frequency } = req.body ?? {};
    res.json(createSubmission(db, { formId, userId: req.session.user.id, machineId, frequency }));
  });

  r.get('/submissions', signedIn, (req, res) => res.json(queueFor(db, req.session.user)));

  r.get('/submissions/:id', signedIn, (req, res) => {
    const sub = db.prepare('select * from submissions where id=?').get(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Record not found.' });
    res.json({
      submission: sub,
      snapshot: JSON.parse(sub.form_snapshot),
      values: db.prepare('select field_key, value from submission_fields where submission_id=?').all(sub.id),
      signatures: db.prepare('select stage, full_name, image_png, signed_at from signatures where submission_id=?').all(sub.id)
    });
  });

  r.patch('/submissions/:id', signedIn, (req, res) => {
    try {
      assertCanEdit(db, Number(req.params.id), req.session.user);
      saveFields(db, Number(req.params.id), req.body?.values ?? {});
      res.json({ ok: true });
    } catch (err) { res.status(403).json({ error: err.message }); }
  });

  r.post('/submissions/:id/sign', signedIn, (req, res) => {
    try {
      res.json(signAndAdvance(db, {
        submissionId: Number(req.params.id),
        user: req.session.user,
        signaturePng: req.body?.signaturePng ?? ''
      }));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ---- admin ----
  const admin = requireRole('admin');
  r.get('/admin/settings', admin, (_req, res) => res.json({ formsFolder: setting('forms_folder') }));

  r.put('/admin/settings', admin, async (req, res) => {
    const folder = String(req.body?.formsFolder ?? '').trim();
    try {
      const result = await scanFolder(db, folder);
      db.prepare('insert into settings (key,value) values (?,?) on conflict(key) do update set value=excluded.value')
        .run('forms_folder', folder);
      res.json({ formsFolder: folder, ...result });
    } catch (err) {
      res.status(400).json({ error: `Could not read that folder: ${err.message}` });
    }
  });

  r.post('/admin/rescan', admin, async (_req, res) => {
    try { res.json(await scanFolder(db, setting('forms_folder'))); }
    catch (err) { res.status(400).json({ error: `Could not read that folder: ${err.message}` }); }
  });

  r.get('/admin/users', admin, (_req, res) =>
    res.json(db.prepare('select id, username, full_name, role, active from users order by username').all()));

  r.post('/admin/users', admin, (req, res) => {
    try {
      const u = createUser(db, req.body ?? {});
      const { password_hash, ...safe } = u;
      res.json(safe);
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  r.patch('/admin/users/:id', admin, (req, res) => {
    const { fullName, role, active } = req.body ?? {};
    db.prepare('update users set full_name=coalesce(?,full_name), role=coalesce(?,role), active=coalesce(?,active) where id=?')
      .run(fullName ?? null, role ?? null, active ?? null, req.params.id);
    res.json({ ok: true });
  });

  r.put('/admin/forms/:id/fields', admin, (req, res) => {
    const formId = Number(req.params.id);
    const fields = req.body?.fields ?? [];
    const tx = db.transaction(() => {
      db.prepare('delete from form_fields where form_id=? and source=?').run(formId, 'admin');
      const ins = db.prepare(`insert or replace into form_fields
        (form_id, field_key, label, section, kind, sort_order, source) values (?,?,?,?,?,?,'admin')`);
      fields.forEach((f, i) => ins.run(formId, f.field_key, f.label, f.section ?? '', f.kind ?? 'text', i));
      if (fields.length) db.prepare("update form_catalog set state='ready' where id=?").run(formId);
    });
    tx();
    res.json({ ok: true });
  });

  return r;
}
```

`server/index.js`:
```js
import express from 'express';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seedDemoUsers } from './seed.js';
import { makeRoutes } from './routes.js';

export function createApp({ db }) {
  const app = express();
  app.use(express.json({ limit: '4mb' })); // signature PNGs
  app.use(session({
    secret: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' }
  }));
  app.use('/api', makeRoutes(db));
  app.use(express.static(fileURLToPath(new URL('../web', import.meta.url))));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  seedDemoUsers(db);
  const port = Number(process.env.PORT ?? 3000);
  createApp({ db }).listen(port, () => console.log(`PM forms running at http://localhost:${port}`));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/api.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/routes.js server/seed.js test/api.test.js
git commit -m "Add HTTP API and server wiring"
```

---

### Task 11: Design tokens and app shell

Direction: document control. Monochrome, grid-forward, codes in monospace, one accent for record state.

**Files:**
- Create: `web/index.html`
- Create: `web/css/app.css`

**Interfaces:**
- Produces: CSS custom properties consumed by every later web task:
  `--ink #16181d`, `--paper #fff`, `--shell #e9eaed`, `--rule #c8cbd1`, `--soft #f4f5f7`, `--mute #6b7078`, `--stamp #b4232a`, `--ok #0f6e5c`.
- Produces: DOM anchors `#login`, `#app`, `#control-strip`, `#pane-left`, `#pane-right`.

- [ ] **Step 1: Write the failing test**

`test/css-contract.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');

test('light panels pin color-scheme so dark-mode viewers do not get white-on-white', () => {
  assert.match(css, /color-scheme:\s*light/);
});

test('form controls declare their own colour', () => {
  // Inputs do not inherit colour. Without this, a white input background in a
  // dark-mode browser renders white text on white.
  assert.match(css, /input[^{]*,[^{]*textarea[^{]*\{[^}]*color:/s);
});

test('out-of-scope rows are tinted, never faded', () => {
  const rule = /\.row-out\b[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'expected a .row-out rule');
  assert.match(rule[1], /background:/, 'de-emphasis is by background tint');
  assert.doesNotMatch(rule[1], /opacity:\s*0?\.[0-6]/, 'must not fade the text');
});

test('reduced motion is honoured', () => {
  assert.match(css, /prefers-reduced-motion/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/css-contract.test.js`
Expected: FAIL — cannot find `web/css/app.css`.

- [ ] **Step 3: Write the shell and stylesheet**

`web/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preventive maintenance records</title>
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <form id="login" hidden>
    <h1>Preventive maintenance records</h1>
    <label for="u">Username</label><input id="u" name="username" autocomplete="username" required>
    <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    <p id="login-error" role="alert"></p>
  </form>

  <div id="app" hidden>
    <div id="control-strip"></div>
    <main class="split">
      <section id="pane-left" aria-label="The form"></section>
      <section id="pane-right" aria-label="Fill in"></section>
    </main>
  </div>

  <script type="module" src="/js/app.js"></script>
</body>
</html>
```

`web/css/app.css` — the full stylesheet. Key rules (write the rest to match the mockup in `docs/design/directions.html`, Direction A):
```css
:root{
  --ink:#16181d; --paper:#fff; --shell:#e9eaed; --rule:#c8cbd1;
  --soft:#f4f5f7; --mute:#6b7078; --stamp:#b4232a; --ok:#0f6e5c;
  --mono:Menlo,"SF Mono",monospace;
  color-scheme:light;                 /* never inherit a dark UA form palette */
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--shell);color:var(--ink);
  font:400 15px/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif}

/* Controls do not inherit colour. Declare it, or a white input in a
   dark-mode browser renders white text on a white background. */
input,textarea,select,button{font:inherit;color:var(--ink)}
::placeholder{color:var(--mute);opacity:1}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}

#control-strip{display:flex;background:var(--ink);color:#fff;
  font:500 11px/1 var(--mono);letter-spacing:.11em;text-transform:uppercase}
#control-strip div{padding:11px 16px;border-right:1px solid #33373e}
#control-strip .state{margin-left:auto;background:var(--stamp);border-right:0}
#control-strip .state[data-state="approved"]{background:var(--ok)}

.split{display:grid;grid-template-columns:1fr 400px;gap:1px;background:var(--rule)}
#pane-left,#pane-right{background:var(--paper);min-height:76vh;padding:26px 28px}
#pane-right{background:var(--soft);padding:0}

.sheet{border-collapse:collapse;width:100%;font-size:12.5px}
.sheet td{border:1px solid var(--rule);padding:6px 9px;vertical-align:top}

/* Out of scope: tint the row, never fade the words. Instruction and Freq stay
   at full reading contrast — a technician must be able to read every line. */
.row-out td{background:#eef0f3;color:#3d434b}
.row-out .status-cell::after{content:"not in scope";color:var(--mute);
  font:500 9.5px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase}

@media (max-width:900px){.split{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/css-contract.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/css/app.css test/css-contract.test.js
git commit -m "Add app shell and document-control design tokens"
```

---

### Task 12: Left pane — form view

**Files:**
- Create: `web/js/form-view.js`

**Interfaces:**
- Consumes: `GET /api/forms/:id/grid`, `GET /api/forms/:id/file`.
- Produces: `renderForm(container, form, {grid, inScopeRows}) -> void`.

- [ ] **Step 1: Write the module**

`web/js/form-view.js`:
```js
// Renders the left pane: an HTML table mirroring the sheet for xlsx forms,
// or the browser's own PDF viewer for pdf forms.
export function renderForm(container, form, { grid, inScopeRows } = {}) {
  container.replaceChildren();

  if (form.file_type === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = `/api/forms/${form.id}/file`;
    frame.title = form.file_name;
    frame.style.cssText = 'width:100%;height:80vh;border:1px solid var(--rule)';
    container.append(frame);
    return;
  }

  const table = document.createElement('table');
  table.className = 'sheet';
  const colgroup = document.createElement('colgroup');
  for (const c of grid.columns) {
    const col = document.createElement('col');
    col.style.width = `${c.width}px`;
    colgroup.append(col);
  }
  table.append(colgroup);

  const inScope = inScopeRows ? new Set(inScopeRows) : null;
  const body = document.createElement('tbody');
  for (const row of grid.rows) {
    if (!row.cells.length) continue;
    const tr = document.createElement('tr');
    // Only rows that are actually task rows can be out of scope.
    if (inScope && inScope.size && row.isTask && !inScope.has(row.index)) tr.className = 'row-out';
    for (const cell of row.cells) {
      const td = document.createElement('td');
      if (cell.span.cols > 1) td.colSpan = cell.span.cols;
      if (cell.span.rows > 1) td.rowSpan = cell.span.rows;
      td.textContent = cell.text;
      if (cell.bold) td.style.fontWeight = '600';
      if (cell.align && cell.align !== 'left') td.style.textAlign = cell.align;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  container.append(table);
}
```

- [ ] **Step 2: Mark task rows in the grid**

Modify `server/grid-model.js` `buildGrid` to accept the parsed definition and flag task rows, so the left pane can dim out-of-scope rows:

```js
export async function buildGrid(path, definition = null) {
  // ...existing body...
  const taskRows = new Set((definition?.tasks ?? []).map((t) => t.row));
  // when pushing each row:
  rows.push({ index: r, height: ..., isTask: taskRows.has(r), cells });
}
```

And in `server/routes.js`, pass the definition:
```js
const def = await parseWorkbook(form.file_path);
res.json(await buildGrid(form.file_path, def));
```

- [ ] **Step 3: Verify by hand**

Run: `npm start`, sign in as `tech`, open a form. Expected: the left pane looks like the spreadsheet — merged header, bordered task grid — and out-of-scope rows are tinted with fully readable text.

- [ ] **Step 4: Commit**

```bash
git add web/js/form-view.js server/grid-model.js server/routes.js
git commit -m "Add left-pane form view"
```

---

### Task 13: Signature pad

**Files:**
- Create: `web/js/signature-pad.js`

**Interfaces:**
- Produces: `createSignaturePad(container, {name}) -> {toPNG(): string|null, clear(): void, isEmpty(): boolean}`.

- [ ] **Step 1: Write the module**

`web/js/signature-pad.js`:
```js
// One code path for mouse, finger and stylus via Pointer Events. Pressure is
// used for stroke width where the device reports it.
export function createSignaturePad(container, { name = '' } = {}) {
  container.replaceChildren();
  container.className = 'sig';

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Signature pad — sign with mouse, finger or stylus');
  canvas.tabIndex = 0;
  const bar = document.createElement('div');
  bar.className = 'sig-bar';
  const who = document.createElement('span');
  who.textContent = name;
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  bar.append(who, clearBtn);
  container.append(canvas, bar);

  const ctx = canvas.getContext('2d');
  let dirty = false;

  function fit() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const snapshot = dirty ? canvas.toDataURL() : null;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#16181d';
    if (snapshot) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = snapshot;
    }
  }
  requestAnimationFrame(fit);
  window.addEventListener('resize', () => requestAnimationFrame(fit));

  let drawing = false;
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = e.pressure && e.pressure !== 0.5 ? e.pressure : 0.5;
    ctx.lineWidth = 0.6 + p * 2.4;
    const [x, y] = at(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    dirty = true;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  const clear = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; };
  clearBtn.addEventListener('click', clear);

  return {
    clear,
    isEmpty: () => !dirty,
    toPNG: () => (dirty ? canvas.toDataURL('image/png') : null)
  };
}
```

- [ ] **Step 2: Add the styles**

Append to `web/css/app.css`:
```css
.sig{border:1px solid var(--rule);background:var(--paper)}
.sig canvas{display:block;width:100%;height:112px;touch-action:none;cursor:crosshair}
.sig-bar{display:flex;justify-content:space-between;align-items:center;
  border-top:1px solid var(--rule);padding:6px 10px;
  font:500 10px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
.sig-bar button{border:0;background:none;color:var(--stamp);cursor:pointer;
  font:inherit;text-transform:uppercase;letter-spacing:.08em}
```

- [ ] **Step 3: Verify by hand**

Run `npm start`, open a form, and sign with the mouse (and a stylus if available). Expected: smooth strokes, Clear empties the pad, and resizing the window does not wipe an existing signature.

- [ ] **Step 4: Commit**

```bash
git add web/js/signature-pad.js web/css/app.css
git commit -m "Add signature pad"
```

---

### Task 14: Right pane — field panel and app wiring

**Files:**
- Create: `web/js/field-panel.js`
- Create: `web/js/api.js`
- Create: `web/js/app.js`

**Interfaces:**
- Consumes: `renderForm`, `createSignaturePad`, the JSON API.
- Produces: a working technician → lead → engineer flow in the browser.

- [ ] **Step 1: Write the API client**

`web/js/api.js`:
```js
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}
export const api = {
  me: () => call('GET', '/api/me'),
  login: (username, password) => call('POST', '/api/login', { username, password }),
  logout: () => call('POST', '/api/logout'),
  forms: () => call('GET', '/api/forms'),
  grid: (id) => call('GET', `/api/forms/${id}/grid`),
  fields: (id, frequency) => call('GET', `/api/forms/${id}/fields?frequency=${encodeURIComponent(frequency ?? '')}`),
  createSubmission: (formId, machineId, frequency) => call('POST', '/api/submissions', { formId, machineId, frequency }),
  queue: () => call('GET', '/api/submissions'),
  submission: (id) => call('GET', `/api/submissions/${id}`),
  save: (id, values) => call('PATCH', `/api/submissions/${id}`, { values }),
  sign: (id, signaturePng) => call('POST', `/api/submissions/${id}/sign`, { signaturePng })
};
```

- [ ] **Step 2: Write the field panel**

`web/js/field-panel.js`:
```js
import { createSignaturePad } from './signature-pad.js';

// Renders the right pane from a field spec. Locked stages render as read-only
// text, never as disabled inputs whose values are hard to read.
export function renderFields(container, { snapshot, values, signatures, frequencies,
                                          selectedFrequency, locked, currentUser, onChange,
                                          onFrequencyChange }) {
  container.replaceChildren();
  const byKey = new Map((values ?? []).map((v) => [v.field_key, v.value]));
  const signed = new Map((signatures ?? []).map((s) => [s.stage, s]));

  if (frequencies?.length) {
    const sec = section('Maintenance interval');
    const segs = document.createElement('div');
    segs.className = 'segs';
    for (const f of frequencies) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = f;
      b.setAttribute('aria-pressed', String(f === selectedFrequency));
      b.addEventListener('click', () => onFrequencyChange(f));
      segs.append(b);
    }
    sec.append(segs);
    container.append(sec);
  }

  const groups = new Map();
  for (const f of snapshot) {
    if (!groups.has(f.section)) groups.set(f.section, []);
    groups.get(f.section).push(f);
  }

  for (const [name, fields] of groups) {
    const sec = section(name);
    for (const f of fields) {
      if (f.kind === 'signature') {
        const stage = f.field_key.replace('sig_', '');
        const wrap = document.createElement('div');
        wrap.className = 'fld';
        const label = document.createElement('div');
        label.className = 'fld-label';
        label.textContent = f.label;
        wrap.append(label);
        const done = signed.get(stage);
        if (done) {
          const img = document.createElement('img');
          img.src = done.image_png;
          img.alt = `Signature of ${done.full_name}`;
          img.className = 'sig-done';
          const meta = document.createElement('p');
          meta.className = 'sig-meta';
          meta.textContent = `${done.full_name} · ${new Date(done.signed_at).toLocaleString()}`;
          wrap.append(img, meta);
        } else if (stage === currentUser.role && !locked) {
          const pad = document.createElement('div');
          wrap.append(pad);
          wrap.pad = createSignaturePad(pad, { name: currentUser.full_name });
          container.pads = container.pads ?? {};
          container.pads[stage] = wrap.pad;
        } else {
          const waiting = document.createElement('p');
          waiting.className = 'sig-meta';
          waiting.textContent = 'Not yet signed';
          wrap.append(waiting);
        }
        sec.append(wrap);
        continue;
      }
      sec.append(textField(f, byKey.get(f.field_key) ?? '', locked, onChange));
    }
    container.append(sec);
  }

  function section(title) {
    const s = document.createElement('div');
    s.className = 'sec';
    const h = document.createElement('h3');
    h.textContent = title;
    s.append(h);
    return s;
  }
  function textField(f, value, isLocked, change) {
    const wrap = document.createElement('div');
    wrap.className = 'fld';
    const id = `f-${f.field_key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = f.label;
    wrap.append(label);
    if (isLocked) {
      const p = document.createElement('p');
      p.className = 'fld-readonly';
      p.textContent = value || '—';
      wrap.append(p);
    } else {
      const input = document.createElement('input');
      input.id = id;
      input.value = value;
      input.addEventListener('change', () => change(f.field_key, input.value));
      wrap.append(input);
    }
    return wrap;
  }
}
```

- [ ] **Step 3: Write the app controller**

`web/js/app.js` wires it together: sign in, list forms, pick one, create a draft, render both panes, save on change, and sign-and-submit. On submit it reads `container.pads[user.role].toPNG()`; if that is `null`, it shows "Sign before submitting." and does not call the API.

```js
import { api } from './api.js';
import { renderForm } from './form-view.js';
import { renderFields } from './field-panel.js';

const $ = (s) => document.querySelector(s);
let user = null, form = null, submission = null, frequency = '';

async function boot() {
  user = await api.me();
  $('#login').hidden = Boolean(user);
  $('#app').hidden = !user;
  if (user) await showPicker();
}

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  try {
    user = await api.login(data.get('username'), data.get('password'));
    $('#login-error').textContent = '';
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

async function showPicker() {
  const forms = await api.forms();
  const right = $('#pane-right');
  right.replaceChildren();
  const sec = document.createElement('div');
  sec.className = 'sec';
  const h = document.createElement('h3');
  h.textContent = 'Choose a form';
  sec.append(h);
  for (const f of forms) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'form-pick';
    b.textContent = f.title || f.file_name;
    b.addEventListener('click', () => openForm(f));
    sec.append(b);
  }
  right.append(sec);
}

async function openForm(picked) {
  form = picked;
  const spec = await api.fields(form.id, frequency);
  frequency = frequency || spec.frequencies.at(-1) || '';
  submission = await api.createSubmission(form.id, '', frequency);
  await paint();
}

async function paint() {
  const spec = await api.fields(form.id, frequency);
  const detail = await api.submission(submission.id);
  const grid = form.file_type === 'xlsx' ? await api.grid(form.id) : null;

  $('#control-strip').replaceChildren(
    chip(form.doc_number || form.file_name), chip(`Rev ${form.revision || '—'}`),
    chip(`${user.full_name} · ${user.role.replace('_', ' ')}`), stateChip(detail.submission.state)
  );
  renderForm($('#pane-left'), form, { grid, inScopeRows: spec.inScope });
  renderFields($('#pane-right'), {
    snapshot: detail.snapshot, values: detail.values, signatures: detail.signatures,
    frequencies: spec.frequencies, selectedFrequency: frequency,
    locked: detail.submission.state === 'approved',
    currentUser: user,
    onChange: (key, value) => api.save(submission.id, { [key]: value }),
    onFrequencyChange: async (f) => { frequency = f; await paint(); }
  });
  addSubmitBar(detail.submission.state);
}

function addSubmitBar(state) {
  const right = $('#pane-right');
  const bar = document.createElement('div');
  bar.className = 'act';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = state === 'pending_engineer' ? 'Sign and approve' : 'Sign and submit';
  const msg = document.createElement('p');
  msg.role = 'alert';
  btn.addEventListener('click', async () => {
    const pad = right.pads?.[user.role];
    const png = pad?.toPNG();
    if (!png) { msg.textContent = 'Sign before submitting.'; return; }
    try { await api.sign(submission.id, png); msg.textContent = ''; await paint(); }
    catch (err) { msg.textContent = err.message; }
  });
  if (state !== 'approved') bar.append(btn);
  bar.append(msg);
  right.append(bar);
}

const chip = (t) => { const d = document.createElement('div'); d.textContent = t; return d; };
const stateChip = (s) => {
  const d = document.createElement('div');
  d.className = 'state';
  d.dataset.state = s;
  d.textContent = s.replace('_', ' ');
  return d;
};

boot();
```

- [ ] **Step 4: Add the remaining styles**

Append the `.sec`, `.fld`, `.segs`, `.act`, `.form-pick`, `.fld-readonly`, `.sig-done`, `.sig-meta` rules to `web/css/app.css`, matching Direction A in the mockup. Every input rule must set `color`.

- [ ] **Step 5: Verify the full chain by hand**

Run `npm start`. Sign in as `admin`, set the forms folder, then:
1. `tech` / `tech` — pick a form, set interval `Y`, confirm the task count matches the cumulative rule, fill statuses, sign, submit.
2. `lead` / `lead` — the record appears in the queue; the technician's fields are read-only and their signature is visible; sign and submit.
3. `eng` / `eng` — sign and approve. The state chip turns green and the record is read-only.

- [ ] **Step 6: Commit**

```bash
git add web/js/ web/css/app.css
git commit -m "Add field panel and wire the sign-off flow"
```

---

### Task 15: Admin screens

**Files:**
- Create: `web/admin.html`
- Create: `web/js/admin.js`

**Interfaces:**
- Consumes: the `/api/admin/*` routes from Task 10.
- Produces: folder configuration, rescan, user management, and the PDF field mapper.

- [ ] **Step 1: Build the folder + rescan panel**

A text input for the folder path, a "Save and scan" button calling `PUT /api/admin/settings`, and a results line reporting added / updated / deactivated / failed. On error, show the server's message — the catalog is left intact.

- [ ] **Step 2: Build the user table**

List users from `GET /api/admin/users` with columns username, name, role, active. A "New user" form posts to `POST /api/admin/users`; editing a row patches it. Role is a select over the four roles.

- [ ] **Step 3: Build the PDF field mapper**

For a form in `needs_setup`: the PDF on the left in an iframe, and on the right an ordered list of fields being defined — each with a label, a section, and a kind (`text` or `signature`). Add, reorder and remove rows, then "Save mapping" → `PUT /api/admin/forms/:id/fields`, which flips the form to `ready`.

Seed a new mapping with the three signature blocks already present, since every form has them:
```js
const DEFAULT_FIELDS = [
  { field_key: 'machine_id', label: 'Machine ID', section: 'Record', kind: 'text' },
  { field_key: 'remarks', label: 'Remarks', section: 'Record', kind: 'text' },
  { field_key: 'sig_technician', label: 'Maintenance performed by', section: 'Sign-off', kind: 'signature' },
  { field_key: 'sig_team_leader', label: 'Verified by (Workshop Team Leader)', section: 'Sign-off', kind: 'signature' },
  { field_key: 'sig_engineer', label: 'Verified by (Workshop Supervisor/Engr)', section: 'Sign-off', kind: 'signature' }
];
```

- [ ] **Step 4: Verify by hand**

Sign in as `admin`. Point the folder at a directory containing one PDF; confirm it appears as "needs setup" and is invisible to `tech`. Map its fields, save, then confirm `tech` can now select it and fill it.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add web/admin.html web/js/admin.js
git commit -m "Add admin screens for folder, users and PDF field mapping"
```

---

## Verification checklist

Before calling this done, confirm each by running it — not by reading the code:

- [ ] `npm test` passes with the real forms present (fixtures built).
- [ ] `npm test` passes with `test/fixtures.local.json` deleted — form-dependent tests skip, nothing fails.
- [ ] Selecting `Y` on a form whose remarks require it shows every 3M and 6M task, not just the `Y` row.
- [ ] A form with an unnumbered task row shows all of its tasks.
- [ ] Instruction and Freq text is readable on out-of-scope rows, in both light and dark browser themes.
- [ ] Submitting without signing is refused and changes nothing.
- [ ] A team leader cannot act on a `draft`, and an engineer cannot act on a `pending_lead`.
- [ ] A technician cannot edit a record that has moved on to the team leader (PATCH returns 403).
- [ ] An approved record is read-only for everyone.
- [ ] A PDF form in `needs_setup` is invisible to a technician until an admin maps its fields.
- [ ] `git status` shows no `.xlsx`, `.pdf`, or database file staged.
