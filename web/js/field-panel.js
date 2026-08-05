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
                                          completeness, rejections, state, onChange, onFrequencyChange }) {
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
    for (const f of fields) {
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
  // Reads as a role, not as a state name: "Team leader" is who sent it back,
  // which is what the technician needs, whereas "pending_lead" is internal
  // vocabulary.
  function stageLabel(stage) {
    return ({ team_leader: 'Team leader', engineer: 'Engineer' })[stage] || String(stage ?? '').replace('_', ' ');
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
