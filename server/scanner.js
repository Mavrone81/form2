import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseWorkbook } from './excel-parser.js';

const SUPPORTED = new Set(['.xlsx', '.pdf']);

// Bump whenever fieldsFromDefinition() below starts emitting a field it did
// not emit before. A rescan otherwise skips any file whose bytes are
// unchanged, which would leave every already-catalogued form on the old field
// list indefinitely: teaching the parser to read something new is not a change
// to any source document, so nothing would ever trigger regeneration.
// Regenerating is safe by design — admin-authored fields are preserved below,
// and each submission carries its own frozen form_snapshot.
//   1: machine_id, special_tools, task_<row>, remarks, sig_<stage>
//   2: adds the Parts Required table (part_<row>_<no|desc|qty|remarks>)
//   3: adds the Calibration Record table (cal_<row>_<reading|result>)
export const FIELDS_VERSION = 3;
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// One field per box of the Parts Required table. The label is the column's own
// heading rather than a per-row restatement of it ("Part No", not "Part No,
// row 3"): the right-hand panel renders these as a table with one shared header
// row, the way the document prints them, so a per-row label would be five
// copies of the same word down the screen. Anything that renders them as a flat
// list still has the sheet row in the key.
const PARTS_LABELS = { no: 'Part No', desc: 'Description', qty: 'Qty', remarks: 'Remarks' };
const PARTS_SECTION = 'Parts required';

// The Calibration Record table, on the three wire-bond documents that print
// one. Two entries per measurement: the reading taken, and whether it passed.
//
// The document prints Pass and Fail as two separate boxes and a technician
// ticks one, so the result is offered as exactly those two answers rather than
// as free text — anything else could not be placed on the sheet, because there
// is no third box to put it in.
export const CAL_SECTION = 'Calibration record';
export const CAL_RESULTS = ['Pass', 'Fail'];

// What to call one measurement. The description alone is often ambiguous
// across rows ("PRS Calibration" appears four times on one document, once per
// axis), so the printed specification is carried alongside it — which is also
// the number the technician is checking their reading against, and therefore
// worth having in front of them while they type it.
function calLabel(row) {
  return row.specification ? `${row.description} (${row.specification})` : row.description;
}

function fieldsFromDefinition(def) {
  const fields = [
    { field_key: 'machine_id', label: 'Machine ID', section: 'Record', kind: 'text' },
    { field_key: 'special_tools', label: 'Special tools required', section: 'Record', kind: 'text' }
  ];
  // Before the tasks, because that is where the document prints the table. A
  // form with no parts table (or one whose layout the parser did not recognise)
  // reports none and simply contributes nothing here.
  for (const row of def.parts?.rows ?? []) {
    for (const [key, label] of Object.entries(PARTS_LABELS)) {
      fields.push({ field_key: `part_${row}_${key}`, label, section: PARTS_SECTION, kind: 'text' });
    }
  }
  for (const t of def.tasks) {
    fields.push({
      field_key: `task_${t.row}`,
      label: t.instruction,
      section: 'Tasks',
      kind: 'text'
    });
  }
  // After the tasks and before the remarks, which is the order the documents
  // that carry one print it in. Forms without a calibration table contribute
  // nothing here.
  for (const row of def.calibration?.rows ?? []) {
    const label = calLabel(row);
    fields.push({ field_key: `cal_${row.row}_reading`, label, section: CAL_SECTION, kind: 'text' });
    fields.push({
      field_key: `cal_${row.row}_result`, label, section: CAL_SECTION, kind: 'text',
      options: CAL_RESULTS.join('\n')
    });
  }
  fields.push({ field_key: 'remarks', label: 'Remarks', section: 'Record', kind: 'text' });
  for (const s of def.signatures) {
    fields.push({ field_key: `sig_${s.key}`, label: s.label, section: 'Sign-off', kind: 'signature' });
  }
  return fields.map((f, i) => ({ options: '', ...f, sort_order: i, source: 'parsed' }));
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
    // Unchanged file AND fields generated by the current extractor: nothing to
    // do. A file whose bytes are the same but whose fields predate a newer
    // extractor is re-read, so the new fields appear without anyone having to
    // touch the source document.
    if (existing && existing.content_hash === h && existing.state !== 'inactive' &&
        existing.fields_version === FIELDS_VERSION) continue;

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
      parse_error: parseError, content_hash: h, last_scanned_at: now,
      // Which extractor generation PROCESSED this row — not whether it yielded
      // fields. A pdf never yields any, and an unparseable xlsx is already
      // left alone until its bytes change; both must stay skippable, or every
      // scan would re-read them for ever.
      fields_version: FIELDS_VERSION
    };

    if (existing) {
      db.prepare(`update form_catalog set file_name=@file_name, file_type=@file_type,
        title=@title, doc_number=@doc_number, revision=@revision, state=@state,
        parse_error=@parse_error, content_hash=@content_hash, last_scanned_at=@last_scanned_at,
        fields_version=@fields_version
        where file_path=@file_path`).run(row);
      res.updated++;
    } else {
      db.prepare(`insert into form_catalog
        (file_path,file_name,file_type,title,doc_number,revision,state,parse_error,content_hash,last_scanned_at,fields_version)
        values (@file_path,@file_name,@file_type,@title,@doc_number,@revision,@state,@parse_error,@content_hash,@last_scanned_at,@fields_version)`)
        .run(row);
      res.added++;
    }

    if (def) {
      const { id } = db.prepare('select id from form_catalog where file_path = ?').get(path);
      // Admin-authored fields must never be silently overwritten by a rescan,
      // even if a generated field_key (machine_id, task_3, sig_engineer, ...)
      // happens to collide with one. The admin's row wins: we skip generating
      // any parsed field whose key is already claimed by an admin row, so the
      // plain insert below can never hit the (form_id, field_key) unique index
      // on an admin-owned key.
      const adminKeys = new Set(
        db.prepare("select field_key from form_fields where form_id = ? and source = 'admin'")
          .all(id)
          .map((r) => r.field_key)
      );
      db.prepare('delete from form_fields where form_id = ? and source = ?').run(id, 'parsed');
      const ins = db.prepare(`insert into form_fields
        (form_id, field_key, label, section, kind, sort_order, source, options)
        values (?,?,?,?,?,?,?,?)`);
      for (const f of fieldsFromDefinition(def)) {
        if (adminKeys.has(f.field_key)) continue;
        ins.run(id, f.field_key, f.label, f.section, f.kind, f.sort_order, f.source, f.options);
      }
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
