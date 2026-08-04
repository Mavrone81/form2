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
