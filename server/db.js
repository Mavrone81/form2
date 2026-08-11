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

-- A rejection sends a record back to the technician and clears every
-- signature on it, because every stage must redo its work against whatever
-- changes next. Clearing the ink removes a claim that is no longer true; it
-- must NOT remove the fact that the record was sent back. That history lives
-- here, and carries the same two audit protections signatures already do:
--   * "on delete cascade" from the submission, so deleting a record takes
--     its history with it — but nothing else can.
--   * NO cascade from users, so deleting an account cannot erase who
--     rejected what. The delete is refused instead.
--   * full_name denormalised at rejection time, so a later rename cannot
--     retroactively rewrite who sent the record back.
-- "stage" is the reviewer stage the rejection came from. Only a reviewer can
-- ever reject — a technician owns draft/rejected and has nothing to reject —
-- so the check constraint says exactly that, in the same shape as
-- signatures.stage.
create table if not exists rejections (
  id integer primary key,
  submission_id integer not null references submissions(id) on delete cascade,
  rejected_by integer not null references users(id),
  full_name text not null,
  stage text not null check (stage in ('team_leader','engineer')),
  reason text not null,
  rejected_at text not null
);

create index if not exists idx_sub_state on submissions(state);
create index if not exists idx_sub_creator on submissions(created_by);
create index if not exists idx_rejection_sub on rejections(submission_id);
`;

// `create table if not exists` cannot add a column to a table that already
// exists, so every column added after the first release lands here instead.
// Each entry is applied only when `pragma table_info` says the column is
// missing, which keeps openDb idempotent — it runs on every boot and on every
// in-memory test database, where the columns are already present from SCHEMA
// or from a previous call.
const MIGRATIONS = [
  // The controlled document's identity AT THE MOMENT OF SIGNING. A record is
  // evidence: revise the source form to Rev F afterwards and this record must
  // still print the Rev E it was worked and signed against. content_hash is
  // kept so a later render can tell whether the file on disk is still the one
  // the record was made from, and say so on the document if it is not.
  { table: 'submissions', column: 'doc_number', ddl: "alter table submissions add column doc_number text not null default ''" },
  { table: 'submissions', column: 'revision', ddl: "alter table submissions add column revision text not null default ''" },
  { table: 'submissions', column: 'content_hash', ddl: "alter table submissions add column content_hash text not null default ''" },
  // Which generation of the field extractor last wrote this form's parsed
  // fields. A rescan skips a file whose bytes have not changed, which is right
  // for the file but wrong for the FIELDS: teach the parser to extract
  // something new — the Parts Required table was the first case — and every
  // already-catalogued form would keep its old field list forever, because no
  // source document changed. This is deliberately NOT folded into
  // content_hash: that value is copied onto each submission and is what tells
  // a reader whether the source document itself has changed since the record
  // was signed. Moving it for an app-side reason would print that warning
  // across every existing record, which would be untrue.
  { table: 'form_catalog', column: 'fields_version', ddl: "alter table form_catalog add column fields_version integer not null default 0" },
  // The answers a field will accept, newline-separated, or '' for a field that
  // takes free text. The calibration table's Pass/Fail column is the first
  // user of it: the document prints two boxes and a technician ticks one, so
  // the app must offer exactly those two answers and reject anything else.
  //
  // WHY A COLUMN AND NOT A NEW `kind`: `kind` carries a CHECK constraint, and
  // SQLite cannot widen one without rebuilding the table — a destructive
  // operation on a database holding signed records, to gain nothing a plain
  // additive column does not already give. A constrained answer is still text:
  // it is stored as text, rendered as text on the sheet, and compared as text.
  // What changes is only which values are allowed, which is exactly what this
  // column states.
  { table: 'form_fields', column: 'options', ddl: "alter table form_fields add column options text not null default ''" }
];

// The allowed answers for a field, as a list. '' (the default for every
// existing row) means the field is unconstrained free text.
export function optionsOf(field) {
  return String(field?.options ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyMigrations(db) {
  for (const { table, column, ddl } of MIGRATIONS) {
    const columns = db.prepare(`pragma table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes(column)) db.exec(ddl);
  }
}

export function openDb(path = 'data/pm.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}
