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
