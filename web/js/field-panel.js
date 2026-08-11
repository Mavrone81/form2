import { createSignaturePad } from './signature-pad.js';

// Renders the right pane from a field spec. Locked stages render as read-only
// text, never as disabled inputs whose values are hard to read.
//
// Hard requirement 1 (destroy every signature pad you replace): this module
// is re-rendered on every frequency change and after every save/sign, and
// each render can create a brand-new signature pad. `activePad` tracks the
// single pad this module is currently responsible for; `teardownActivePad()`
// destroys it (removing its window resize listener, per signature-pad.js's
// own `destroy()`) before a replacement is ever created. It is called both
// at the top of every renderFields() call and is exported as
// `teardownFieldPanel()` so app.js can call it when navigating away from a
// form entirely (e.g. back to the form picker), where renderFields() itself
// would not otherwise run again to trigger the teardown.
let activePad = null;
function teardownActivePad() {
  if (activePad) { activePad.destroy(); activePad = null; }
}
export function teardownFieldPanel() {
  teardownActivePad();
}


// One box of the Parts Required table, or null. Mirrors parsePartsKey() in
// server/cell-map.js — the server and the browser share no module (web/ is
// served as static files), so the convention is restated here the same way
// `sig_` already is in form-view.js, and both are covered by tests.
function partsKeyOf(fieldKey) {
  const m = /^part_(\d+)_(no|desc|qty|remarks)$/.exec(String(fieldKey ?? ''));
  return m ? { row: Number(m[1]), column: m[2] } : null;
}

// ------------------------------------------------------------------------
// The Parts Required table
// ------------------------------------------------------------------------
// Five ruled rows by four columns is twenty inputs. Through the ordinary
// `.fld` path that is a twenty-item vertical list with "Part No" written
// down it five times — roughly 700px of mostly-empty inputs wedged between
// the task list and the signature pad on a phone, and it does not read as
// the table the document prints.
//
// So it is laid out as the table it is: ONE row of column headings and one
// compact row of inputs per parts row, on a CSS grid whose tracks shrink
// with the pane.
//
// WHY A GRID THAT SHRINKS RATHER THAN A `.table-scroll` THAT PANS:
// `.table-scroll` is right for the reproduced sheet on the left, which is a
// controlled document and must not reflow. It is wrong here. Scrolling a
// form sideways takes the column headings off screen exactly while you are
// typing into a column, so you lose which box you are filling — and it
// reintroduces sideways movement on the smallest screen this app supports.
// Narrow inputs cost nothing by comparison: the value is stored in full,
// scrolls within its own box, and is rendered at full width in its real
// cell on the left-hand preview as it is typed.
//
// WHY NOT STACK INTO PER-ROW GROUPS ON NARROW SCREENS: because a parts row
// is empty on most visits. Stacking turns a section that is usually blank
// into the tallest thing on the page, on the device where height is
// scarcest. Compactness IS the mobile accommodation here.
//
// The shared heading is what names each column visually, so every input
// carries its own aria-label — otherwise a screen reader meets twenty
// identically-unlabelled boxes.
const PARTS_ORDER = ['no', 'desc', 'qty', 'remarks'];
const PARTS_FALLBACK = { no: 'Part No', desc: 'Description', qty: 'Qty', remarks: 'Remarks' };

function partsGrid(fields, values, isLocked, change, preview) {
  const rows = new Map();
  for (const f of fields) {
    const part = partsKeyOf(f.field_key);
    if (!rows.has(part.row)) rows.set(part.row, new Map());
    rows.get(part.row).set(part.column, f);
  }

  const wrap = document.createElement('div');
  wrap.className = 'parts';

  // Headings come from the fields the server sent, so the printed column
  // names and the ones shown here cannot drift apart.
  const heading = (column) => {
    for (const row of rows.values()) {
      const f = row.get(column);
      if (f?.label) return f.label;
    }
    return PARTS_FALLBACK[column];
  };

  // A read-only record shows only the rows something was actually written
  // in. Five rows of em-dashes would state that five parts were considered
  // and rejected, which is not what a blank row means.
  let entries = [...rows.entries()];
  if (isLocked) {
    entries = entries.filter(([, row]) =>
      PARTS_ORDER.some((c) => String(values.get(row.get(c)?.field_key) ?? '').trim()));
    if (!entries.length) {
      const none = document.createElement('p');
      none.className = 'parts-none';
      none.textContent = 'No parts recorded.';
      wrap.append(none);
      return wrap;
    }
  }

  const head = document.createElement('div');
  head.className = 'parts-hd';
  head.setAttribute('aria-hidden', 'true');
  for (const column of PARTS_ORDER) {
    const cell = document.createElement('span');
    cell.textContent = heading(column);
    head.append(cell);
  }
  wrap.append(head);

  entries.forEach(([, row], i) => {
    const tr = document.createElement('div');
    tr.className = 'parts-row';
    for (const column of PARTS_ORDER) {
      const f = row.get(column);
      if (!f) { tr.append(document.createElement('span')); continue; }
      const value = values.get(f.field_key) ?? '';
      // The heading is shared by every row, so each control names itself.
      const name = `${heading(column)}, part ${i + 1}`;
      if (isLocked) {
        const p = document.createElement('p');
        p.className = 'parts-ro';
        p.textContent = value || '—';
        tr.append(p);
        continue;
      }
      const input = document.createElement('input');
      input.id = `f-${f.field_key}`;
      input.value = value;
      input.setAttribute('aria-label', name);
      // Quantity gets the phone's number pad without `type="number"`, which
      // silently discards anything it cannot parse — a technician typing
      // "2 sets" would watch the value disappear — and adds spinners a
      // 44px-tall box has no room for.
      if (column === 'qty') input.inputMode = 'numeric';
      if (preview) input.addEventListener('input', () => preview(f.field_key, input.value));
      input.addEventListener('change', () => change(f.field_key, input.value));
      tr.append(input);
    }
    wrap.append(tr);
  });
  return wrap;
}

// ------------------------------------------------------------------------
// The Calibration Record table
// ------------------------------------------------------------------------
// One entry of it, or null. Mirrors parseCalKey() in server/cell-map.js, for
// the same reason partsKeyOf above mirrors parsePartsKey: web/ is served as
// static files and shares no module with the server, so the convention is
// restated here and both copies are covered by tests.
function calKeyOf(fieldKey) {
  const m = /^cal_(\d+)_(reading|result)$/.exec(String(fieldKey ?? ''));
  return m ? { row: Number(m[1]), column: m[2] } : null;
}

// The allowed answers for a field, or [] for free text. Mirrors optionsOf() in
// server/db.js — same reason again.
function optionsOf(field) {
  return String(field?.options ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// Up to 27 measurements, each with a reading and a pass/fail answer, is 54
// controls. Through the ordinary `.fld` path that is 54 stacked boxes with the
// measurement's name repeated over each pair — the same problem the parts
// table has, and it gets the same answer: lay it out as the table the document
// prints, one line per measurement.
//
// It differs from the parts table in one way that matters. A parts row is
// usually blank and is identified by what you type into it; a calibration row
// is never blank of MEANING — the document names the measurement and prints
// the specification to check it against. So the measurement's name is the row
// heading here, and it is the widest column: a technician needs to read
// "Bond Force Verification Input Force 100g (95 - 105 g)" to know what to
// measure, and truncating it would make the record unfillable.
//
// UNLIKE the parts table, rows are NOT hidden when the record is read-only: an
// unanswered measurement is itself information on a calibration record — it
// says the check was not done — and a reviewer has to be able to see which
// ones those are.
const CAL_ORDER = ['reading', 'result'];
const CAL_HEADINGS = { reading: 'Reading', result: 'Result' };

function calGrid(fields, values, isLocked, change, preview) {
  const rows = new Map();
  for (const f of fields) {
    const cal = calKeyOf(f.field_key);
    if (!rows.has(cal.row)) rows.set(cal.row, new Map());
    rows.get(cal.row).set(cal.column, f);
  }

  const wrap = document.createElement('div');
  wrap.className = 'cal';

  const head = document.createElement('div');
  head.className = 'cal-hd';
  head.setAttribute('aria-hidden', 'true');
  for (const text of ['Measurement', ...CAL_ORDER.map((c) => CAL_HEADINGS[c])]) {
    const cell = document.createElement('span');
    cell.textContent = text;
    head.append(cell);
  }
  wrap.append(head);

  for (const [, row] of rows) {
    const tr = document.createElement('div');
    tr.className = 'cal-row';

    // The measurement's own name, as the document prints it. Taken from
    // whichever of the row's two fields is present, so the panel and the sheet
    // cannot name the same measurement differently.
    const name = row.get('reading')?.label ?? row.get('result')?.label ?? '';
    const nameEl = document.createElement('span');
    nameEl.className = 'cal-name';
    nameEl.textContent = name;
    tr.append(nameEl);

    for (const column of CAL_ORDER) {
      const f = row.get(column);
      if (!f) { tr.append(document.createElement('span')); continue; }
      const value = values.get(f.field_key) ?? '';
      const label = `${CAL_HEADINGS[column]}, ${name}`;

      if (isLocked) {
        const p = document.createElement('p');
        p.className = 'cal-ro';
        p.textContent = value || '—';
        tr.append(p);
        continue;
      }

      const allowed = optionsOf(f);
      if (allowed.length) {
        // The document prints one box per answer and a technician ticks one,
        // so the control offers exactly those answers. The blank option is
        // what an unanswered measurement is, and is how one is un-answered
        // again after a mistake — without it the first click would be
        // irreversible.
        const select = document.createElement('select');
        select.id = `f-${f.field_key}`;
        select.setAttribute('aria-label', label);
        for (const text of ['', ...allowed]) {
          const opt = document.createElement('option');
          opt.value = text;
          opt.textContent = text || '—';
          if (text === value) opt.selected = true;
          select.append(opt);
        }
        // A select commits on change; there is no half-typed state to mirror
        // separately, so the preview and the save are driven by the one event.
        select.addEventListener('change', () => {
          if (preview) preview(f.field_key, select.value);
          change(f.field_key, select.value);
        });
        tr.append(select);
        continue;
      }

      const input = document.createElement('input');
      input.id = `f-${f.field_key}`;
      input.value = value;
      input.setAttribute('aria-label', label);
      if (preview) input.addEventListener('input', () => preview(f.field_key, input.value));
      input.addEventListener('change', () => change(f.field_key, input.value));
      tr.append(input);
    }
    wrap.append(tr);
  }
  return wrap;
}

// `locked` and `canSign` are deliberately separate flags — a deviation from
// the brief, which used a single `locked` to gate both the general record
// fields (machine_id/task/remarks) AND signature-pad availability via
// `stage === currentUser.role && !locked`. That conflates two different
// questions: "are the record's already-entered fields read-only right now"
// and "is it this user's turn to sign". A team leader reviewing a
// pending_lead record needs the FIRST to be true (the technician's fields
// must render as read-only text, per the explicit behavioural requirement)
// and the SECOND to also be true (they must still get a signature pad) —
// the brief's single flag cannot express that combination. The caller
// (app.js) computes both from the submission's actual stage-ownership rule.
export function renderFields(container, { snapshot, values, signatures, frequencies,
                                          selectedFrequency, locked, canSign, currentUser,
                                          completeness, rejections, state, onChange, onPreview,
                                          onFrequencyChange }) {
  teardownActivePad();
  container.replaceChildren();
  container.pads = {};
  const byKey = new Map((values ?? []).map((v) => [v.field_key, v.value]));
  const signed = new Map((signatures ?? []).map((s) => [s.stage, s]));

  // WHY the record came back, before anything else on the panel. A technician
  // who cannot see the reason cannot act on it, so this sits above the
  // interval selector and every field rather than below them where it would
  // be scrolled past on a phone. Only while the record is actually `rejected`:
  // once it has been resubmitted the history belongs on the archived PDF, not
  // in the way of the person filling it in.
  if (state === 'rejected' && rejections?.length) {
    const sec = section('Sent back for correction');
    sec.className = 'sec sec-rejected';
    for (const r of rejections) {
      const item = document.createElement('div');
      item.className = 'reject-note';

      const who = document.createElement('p');
      who.className = 'reject-who';
      who.textContent = `${r.full_name || 'A reviewer'} · ${stageLabel(r.stage)}`;
      item.append(who);

      const when = document.createElement('p');
      when.className = 'reject-when';
      when.textContent = new Date(r.rejected_at).toLocaleString();
      item.append(when);

      const why = document.createElement('p');
      why.className = 'reject-why';
      why.textContent = r.reason;
      item.append(why);

      sec.append(item);
    }
    container.append(sec);
  }

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

  // Warn, never block: a quiet, non-blocking count of in-scope tasks with
  // no status yet. Submitting must still work with tasks unfilled — this
  // banner is advisory only and never disables anything.
  if (completeness && completeness.missing?.length) {
    const sec = section('Completeness');
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = `${completeness.missing.length} of ${completeness.inScope} tasks have no status.`;
    sec.append(p);
    container.append(sec);
  }

  const groups = new Map();
  for (const f of snapshot) {
    if (!groups.has(f.section)) groups.set(f.section, []);
    groups.get(f.section).push(f);
  }

  for (const [name, fields] of groups) {
    const sec = section(name);
    // The Parts Required table is rendered as a table, not as N separate
    // fields — see partsGrid() below for why. Anything else in the same
    // section still renders through the ordinary path underneath it.
    const partFields = fields.filter((f) => partsKeyOf(f.field_key));
    if (partFields.length) sec.append(partsGrid(partFields, byKey, locked, onChange, onPreview));

    // The Calibration Record is a table for the same reasons — see calGrid.
    const calFields = fields.filter((f) => calKeyOf(f.field_key));
    if (calFields.length) sec.append(calGrid(calFields, byKey, locked, onChange, onPreview));

    for (const f of fields) {
      if (partsKeyOf(f.field_key) || calKeyOf(f.field_key)) continue;
      if (f.kind === 'signature') {
        const stage = f.field_key.replace('sig_', '');
        const wrap = document.createElement('div');
        wrap.className = 'fld';
        // A real <label> so it picks up the existing `.fld label` rule
        // (muted, small caption styling) rather than introducing a
        // near-duplicate `.fld-label` class for the same visual role.
        const label = document.createElement('label');
        label.textContent = f.label;
        wrap.append(label);
        const done = signed.get(stage);
        if (done) {
          // Locked stage: plain text plus the stored signature image,
          // signer name and server timestamp — never a disabled input.
          //
          // The image is only present when the server is willing to show this
          // reader that stage's ink (its own signer, or an admin — see
          // server/routes.js). Attribution is always returned, so a withheld
          // image loses the ink and nothing else: who signed and when stay
          // fully legible, rather than rendering a broken image element.
          if (done.image_png) {
            const img = document.createElement('img');
            img.src = done.image_png;
            img.alt = `Signature of ${done.full_name}`;
            img.className = 'sig-done';
            wrap.append(img);
          }
          const meta = document.createElement('p');
          meta.className = 'sig-meta';
          meta.textContent = `${done.full_name} · ${new Date(done.signed_at).toLocaleString()}`;
          wrap.append(meta);
        } else if (stage === currentUser.role && canSign) {
          const pad = document.createElement('div');
          wrap.append(pad);
          const created = createSignaturePad(pad, { name: currentUser.full_name });
          wrap.pad = created;
          activePad = created;
          container.pads[stage] = created;
        } else {
          const waiting = document.createElement('p');
          waiting.className = 'sig-meta';
          waiting.textContent = 'Not yet signed';
          wrap.append(waiting);
        }
        sec.append(wrap);
        continue;
      }
      sec.append(textField(f, byKey.get(f.field_key) ?? '', locked, onChange, onPreview));
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
  // Reads as a role, not as a state name: "Team leader" is who sent it back,
  // which is what the technician needs, whereas "pending_lead" is internal
  // vocabulary.
  function stageLabel(stage) {
    return ({ team_leader: 'Team leader', engineer: 'Engineer' })[stage] || String(stage ?? '').replace('_', ' ');
  }
  // `change` saves (one request, on blur/commit — unchanged). `preview` is
  // display only and never touches the network: it mirrors what is being
  // typed into the left-hand sheet as it is typed, which is the whole point
  // of showing the form beside the fields. Keeping them separate is what
  // stops a live preview from turning into a PATCH per keystroke.
  function textField(f, value, isLocked, change, preview) {
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
      if (preview) input.addEventListener('input', () => preview(f.field_key, input.value));
      input.addEventListener('change', () => change(f.field_key, input.value));
      wrap.append(input);
    }
    return wrap;
  }
}
