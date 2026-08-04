import { api } from './api.js';
import { renderForm } from './form-view.js';
import { renderFields, teardownFieldPanel } from './field-panel.js';

const $ = (s) => document.querySelector(s);
let user = null, formId = null, submission = null, frequency = '';

// Mirrors the server's stage-ownership rule (server/workflow.js
// assertStageOwnership) for UI purposes only. The server remains the sole
// source of truth and enforces this independently on every PATCH/sign
// request (403 on failure) — this client-side copy only decides, before any
// request is made, whether to show editable inputs vs. read-only text for
// the general record fields and whether to offer a signature pad for the
// current user's own stage. If the two ever disagree, the server wins and
// the failure is surfaced verbatim (see addSubmitBar / the save handler).
const STAGE_ACTOR = { draft: 'technician', pending_lead: 'team_leader', pending_engineer: 'engineer' };
function isCurrentActor(sub) {
  if (sub.state === 'approved') return false;
  const actor = STAGE_ACTOR[sub.state];
  if (actor !== user.role) return false;
  if (sub.state === 'draft' && sub.created_by !== user.id) return false;
  return true;
}

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

function section(title) {
  const s = document.createElement('div');
  s.className = 'sec';
  const h = document.createElement('h3');
  h.textContent = title;
  s.append(h);
  return s;
}

function emptyNotice(text) {
  const p = document.createElement('p');
  p.className = 'sig-meta';
  p.textContent = text;
  return p;
}

// Deviation from the brief: the brief's showPicker() only ever lists forms
// to start a NEW draft, via POST /api/submissions — a route restricted to
// technicians (server/routes.js: requireRole('technician')). That leaves no
// way for a team leader or engineer to reach the record waiting for their
// signature, even though the brief's own hand-verification steps (2 and 3)
// require exactly that ("the record appears in the queue"). This picker
// branches on role: everyone browses GET /api/submissions (their real
// queue) and opens an EXISTING record by id, never creating a new one from
// it; technicians ADDITIONALLY get a "Choose a form" section below their
// queue, since they are the only role that ever starts a fresh draft. A
// technician who starts a draft and closes the browser must be able to get
// back to it — GET /api/submissions already returns exactly their own
// records in any state (server/workflow.js queueFor) — so their queue is
// shown FIRST, above the new-draft picker, since a returning technician is
// most likely here to resume something, not start over.
async function showPicker() {
  teardownFieldPanel();
  formId = null; submission = null; frequency = '';
  $('#control-strip').replaceChildren();
  $('#pane-left').replaceChildren();
  const right = $('#pane-right');
  right.replaceChildren();

  const forms = await api.forms();
  const formsById = new Map(forms.map((f) => [f.id, f]));

  if (user.role === 'technician') {
    const queue = await api.queue();
    right.append(queueSection('Your records', queue, formsById, 'You have no records yet.'));

    const sec = section('Choose a form');
    if (!forms.length) sec.append(emptyNotice('No forms are set up yet. Ask an admin to add one.'));
    for (const f of forms) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'form-pick';
      b.textContent = f.title || f.file_name;
      b.addEventListener('click', () => startNew(f.id));
      sec.append(b);
    }
    right.append(sec);
  } else {
    // Team leaders, engineers and admins never create records — only the
    // queue is shown for them.
    const queue = await api.queue();
    const title = user.role === 'admin' ? 'All records' : 'Records awaiting you';
    right.append(queueSection(title, queue, formsById, 'Nothing waiting.'));
  }
}

// A single queue row lays out the record's identity as distinct elements —
// title, document number/revision and interval code in monospace (they are
// codes), machine ID, and a state chip using the same red/unapproved ·
// green/approved rule as the control strip's chip (`.state[data-state]` in
// app.css) — rather than one concatenated string. See openExisting() for
// what a click does.
function queueSection(title, queue, formsById, emptyText) {
  const sec = section(title);
  if (!queue.length) sec.append(emptyNotice(emptyText));
  for (const s of queue) {
    const f = formsById.get(s.form_id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'form-pick queue-row';

    const titleEl = document.createElement('span');
    titleEl.className = 'queue-title';
    titleEl.textContent = f ? (f.title || f.file_name) : `Form #${s.form_id}`;

    const docEl = document.createElement('span');
    docEl.className = 'queue-doc';
    docEl.textContent = `${f?.doc_number || '—'} · Rev ${f?.revision || '—'}`;

    const machineEl = document.createElement('span');
    machineEl.className = 'queue-machine';
    machineEl.textContent = s.machine_id || '—';

    const freqEl = document.createElement('span');
    freqEl.className = 'queue-freq';
    freqEl.textContent = s.frequency || '—';

    const stateEl = document.createElement('span');
    stateEl.className = 'state';
    stateEl.dataset.state = s.state;
    stateEl.textContent = s.state.replace('_', ' ');

    b.append(titleEl, docEl, machineEl, freqEl, stateEl);
    b.addEventListener('click', () => openExisting(s));
    sec.append(b);
  }
  return sec;
}

async function startNew(pickedFormId) {
  const spec = await api.fields(pickedFormId, '');
  formId = pickedFormId;
  frequency = spec.frequencies.at(-1) || '';
  submission = await api.createSubmission(formId, '', frequency);
  await paint();
}

async function openExisting(sub) {
  submission = sub;
  formId = sub.form_id;
  frequency = sub.frequency || '';
  await paint();
}

async function paint() {
  // submissionId is passed through so the server computes `completeness`
  // (GET /api/forms/:id/fields?frequency=&submissionId=) — the brief's own
  // api.fields(id, frequency) signature never sends it, which would make
  // the "warn, never block" missing-tasks banner impossible to build.
  const spec = await api.fields(formId, frequency, submission.id);
  const detail = await api.submission(submission.id);
  const form = spec.form;
  const grid = form.file_type === 'xlsx' ? await api.grid(form.id) : null;
  const canAct = isCurrentActor(detail.submission);

  $('#control-strip').replaceChildren(
    chip(form.doc_number || form.file_name), chip(`Rev ${form.revision || '—'}`),
    chip(`${user.full_name} · ${user.role.replace('_', ' ')}`), stateChip(detail.submission.state)
  );

  // The empty-scope call site: inScopeRows is `null` ONLY when there is
  // genuinely no filter (no frequency chosen yet). Whenever a frequency IS
  // selected, the real array from the server is passed through as-is, even
  // when it is empty (a frequency that covers zero tasks on this form) —
  // never coerced to null to "make it work". See the report for why
  // form-view.js's own guard still cannot act correctly on that empty case;
  // that is a pre-existing bug in a file this task must not modify.
  renderForm($('#pane-left'), form, { grid, inScopeRows: frequency ? spec.inScope : null });

  const saveError = document.createElement('p');
  saveError.className = 'notice';
  saveError.setAttribute('role', 'alert');

  renderFields($('#pane-right'), {
    snapshot: detail.snapshot, values: detail.values, signatures: detail.signatures,
    frequencies: spec.frequencies, selectedFrequency: frequency,
    // General record fields (machine_id/task/remarks) are editable only
    // during the technician's own draft stage — once the record moves on,
    // they render as read-only text for everyone, including the technician
    // who filled them. This is stricter than the brief's
    // `locked: state === 'approved'`, which left every reviewer's stage
    // free to edit the previous stage's already-entered data.
    locked: !(detail.submission.state === 'draft' && canAct),
    // Signature-pad availability is a SEPARATE question from the above: a
    // team leader/engineer must still get a pad on their own stage even
    // though the general fields are locked for them.
    canSign: canAct,
    currentUser: user,
    completeness: spec.completeness,
    onChange: async (key, value) => {
      try {
        await api.save(submission.id, { [key]: value });
        saveError.textContent = '';
      } catch (err) {
        // Surface the server's own error message verbatim — never invent
        // client-side wording for a server-side failure.
        saveError.textContent = err.message;
      }
    },
    onFrequencyChange: async (f) => { frequency = f; await paint(); }
  });

  $('#pane-right').append(saveError);
  addBackBar();
  addSubmitBar(detail.submission, canAct);
}

function addBackBar() {
  const right = $('#pane-right');
  const bar = document.createElement('div');
  bar.className = 'sec';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'form-pick';
  b.textContent = '‹ Back to list';
  b.addEventListener('click', () => { showPicker(); });
  bar.append(b);
  right.prepend(bar);
}

function addSubmitBar(sub, canAct) {
  if (sub.state === 'approved') return; // fully read-only, nothing to act on
  const right = $('#pane-right');
  const bar = document.createElement('div');
  bar.className = 'act';
  const msg = document.createElement('p');
  msg.setAttribute('role', 'alert');
  if (canAct) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = sub.state === 'pending_engineer' ? 'Sign and approve' : 'Sign and submit';
    btn.addEventListener('click', async () => {
      const pad = right.pads?.[user.role];
      const png = pad ? pad.toPNG() : null;
      // Signature required: submitting must still work with in-scope tasks
      // left unfilled (warn, never block) — the ONLY client-side gate on
      // submit is a missing signature. The API is not called when png is
      // null.
      if (!png) { msg.textContent = 'Sign before submitting.'; return; }
      try {
        await api.sign(submission.id, png);
        msg.textContent = '';
        await paint();
      } catch (err) {
        // 403 (permission) / 400 (e.g. missing signature server-side) —
        // surfaced verbatim, never re-worded.
        msg.textContent = err.message;
      }
    });
    bar.append(btn);
  } else {
    const actor = STAGE_ACTOR[sub.state];
    msg.textContent = actor ? `Waiting on ${actor.replace('_', ' ')}.` : '';
  }
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
