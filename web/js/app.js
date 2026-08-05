import { api } from './api.js';
import { renderForm, updatePreviewField, updatePreviewInterval } from './form-view.js';
import { renderFields, teardownFieldPanel } from './field-panel.js';

const $ = (s) => document.querySelector(s);
let user = null, formId = null, submission = null, frequency = '';

// ---------------------------------------------------------------------------
// Fill in / Form tabs — the mobile view switcher.
//
// Below the `lg` breakpoint `.split` is a single column, so the two panes
// stacked in DOM order: the form first, the fields underneath it. A real
// form's grid is 71 rows, so on a phone the technician scrolled past an
// entire spreadsheet before reaching the first input — the reported "I cannot
// see the filling up fields and only see the Preview". Reordering alone would
// not have fixed it (the grid would still sit in the same scroll), so only
// one pane is shown at a time and a tab chooses which.
//
// Three properties this implementation is built around:
//  1. It NEVER re-renders. selectTab() writes attributes only — no
//     renderFields(), no renderForm(), no paint(). The signature pad is
//     therefore never destroyed and recreated by a tab switch (which would
//     leak listeners and could clear a drawn signature), and no in-progress
//     input is lost: the DOM nodes holding it are the same nodes throughout.
//     Hiding is done in CSS, on the pane the technician is not looking at.
//  2. It is inert above the breakpoint. `DESKTOP` is consulted on every
//     apply, so at >=1024px the bar is hidden AND every tab/tabpanel role is
//     removed — the desktop two-pane layout keeps precisely the semantics it
//     had before tabs existed, rather than being a tablist with no visible
//     tabs.
//  3. It exists only where there are two panes to switch between. The tabs
//     are bound to the left pane's own presence (expandPaneLeft /
//     collapsePaneLeft), so the picker and queue screens — where
//     collapsePaneLeft() already hides the form pane — never show them.
const DESKTOP = window.matchMedia('(min-width:1024px)');
// Which pane the switcher is showing. Reset to 'fill' when a record is
// opened (the fields are the working surface), but deliberately NOT on every
// paint(): a repaint after a save or an interval change must not yank a
// technician off the form pane they were reading.
let activeTab = 'fill';
// Whether this screen has two panes at all. Set from expandPaneLeft() /
// collapsePaneLeft() so it can never disagree with what is on screen.
let tabsEnabled = false;

const TAB_PANES = { fill: '#pane-right', form: '#pane-left' };
const TAB_IDS = { fill: 'tab-fill', form: 'tab-form' };
const TAB_ORDER = ['fill', 'form'];

// The single place that reconciles the DOM with (tabsEnabled, viewport,
// activeTab). Called whenever any of the three changes.
function applyTabs() {
  const bar = $('#pane-tabs');
  const split = $('.split');
  const panes = { fill: $(TAB_PANES.fill), form: $(TAB_PANES.form) };
  const on = tabsEnabled && !DESKTOP.matches;
  bar.hidden = !on;

  if (!on) {
    // No data-tab attribute means neither pane is hidden by the tab rules in
    // app.css, and no tabpanel role is left behind pointing at a tab that is
    // not on screen.
    split.removeAttribute('data-tab');
    for (const pane of Object.values(panes)) {
      pane.removeAttribute('role');
      pane.removeAttribute('aria-labelledby');
    }
    return;
  }

  split.dataset.tab = activeTab;
  for (const name of TAB_ORDER) {
    const pane = panes[name];
    pane.setAttribute('role', 'tabpanel');
    // aria-labelledby (the tab's own text) supersedes the pane's static
    // aria-label; the two say the same thing, so nothing is renamed.
    pane.setAttribute('aria-labelledby', TAB_IDS[name]);
    const btn = $(`#${TAB_IDS[name]}`);
    const selected = name === activeTab;
    btn.setAttribute('aria-selected', String(selected));
    // Roving tabindex: one stop in the page tab order for the whole tablist,
    // with the arrow keys moving between the tabs themselves (WAI-ARIA
    // tabs pattern).
    btn.tabIndex = selected ? 0 : -1;
  }
}

function setTabsEnabled(on) {
  tabsEnabled = on;
  if (!on) resetOutstanding();
  applyTabs();
}

// Attribute writes only — nothing is rendered, nothing is replaced.
function selectTab(name, { focus = false } = {}) {
  if (!TAB_ORDER.includes(name)) return;
  activeTab = name;
  applyTabs();
  if (focus) $(`#${TAB_IDS[name]}`).focus();
}

// The outstanding-task count shown on the Fill in tab, e.g. "Fill in · 18
// left" — the same number the completeness banner states, so a technician
// sitting on the form pane can see there is work left without switching.
//
// `completeness.missing` (server-computed, the banner's own source) seeds it;
// `spec.inScope` gives the in-scope task rows, whose field keys are
// `task_<row>` exactly as server/workflow.js's completenessFor() builds them.
// Knowing that set is what lets the count follow typing without another
// request: a key outside it can never change the count.
let inScopeTaskKeys = new Set();
let outstandingKeys = new Set();

function setOutstanding(spec) {
  inScopeTaskKeys = new Set((spec?.inScope ?? []).map((row) => `task_${row}`));
  outstandingKeys = new Set(spec?.completeness?.missing ?? []);
  paintOutstanding();
}

function resetOutstanding() {
  inScopeTaskKeys = new Set();
  outstandingKeys = new Set();
  paintOutstanding();
}

// Same "non-empty after trimming" rule as completenessFor(), so the tab and
// the banner can never disagree about whether a task counts as filled.
function noteFieldValue(key, value) {
  if (!inScopeTaskKeys.has(key)) return;
  const before = outstandingKeys.size;
  if (String(value ?? '').trim() === '') outstandingKeys.add(key);
  else outstandingKeys.delete(key);
  if (outstandingKeys.size !== before) paintOutstanding();
}

function paintOutstanding() {
  const note = $('#tab-fill-note');
  if (!note) return;
  note.textContent = outstandingKeys.size ? `· ${outstandingKeys.size} left` : '';
}

// Bound once, at module load, against markup that is static in index.html —
// so no listener is ever added twice and none needs tearing down.
for (const name of TAB_ORDER) {
  $(`#${TAB_IDS[name]}`).addEventListener('click', () => selectTab(name));
}
// Enter and Space are the browser's own activation for a <button>, so they
// already reach the click handler above. This adds the rest of the WAI-ARIA
// tabs keyboard contract: arrow keys (with automatic activation, the standard
// behaviour for tabs whose panels are already in the document) plus Home/End.
$('#pane-tabs').addEventListener('keydown', (e) => {
  const keys = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
  let next = null;
  if (e.key in keys) {
    const i = TAB_ORDER.indexOf(activeTab);
    next = TAB_ORDER[(i + keys[e.key] + TAB_ORDER.length) % TAB_ORDER.length];
  } else if (e.key === 'Home') next = TAB_ORDER[0];
  else if (e.key === 'End') next = TAB_ORDER[TAB_ORDER.length - 1];
  if (!next) return;
  e.preventDefault();
  selectTab(next, { focus: true });
});
// A rotation or a window drag across the breakpoint must land in a coherent
// state: both panes and no tabs above it, one pane and the tabs below.
//
// Note what does NOT depend on this listener: which panes are VISIBLE is
// decided entirely in app.css (the `.split[data-tab]` rules and their `lg`
// overrides), so even if this never fired, no pane could be left hidden at
// desktop width or shown at both widths on mobile. What it reconciles is the
// ARIA layer — the tab/tabpanel roles, which must not survive into a width
// where the tablist itself is not rendered.
DESKTOP.addEventListener('change', applyTabs);

// Mirrors the server's stage-ownership rule (server/workflow.js
// assertStageOwnership) for UI purposes only. The server remains the sole
// source of truth and enforces this independently on every PATCH/sign
// request (403 on failure) — this client-side copy only decides, before any
// request is made, whether to show editable inputs vs. read-only text for
// the general record fields and whether to offer a signature pad for the
// current user's own stage. If the two ever disagree, the server wins and
// the failure is surfaced verbatim (see addSubmitBar / the save handler).
// `rejected` is a technician stage, exactly as it is in server/workflow.js's
// STAGES table: a rejected record has come back to whoever created it and is
// theirs to correct, re-sign and resubmit. TECHNICIAN_STATES is what the
// ownership check below and the editability rule in paint() both read, so the
// two can never disagree about which states the technician holds.
const STAGE_ACTOR = {
  draft: 'technician', rejected: 'technician',
  pending_lead: 'team_leader', pending_engineer: 'engineer'
};
const TECHNICIAN_STATES = new Set(
  Object.entries(STAGE_ACTOR).filter(([, actor]) => actor === 'technician').map(([state]) => state)
);
// The two states a reviewer may reject FROM, mirroring the server's own
// REJECTABLE_STATES. Used only to decide whether to OFFER the control — the
// route enforces the real rule and returns 403 regardless of what is shown.
const REJECTABLE_STATES = new Set(['pending_lead', 'pending_engineer']);

function isCurrentActor(sub) {
  if (sub.state === 'approved') return false;
  const actor = STAGE_ACTOR[sub.state];
  if (actor !== user.role) return false;
  if (TECHNICIAN_STATES.has(sub.state) && sub.created_by !== user.id) return false;
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

// The only way from this app to web/admin.html (forms folder, user
// management, PDF field mapper) — there was previously no link anywhere,
// so those screens were reachable only by typing the URL by hand. Admin
// only: every other role has no admin actions, and the server's own
// GET /api/admin/* routes reject them regardless. Placed in the control
// strip beside Sign out (see #control-strip .navlink in app.css), since
// that strip is the one thing present on every screen this app shows once
// signed in.
function adminLinkButton() {
  const a = document.createElement('a');
  a.className = 'navlink';
  a.href = '/admin.html';
  a.textContent = 'Admin';
  return a;
}

// The picker screen (showPicker) never puts anything in `#pane-left` — the
// technician's queue and form list both render into `#pane-right` — but
// app.css's `.split` rule still reserved 76vh of blank white for it, sitting
// ABOVE the list in the mobile single-column layout: the "large white panel
// that shows nothing" the end user reported, and the reason the list's first
// (and only visible, below that void) entry read as the only form that
// existed. Collapsing is done from script, not left to an `:empty`/`:has()`
// selector, so it happens at the exact moments the DOM state is known here —
// right when the pane is cleared, and undone the moment paint() gives it the
// form again — rather than depending on a CSS selector feature being
// supported. `.split--list` goes on the pane's own `.split` parent (not just
// `#pane-left`) because collapsing the pane isn't enough on its own: the `lg`
// breakpoint's `grid-template-columns:1fr 400px` would otherwise still
// reserve a 400px track for a now-hidden element.
function collapsePaneLeft() {
  const left = $('#pane-left');
  left.replaceChildren();
  // The pane's cell map refers to <td>s that have just been detached. Drop it
  // with them, so a stray live update can never write into an orphaned tree.
  left.preview = null;
  left.classList.add('is-empty');
  left.closest('.split')?.classList.add('split--list');
  // No form pane means nothing to switch between: the picker and the queue
  // are one pane of content, so the tab bar must not appear there. Bound to
  // the pane's own collapse/expand rather than to a list of screen names, so
  // a future screen that collapses the left pane gets this for free and
  // cannot forget it.
  setTabsEnabled(false);
}

function expandPaneLeft() {
  const left = $('#pane-left');
  left.classList.remove('is-empty');
  left.closest('.split')?.classList.remove('split--list');
  setTabsEnabled(true);
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
  // Who is signed in, and the way out — the list screen needs both just as
  // much as an open record does.
  $('#control-strip').replaceChildren(
    chip(`${user.full_name} · ${user.role.replace('_', ' ')}`),
    ...(user.role === 'admin' ? [adminLinkButton()] : []),
    signOutButton()
  );
  collapsePaneLeft();
  const right = $('#pane-right');
  right.replaceChildren();

  const forms = await api.forms();
  const formsById = new Map(forms.map((f) => [f.id, f]));

  if (user.role === 'technician') {
    const queue = await api.queue();

    const sec = section('Choose a form');
    if (!forms.length) sec.append(emptyNotice('No forms are set up yet. Ask an admin to add one.'));
    for (const f of forms) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'form-pick catalog-row';

      const titleEl = document.createElement('span');
      titleEl.className = 'catalog-title';
      titleEl.textContent = f.title || f.file_name;

      const docEl = document.createElement('span');
      docEl.className = 'catalog-doc';
      // The controlled-document code, not just the title: several titles are
      // near-identical ("Preventive Maintenance Record EP01" vs "PM01") and
      // the code in monospace is what actually distinguishes one form from
      // another for a technician scanning a list of 12 on a phone screen.
      docEl.textContent = `${f.doc_number || '—'} · Rev ${f.revision || '—'}`;

      b.append(titleEl, docEl);
      b.addEventListener('click', () => startNew(f.id));
      sec.append(b);
    }

    const queueSec = queueSection('Your records', queue, formsById, 'You have no records yet.');
    // A returning technician with records in flight is most likely here to
    // resume one, so the queue stays first when it actually has content
    // (unchanged from before). But when it is empty, leading with it just
    // means leading with an empty-state notice sitting above the one thing
    // every technician CAN do on this screen — pick a form and start —
    // which is exactly the "large blank panel with nothing in it" complaint
    // one level down. With no records to resume, the form list is the
    // obvious primary action, so it goes first instead.
    if (queue.length) right.append(queueSec, sec);
    else right.append(sec, queueSec);
  } else {
    // Team leaders, engineers and admins never create records — only the
    // queue is shown for them.
    const queue = await api.queue();
    const title = user.role === 'admin' ? 'All records' : 'Records awaiting you';
    const queueSec = queueSection(title, queue, formsById, 'Nothing waiting.');
    // Admins additionally get the read-only form catalog on this same
    // landing screen — this is the fix for the reported gap: an admin
    // signing in previously saw only this queue (headed "All records"),
    // with the 12 indexed forms visible nowhere on it, and reasonably
    // concluded the forms were missing even though GET /api/forms confirmed
    // all 12 as `ready` all along. Below the queue (the queue is still what
    // a returning admin most likely wants first), never above it.
    right.append(queueSec, ...(user.role === 'admin' ? [catalogSection(forms)] : []));
  }
}

// Read-only form catalog for an admin's landing screen — the same 12
// indexed forms a technician's "Choose a form" picker shows above, but with
// no click handler and no button semantics: admins never start a new
// record (POST /api/submissions is restricted to technicians), so nothing
// here should look pressable. GET /api/forms already returns every form for
// an admin caller, including non-ready ones (server-confirmed), so each
// row's own state chip is shown — the one thing genuinely useful to this
// role that a technician's picker (ready-only) has no reason to surface:
// spotting a form stuck at `needs_setup` or gone `inactive` at a glance.
// The heading states the count explicitly, e.g. "Indexed forms (12)" —
// answering the reported complaint ("I do not see 12 forms") without
// making the admin count rows themselves.
function catalogSection(forms) {
  const sec = section(`Indexed forms (${forms.length})`);
  if (!forms.length) {
    sec.append(emptyNotice('No forms are indexed yet.'));
    return sec;
  }
  for (const f of forms) {
    const row = document.createElement('div');
    row.className = 'catalog-row catalog-row--static';

    const titleEl = document.createElement('span');
    titleEl.className = 'catalog-title';
    titleEl.textContent = f.title || f.file_name;

    const docEl = document.createElement('span');
    docEl.className = 'catalog-doc';
    // Same reasoning as the technician picker's own doc/rev line: several
    // titles are near-identical, and the controlled-document code is what
    // actually tells them apart.
    docEl.textContent = `${f.doc_number || '—'} · Rev ${f.revision || '—'}`;

    const stateEl = document.createElement('span');
    stateEl.className = 'state';
    stateEl.dataset.state = f.state;
    stateEl.textContent = f.state.replace('_', ' ');

    row.append(titleEl, docEl, stateEl);
    sec.append(row);
  }
  return sec;
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
    // The record's OWN document number and revision — the ones stamped on it
    // when it was created — so a later revision of the source form cannot
    // relabel a record that was worked against the old one. The catalog row
    // is only a fallback for records created before those were recorded.
    docEl.textContent =
      `${s.doc_number || f?.doc_number || '—'} · Rev ${s.revision || f?.revision || '—'}`;

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
  // A record always opens on the fields: that is the technician's working
  // surface, and the form beside it is reference material.
  activeTab = 'fill';
  await paint();
}

async function openExisting(sub) {
  submission = sub;
  formId = sub.form_id;
  frequency = sub.frequency || '';
  activeTab = 'fill';
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

  // Same rule as the queue rows: the record states the document identity it
  // was created against, not whatever the catalog says today, so the screen
  // and the archived PDF can never disagree about which revision was worked.
  const sub = detail.submission;
  $('#control-strip').replaceChildren(
    chip(sub.doc_number || form.doc_number || form.file_name),
    chip(`Rev ${sub.revision || form.revision || '—'}`),
    chip(`${user.full_name} · ${user.role.replace('_', ' ')}`), stateChip(detail.submission.state),
    ...(user.role === 'admin' ? [adminLinkButton()] : []),
    signOutButton()
  );

  // The empty-scope call site: inScopeRows is `null` ONLY when there is
  // genuinely no filter (no frequency chosen yet). Whenever a frequency IS
  // selected, the real array from the server is passed through as-is, even
  // when it is empty (a frequency that covers zero tasks on this form) —
  // never coerced to null to "make it work". form-view.js relies on exactly
  // that distinction: null means dim nothing, an empty array means dim every
  // task row, because none of them apply to this visit.
  expandPaneLeft();
  // Seeds the "Fill in · N left" count on the tab from the same server-computed
  // completeness the banner below uses, and records which field keys can move
  // it as the technician types.
  setOutstanding(spec);
  // The record's own values go into the sheet, in the cells the server says
  // they belong in (spec.cellFor / spec.titleCell — see server/cell-map.js).
  // Without these the left pane is a preview of a BLANK form while everything
  // typed lives only in the right-hand panel, which is exactly the gap the
  // end user reported: a machine ID they had entered was nowhere on the
  // sheet beside them. The machine ID is read from the record's own field
  // value, falling back to the column saveFields keeps in step with it.
  const machineId = detail.values.find((v) => v.field_key === 'machine_id')?.value ?? sub.machine_id ?? '';
  renderForm($('#pane-left'), form, {
    grid, inScopeRows: frequency ? spec.inScope : null,
    values: detail.values, cellFor: spec.cellFor, titleCell: spec.titleCell,
    machineId, signatures: detail.signatures,
    // Which printed option of the frequency band this visit covers, ringed on
    // the sheet the way it is ringed on paper. Read straight from the record's
    // own interval, so an approved record shows the interval that was
    // recorded and a draft shows what is selected now.
    intervalCells: spec.intervalCells, selectedInterval: frequency
  });

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
    // free to edit the previous stage's already-entered data. A `rejected`
    // record is unlocked for the same reason a draft is — it is back with its
    // technician, carries no signatures at all, and exists precisely to be
    // corrected.
    locked: !(TECHNICIAN_STATES.has(detail.submission.state) && canAct),
    // Signature-pad availability is a SEPARATE question from the above: a
    // team leader/engineer must still get a pad on their own stage even
    // though the general fields are locked for them.
    canSign: canAct,
    currentUser: user,
    completeness: spec.completeness,
    // Why the record came back, shown above the fields while it is rejected.
    rejections: detail.rejections,
    state: detail.submission.state,
    // Typing, mirrored into the sheet with no request at all. Only the one
    // cell that changed is rewritten — never the whole grid, which on a
    // 71-row form would mean rebuilding hundreds of cells per keystroke (see
    // updatePreviewField in form-view.js).
    onPreview: (key, value) => {
      updatePreviewField($('#pane-left'), key, value);
      // Keeps the tab's outstanding count honest while the technician is on
      // the Fill in tab, so that when they switch to Form it already reads
      // the right number. Local arithmetic over a known key set — no request.
      noteFieldValue(key, value);
    },
    onChange: async (key, value) => {
      // Also applied here, not only on `input`: `change` is what fires for a
      // value committed without typing (autofill, paste-and-blur), and the
      // preview must not miss those.
      updatePreviewField($('#pane-left'), key, value);
      noteFieldValue(key, value);
      try {
        await api.save(submission.id, { [key]: value });
        saveError.textContent = '';
      } catch (err) {
        // Surface the server's own error message verbatim — never invent
        // client-side wording for a server-side failure.
        saveError.textContent = err.message;
      }
    },
    // The chosen interval is persisted, not just repainted: the stored value
    // is what the team leader is later shown, what the completeness warning
    // counts against, and what the archived PDF header prints. It is only
    // sent while the record is the technician's own (draft or rejected — a
    // rejected record carries no signatures, so re-scoping it re-scopes
    // nothing anyone has signed) — the server refuses it afterwards, and a
    // reviewer's local scope-preview must not fire a request that would 403.
    onFrequencyChange: async (f) => {
      if (TECHNICIAN_STATES.has(detail.submission.state) && canAct) {
        try {
          await api.setFrequency(submission.id, f);
          submission = { ...submission, frequency: f };
        } catch (err) {
          // Surfaced verbatim, and the selection is NOT adopted locally —
          // the panel must never show a scope the record does not carry.
          saveError.textContent = err.message;
          return;
        }
      }
      // The ring moves the moment the selection is settled, straight into the
      // sheet already on screen — one lookup and two text nodes, no request
      // and no rebuild of the 71-row grid (see updatePreviewInterval). The
      // repaint below still follows, because the row dimming and the
      // completeness count are computed by the server for the new interval;
      // the mark itself does not wait for it.
      updatePreviewInterval($('#pane-left'), f);
      frequency = f;
      await paint();
    }
  });

  $('#pane-right').append(saveError);
  addBackBar();
  addSubmitBar(detail.submission, canAct);
  addPdfBar(detail.submission, detail.signatures);
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
    if (REJECTABLE_STATES.has(sub.state)) bar.append(rejectControl(sub, msg));
  } else {
    const actor = STAGE_ACTOR[sub.state];
    msg.textContent = actor ? `Waiting on ${actor.replace('_', ' ')}.` : '';
  }
  bar.append(msg);
  right.append(bar);
}

// Send the record back to the technician, beside Sign and submit and only for
// the reviewer whose stage it currently is — addSubmitBar only reaches here
// when canAct is true and the record is sitting in one of the two review
// states.
//
// The reason is mandatory, and this is the client half of that rule: with the
// box empty the Reject button does nothing except say why, out loud, in the
// same alert region the sign path already uses. A silent no-op would read as
// a broken button. The server enforces the rule independently (400 with its
// own wording), so a reviewer who defeats this check still cannot land a
// rejection the technician has nothing to act on.
function rejectControl(sub, msg) {
  const wrap = document.createElement('div');
  wrap.className = 'reject';

  const id = `reject-reason-${sub.id}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = 'Reason for sending back (required)';
  wrap.append(label);

  const reason = document.createElement('textarea');
  reason.id = id;
  reason.rows = 3;
  reason.placeholder = 'What must the technician correct?';
  wrap.append(reason);

  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'reject-go';
  reject.textContent = 'Reject and send back';
  reject.addEventListener('click', async () => {
    if (!reason.value.trim()) {
      msg.textContent = 'Give a reason before sending this record back.';
      reason.focus();
      return;
    }
    try {
      await api.reject(submission.id, reason.value);
      msg.textContent = '';
      // Repaint from the server rather than patching local state: the record
      // is now `rejected`, every signature on it is gone, and this reviewer's
      // own queue no longer holds it.
      submission = { ...submission, state: 'rejected' };
      await paint();
    } catch (err) {
      // 403 (not your stage / already acted on) or 400 (no reason) —
      // surfaced verbatim, never re-worded.
      msg.textContent = err.message;
    }
  });
  wrap.append(reject);
  return wrap;
}

// Preview/download links, shown only when this rule — mirroring the server's
// own GET /api/submissions/:id/pdf check (server/routes.js) — says the
// signed-in user is allowed to have the PDF at all: an admin always; a team
// leader or engineer only once THEIR OWN signature row exists on this
// record. A technician never matches either branch, even though their own
// stage signature exists once they've submitted — the server refuses them
// unconditionally, and hiding the control here just avoids sending them
// somewhere they'd immediately get a 403. This is a convenience, not the
// access control — the route enforces the real rule independently.
function addPdfBar(sub, signatures) {
  const canPreview = user.role === 'admin'
    || ((user.role === 'team_leader' || user.role === 'engineer') &&
        (signatures ?? []).some((s) => s.stage === user.role));
  if (!canPreview) return;

  const right = $('#pane-right');
  const bar = document.createElement('div');
  bar.className = 'pdf-actions';

  const preview = document.createElement('a');
  preview.href = api.submissionPdfUrl(sub.id);
  preview.target = '_blank';
  preview.rel = 'noopener';
  preview.textContent = 'Preview PDF';
  bar.append(preview);

  // Archival download: engineer only, and only once the record has actually
  // reached 'approved' — which, per server/workflow.js's STAGES table, is
  // exactly the state an engineer's own signature always produces.
  if (user.role === 'engineer' && sub.state === 'approved') {
    const download = document.createElement('a');
    download.href = api.submissionPdfDownloadUrl(sub.id);
    download.className = 'download';
    download.textContent = 'Download for archive';
    bar.append(download);
  }

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

// A shop-floor tablet with no way out stays signed in as whoever used it
// first, and the next person's signature is then attributed to them — the one
// thing a quality record must never do. The control lives in the control
// strip, present on every screen this app shows once signed in.
function signOutButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'signout';
  b.textContent = 'Sign out';
  b.addEventListener('click', signOut);
  return b;
}

async function signOut() {
  // The session is being abandoned either way: even if the request fails,
  // this browser must not keep showing the previous user's records.
  try { await api.logout(); } catch { /* fall through to clearing the UI */ }
  teardownFieldPanel();
  user = null; formId = null; submission = null; frequency = '';
  $('#control-strip').replaceChildren();
  collapsePaneLeft();
  $('#pane-right').replaceChildren();
  $('#app').hidden = true;
  $('#login-error').textContent = '';
  $('#login').reset();
  $('#login').hidden = false;
}

boot();
