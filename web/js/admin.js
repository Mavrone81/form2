import { api } from './api.js';

// Admin console: forms folder + rescan, user management, and the PDF field
// mapper. A separate page from index.html (web/admin.html), but it shares
// the same login flow and the same design tokens/classes from app.css —
// #login, #control-strip, .sec, .fld, .segs, .act, .sheet, .form-pick and
// the generic .state chip added for this task.

const $ = (s) => document.querySelector(s);
const ROLES = ['technician', 'team_leader', 'engineer', 'admin'];

let user = null;
let screen = 'folder'; // 'folder' | 'users' | 'mapper'
let mapperFormId = null;
let mapperNotice = ''; // one-shot message shown on the mapper's "choose a form" list after a save

async function boot() {
  user = await api.me();
  $('#login').hidden = Boolean(user);
  $('#app').hidden = !user;
  if (user) await paint();
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

// ---------- small DOM helpers, mirroring app.js's own ----------
function section(title) {
  const s = document.createElement('div');
  s.className = 'sec';
  if (title) {
    const h = document.createElement('h3');
    h.textContent = title;
    s.append(h);
  }
  return s;
}
function chip(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d;
}
function stateChip(value, text) {
  const s = document.createElement('span');
  s.className = 'state';
  s.dataset.state = value;
  s.textContent = text ?? value.replace('_', ' ');
  return s;
}
function noticeEl() {
  const p = document.createElement('p');
  p.className = 'notice';
  p.setAttribute('role', 'status');
  return p;
}

// Same control, same class and same behaviour as app.js's — a shared browser
// must never leave the previous user signed in, and the admin console can
// change users and form mappings, so it least of all.
function signOutButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'signout';
  b.textContent = 'Sign out';
  b.addEventListener('click', signOut);
  return b;
}

async function signOut() {
  try { await api.logout(); } catch { /* the UI is cleared either way */ }
  user = null;
  $('#control-strip').replaceChildren();
  $('#admin-nav').replaceChildren();
  $('#admin-main').replaceChildren();
  $('#app').hidden = true;
  $('#login-error').textContent = '';
  $('#login').reset();
  $('#login').hidden = false;
}

// ---------- top-level paint ----------
async function paint() {
  $('#control-strip').replaceChildren(
    chip('Admin'),
    chip(`${user.full_name} · ${user.role.replace('_', ' ')}`),
    signOutButton()
  );

  if (user.role !== 'admin') {
    $('#admin-nav').replaceChildren();
    const main = $('#admin-main');
    main.replaceChildren();
    const notice = noticeEl();
    notice.textContent = 'Your role cannot perform this action.';
    main.append(notice);
    return;
  }

  await renderScreen();
}

function renderNav() {
  const nav = $('#admin-nav');
  nav.replaceChildren();
  const sec = section(null);
  const segs = document.createElement('div');
  segs.className = 'segs';
  const tabs = [['folder', 'Forms folder'], ['users', 'Users'], ['mapper', 'Field mapper']];
  for (const [key, label] of tabs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(key === screen));
    b.addEventListener('click', () => {
      screen = key;
      if (key !== 'mapper') mapperFormId = null;
      renderScreen();
    });
    segs.append(b);
  }
  sec.append(segs);
  nav.append(sec);
}

async function renderScreen() {
  renderNav();
  const main = $('#admin-main');
  main.replaceChildren();
  if (screen === 'folder') return renderFolderScreen(main);
  if (screen === 'users') return renderUsersScreen(main);
  return renderMapperScreen(main);
}

// Jump straight into the mapper for one form (used by the folder screen's
// "needs setup" to-do list, so an admin doesn't have to pick it again from
// the mapper's own chooser).
function openMapperFor(formId) {
  screen = 'mapper';
  mapperFormId = formId;
  renderScreen();
}

// ============================================================
// Screen 1: Forms folder
// ============================================================
async function renderFolderScreen(main) {
  const settings = await api.adminSettings();

  const sec = section('Forms folder');

  const fld = document.createElement('div');
  fld.className = 'fld';
  const label = document.createElement('label');
  label.htmlFor = 'forms-folder-path';
  label.textContent = 'Folder path';
  const input = document.createElement('input');
  input.id = 'forms-folder-path';
  input.value = settings.formsFolder || '';
  fld.append(label, input);
  sec.append(fld);

  const saveWrap = document.createElement('div');
  saveWrap.className = 'act';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save and scan';
  saveWrap.append(saveBtn);

  const rescanWrap = document.createElement('div');
  rescanWrap.className = 'act';
  const rescanBtn = document.createElement('button');
  rescanBtn.type = 'button';
  rescanBtn.textContent = 'Rescan';
  rescanWrap.append(rescanBtn);

  const resultMsg = noticeEl();
  const errorMsg = noticeEl();

  sec.append(saveWrap, rescanWrap, resultMsg, errorMsg);
  main.append(sec);

  const catalogSec = section('Catalogued forms');
  main.append(catalogSec);

  function reportResult(result) {
    errorMsg.textContent = '';
    resultMsg.textContent =
      `Added ${result.added} · Updated ${result.updated} · ` +
      `Deactivated ${result.deactivated} · Failed ${result.failed}`;
  }
  function reportError(err) {
    resultMsg.textContent = '';
    // Server message verbatim, plus a separate factual statement (not a
    // rewording of the failure) that the catalog was left untouched: a
    // scan that fails to even read the folder throws before any row is
    // written, so nothing already catalogued was changed.
    errorMsg.textContent = err.message;
    const note = document.createElement('p');
    note.className = 'sig-meta';
    note.textContent = 'The existing catalog is unchanged.';
    errorMsg.append(note);
  }

  async function refreshCatalog() {
    catalogSec.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = 'Catalogued forms';
    catalogSec.append(h);

    const forms = await api.forms(); // admin -> includeAll

    // Needs-setup forms are invisible to technicians until mapped — surface
    // them as a prominent to-do list, above the general catalog.
    const todo = section('Needs setup — blocking technicians');
    const needsSetup = forms.filter((f) => f.state === 'needs_setup');
    if (!needsSetup.length) {
      const p = document.createElement('p');
      p.className = 'sig-meta';
      p.textContent = 'Nothing is waiting on field setup.';
      todo.append(p);
    } else {
      for (const f of needsSetup) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'form-pick queue-row';
        const titleEl = document.createElement('span');
        titleEl.className = 'queue-title';
        titleEl.textContent = f.title || f.file_name;
        const fileEl = document.createElement('span');
        fileEl.className = 'queue-doc code';
        fileEl.textContent = f.file_name;
        const st = stateChip('needs_setup', 'Map fields ›');
        b.append(titleEl, fileEl, st);
        b.addEventListener('click', () => openMapperFor(f.id));
        todo.append(b);
      }
    }
    catalogSec.append(todo);

    // Full catalog, every state, so an admin can see what's ready and what
    // has gone inactive since the last scan (deleted/renamed files).
    const table = document.createElement('table');
    table.className = 'sheet';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const t of ['File', 'Title', 'Doc no.', 'Rev', 'State']) {
      const th = document.createElement('th');
      th.textContent = t;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const f of forms) {
      const tr = document.createElement('tr');
      if (f.state === 'inactive') tr.className = 'row-tint';

      const fileTd = document.createElement('td');
      fileTd.className = 'code';
      fileTd.textContent = f.file_name;

      const titleTd = document.createElement('td');
      titleTd.textContent = f.title || '—';

      const docTd = document.createElement('td');
      docTd.className = 'code';
      docTd.textContent = f.doc_number || '—';

      const revTd = document.createElement('td');
      revTd.className = 'code';
      revTd.textContent = f.revision || '—';

      const stateTd = document.createElement('td');
      stateTd.append(stateChip(f.state));
      if (f.state === 'needs_setup' && f.parse_error) {
        const err = document.createElement('p');
        err.className = 'sig-meta';
        err.textContent = f.parse_error;
        stateTd.append(err);
      }

      tr.append(fileTd, titleTd, docTd, revTd, stateTd);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    // Own horizontal scroll container — same treatment as the technician
    // sheet grid (web/js/form-view.js) — so a genuinely tabular admin
    // listing pans sideways on narrow screens instead of forcing the page
    // to scroll horizontally.
    const scroller = document.createElement('div');
    scroller.className = 'table-scroll';
    scroller.append(table);
    catalogSec.append(scroller);
    if (!forms.length) {
      const p = document.createElement('p');
      p.className = 'sig-meta';
      p.textContent = 'No forms catalogued yet — set a folder and scan it above.';
      catalogSec.append(p);
    }
  }
  await refreshCatalog();

  saveBtn.addEventListener('click', async () => {
    try {
      const result = await api.updateFormsFolder(input.value.trim());
      reportResult(result);
      await refreshCatalog();
    } catch (err) {
      reportError(err);
    }
  });
  rescanBtn.addEventListener('click', async () => {
    try {
      const result = await api.rescan();
      reportResult(result);
      await refreshCatalog();
    } catch (err) {
      reportError(err);
    }
  });
}

// ============================================================
// Screen 2: Users
// ============================================================
async function renderUsersScreen(main) {
  const sec = section('New user');
  const form = document.createElement('form');

  const uFld = document.createElement('div');
  uFld.className = 'fld';
  const uLabel = document.createElement('label');
  uLabel.htmlFor = 'nu-username';
  uLabel.textContent = 'Username';
  const uInput = document.createElement('input');
  uInput.id = 'nu-username';
  uInput.required = true;
  uInput.autocomplete = 'off';
  uFld.append(uLabel, uInput);

  const pFld = document.createElement('div');
  pFld.className = 'fld';
  const pLabel = document.createElement('label');
  pLabel.htmlFor = 'nu-password';
  pLabel.textContent = 'Password';
  const pInput = document.createElement('input');
  pInput.id = 'nu-password';
  pInput.type = 'password';
  pInput.required = true;
  pInput.autocomplete = 'new-password';
  pFld.append(pLabel, pInput);

  const nFld = document.createElement('div');
  nFld.className = 'fld';
  const nLabel = document.createElement('label');
  nLabel.htmlFor = 'nu-fullname';
  nLabel.textContent = 'Full name';
  const nInput = document.createElement('input');
  nInput.id = 'nu-fullname';
  nInput.required = true;
  nFld.append(nLabel, nInput);

  const rFld = document.createElement('div');
  rFld.className = 'fld';
  const rLabel = document.createElement('label');
  rLabel.htmlFor = 'nu-role';
  rLabel.textContent = 'Role';
  const rSelect = document.createElement('select');
  rSelect.id = 'nu-role';
  for (const role of ROLES) {
    const opt = document.createElement('option');
    opt.value = role;
    opt.textContent = role.replace('_', ' ');
    rSelect.append(opt);
  }
  rFld.append(rLabel, rSelect);

  form.append(uFld, pFld, nFld, rFld);

  const actWrap = document.createElement('div');
  actWrap.className = 'act';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = 'Create user';
  const msg = document.createElement('p');
  msg.setAttribute('role', 'alert');
  actWrap.append(submitBtn, msg);
  form.append(actWrap);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.createUser(uInput.value.trim(), pInput.value, nInput.value.trim(), rSelect.value);
      msg.textContent = '';
      form.reset();
      await refreshTable();
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  sec.append(form);
  main.append(sec);

  const tableSec = section('Users');
  main.append(tableSec);
  const tableMsg = noticeEl();
  tableMsg.setAttribute('role', 'alert');

  async function refreshTable() {
    tableSec.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = 'Users';
    tableSec.append(h);

    // The server's GET /api/admin/users selects exactly
    // id, username, full_name, role, active — no credential column is
    // ever requested, so there is nothing to strip or hide here.
    const users = await api.users();

    const table = document.createElement('table');
    table.className = 'sheet';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const t of ['Username', 'Full name', 'Role', 'Active']) {
      const th = document.createElement('th');
      th.textContent = t;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement('tbody');

    for (const u of users) {
      const tr = document.createElement('tr');
      if (!u.active) tr.className = 'row-tint';

      const userTd = document.createElement('td');
      userTd.className = 'code';
      userTd.textContent = u.username;

      const nameTd = document.createElement('td');
      nameTd.className = 'edit-cell';
      const nameInput = document.createElement('input');
      nameInput.value = u.full_name;
      nameInput.setAttribute('aria-label', `Full name for ${u.username}`);
      nameInput.addEventListener('change', async () => {
        try {
          await api.updateUser(u.id, { fullName: nameInput.value });
          tableMsg.textContent = '';
        } catch (err) {
          nameInput.value = u.full_name;
          tableMsg.textContent = err.message;
        }
      });
      nameTd.append(nameInput);

      const roleTd = document.createElement('td');
      roleTd.className = 'edit-cell';
      const roleSelect = document.createElement('select');
      roleSelect.setAttribute('aria-label', `Role for ${u.username}`);
      for (const role of ROLES) {
        const opt = document.createElement('option');
        opt.value = role;
        opt.textContent = role.replace('_', ' ');
        if (role === u.role) opt.selected = true;
        roleSelect.append(opt);
      }
      roleSelect.addEventListener('change', async () => {
        try {
          await api.updateUser(u.id, { role: roleSelect.value });
          tableMsg.textContent = '';
        } catch (err) {
          roleSelect.value = u.role;
          tableMsg.textContent = err.message;
        }
      });
      roleTd.append(roleSelect);

      const activeTd = document.createElement('td');
      const activeLabel = document.createElement('label');
      const activeCheckbox = document.createElement('input');
      activeCheckbox.type = 'checkbox';
      activeCheckbox.checked = Boolean(u.active);
      activeCheckbox.setAttribute('aria-label', `Active flag for ${u.username}`);
      activeCheckbox.addEventListener('change', async () => {
        try {
          await api.updateUser(u.id, { active: activeCheckbox.checked ? 1 : 0 });
          tableMsg.textContent = '';
          await refreshTable();
        } catch (err) {
          activeCheckbox.checked = Boolean(u.active);
          tableMsg.textContent = err.message;
        }
      });
      activeLabel.append(activeCheckbox, stateChip(u.active ? 'active' : 'inactive'));
      activeTd.append(activeLabel);

      tr.append(userTd, nameTd, roleTd, activeTd);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    // Own horizontal scroll container — see the matching comment in
    // refreshCatalog() above.
    const scroller = document.createElement('div');
    scroller.className = 'table-scroll';
    scroller.append(table);
    tableSec.append(scroller);
    if (!users.length) {
      const p = document.createElement('p');
      p.className = 'sig-meta';
      p.textContent = 'No users yet.';
      tableSec.append(p);
    }
    // Re-append after every rebuild: refreshTable() replaces tableSec's
    // children wholesale, and this node (declared once, outside
    // refreshTable) must survive that to keep showing an in-place edit
    // error until the next successful save.
    tableSec.append(tableMsg);
  }
  await refreshTable();
}

// ============================================================
// Screen 3: PDF field mapper
// ============================================================

// Every form has these three sign-off blocks plus the two general record
// fields — seeded whenever a form's mapping is opened for the first time.
const DEFAULT_FIELDS = [
  { field_key: 'machine_id', label: 'Machine ID', section: 'Record', kind: 'text' },
  { field_key: 'remarks', label: 'Remarks', section: 'Record', kind: 'text' },
  { field_key: 'sig_technician', label: 'Maintenance performed by', section: 'Sign-off', kind: 'signature' },
  { field_key: 'sig_team_leader', label: 'Verified by (Workshop Team Leader)', section: 'Sign-off', kind: 'signature' },
  { field_key: 'sig_engineer', label: 'Verified by (Workshop Supervisor/Engr)', section: 'Sign-off', kind: 'signature' }
];

// FIX (Task 15, review round 1, Finding 1): every form must always keep all
// three sign-off blocks. Without one, the matching actor's stage can never
// be signed (field-panel.js only builds a pad for a stage present in the
// snapshot as kind:'signature'; server/workflow.js signAndAdvance rejects an
// empty signaturePng) — every record on that form gets permanently stuck at
// that stage. REQUIRED_SIGNATURE_FIELDS is the backstop both the row-removal
// guard and the save-time guard check against; REQUIRED_SIGNATURE_NAMES is
// only for human-readable messages.
const REQUIRED_SIGNATURE_FIELDS = DEFAULT_FIELDS.filter((f) => f.kind === 'signature');
const REQUIRED_SIGNATURE_NAMES = {
  sig_technician: 'Technician',
  sig_team_leader: 'Workshop Team Leader',
  sig_engineer: 'Workshop Supervisor/Engineer'
};

function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formPickRow(f, onClick, extraChip) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'form-pick queue-row';
  const titleEl = document.createElement('span');
  titleEl.className = 'queue-title';
  titleEl.textContent = f.title || f.file_name;
  const fileEl = document.createElement('span');
  fileEl.className = 'queue-doc code';
  fileEl.textContent = f.file_name;
  b.append(titleEl, fileEl);
  if (extraChip) b.append(extraChip);
  b.addEventListener('click', onClick);
  return b;
}

async function renderMapperScreen(main) {
  const forms = await api.forms();
  const needsSetup = forms.filter((f) => f.state === 'needs_setup');
  // FIX (Finding 1b): a form must be reopenable after Save flips it to
  // ready — otherwise a mapping mistake (or the missing-signature guard
  // below) is unrecoverable through this UI. Kept in a clearly separate
  // section from the needs_setup to-do list so that list keeps its original
  // meaning ("blocking technicians right now").
  const reopenable = forms.filter((f) => f.state === 'ready' || f.state === 'inactive');

  if (!mapperFormId) {
    const sec = section('Map a form’s fields');
    if (mapperNotice) {
      const note = noticeEl();
      note.textContent = mapperNotice;
      sec.append(note);
      mapperNotice = '';
    }
    if (!needsSetup.length) {
      const p = document.createElement('p');
      p.className = 'sig-meta';
      p.textContent = 'No forms are waiting for field setup.';
      sec.append(p);
    }
    for (const f of needsSetup) {
      sec.append(formPickRow(f, () => { mapperFormId = f.id; renderScreen(); }));
    }
    main.append(sec);

    const otherSec = section('Reopen an existing mapping');
    const otherHint = document.createElement('p');
    otherHint.className = 'sig-meta';
    otherHint.textContent = 'Ready and inactive forms already have a mapping — open one here to correct it.';
    otherSec.append(otherHint);
    if (!reopenable.length) {
      const p = document.createElement('p');
      p.className = 'sig-meta';
      p.textContent = 'No other forms are catalogued yet.';
      otherSec.append(p);
    }
    for (const f of reopenable) {
      otherSec.append(formPickRow(f, () => { mapperFormId = f.id; renderScreen(); }, stateChip(f.state)));
    }
    main.append(otherSec);
    return;
  }

  const form = forms.find((f) => f.id === mapperFormId);
  if (!form) { mapperFormId = null; return renderScreen(); }

  const split = document.createElement('div');
  split.className = 'split';

  const left = document.createElement('section');
  left.id = 'pane-left';
  left.setAttribute('aria-label', 'The PDF form');
  const iframe = document.createElement('iframe');
  iframe.src = api.formFileUrl(form.id);
  iframe.title = form.title || form.file_name;
  iframe.style.width = '100%';
  iframe.style.height = '76vh';
  iframe.style.border = '0';
  left.append(iframe);

  const right = document.createElement('section');
  right.id = 'pane-right';
  right.setAttribute('aria-label', 'Field mapping');

  split.append(left, right);
  main.append(split);

  await renderFieldEditor(right, form);
}

async function renderFieldEditor(container, form) {
  container.replaceChildren();

  const existing = await api.formFields(form.id);
  const fields = (existing.fields && existing.fields.length)
    ? existing.fields
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((f) => ({ field_key: f.field_key, label: f.label, section: f.section, kind: f.kind }))
    : DEFAULT_FIELDS.map((f) => ({ ...f }));

  const sec = section(`Field mapping · ${form.title || form.file_name}`);

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'form-pick';
  backBtn.textContent = '‹ Choose another form';
  backBtn.addEventListener('click', () => { mapperFormId = null; renderScreen(); });
  sec.append(backBtn);

  // FIX (Finding 1b): reopening a form that already has submissions must
  // say plainly that existing records are unaffected — each submission
  // stores its own form_snapshot at fill time (server/workflow.js
  // createSubmission) — rather than let an admin infer a risk of data loss.
  // GET /api/submissions already returns every record for an admin
  // (server/workflow.js queueFor), so no new endpoint is needed.
  const allSubmissions = await api.queue();
  const submissionCount = allSubmissions.filter((s) => s.form_id === form.id).length;
  if (submissionCount > 0) {
    const warn = noticeEl();
    warn.textContent =
      `This form already has ${submissionCount} record${submissionCount === 1 ? '' : 's'}. ` +
      'They are unaffected — each one stores its own snapshot of the fields as they were ' +
      'when it was filled. This change only applies to new records created after saving.';
    sec.append(warn);
  }

  const missingWarnBox = document.createElement('div');
  sec.append(missingWarnBox);

  const table = document.createElement('table');
  table.className = 'sheet';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const t of ['Key', 'Label', 'Section', 'Kind', 'Reorder', '']) {
    const th = document.createElement('th');
    th.textContent = t;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  // Own horizontal scroll container — see the matching comment in
  // renderFolderScreen()'s refreshCatalog() above.
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';
  scroller.append(table);
  sec.append(scroller);

  const statusMsg = noticeEl();
  statusMsg.setAttribute('role', 'alert');

  function keyTaken(key, exceptIndex) {
    return fields.some((f, i) => i !== exceptIndex && f.field_key === key);
  }

  // FIX (Finding 1a): recomputed on every render so it always reflects the
  // in-memory `fields` state, including right after a Remove or a "Restore"
  // click below. This is advisory in the UI; saveBtn's own check (further
  // down) is the actual backstop and refuses the API call regardless of
  // whether this box is visible.
  function renderMissingSignatureWarning() {
    missingWarnBox.replaceChildren();
    const missing = REQUIRED_SIGNATURE_FIELDS.filter(
      (rf) => !fields.some((f) => f.field_key === rf.field_key && f.kind === 'signature')
    );
    if (!missing.length) return;
    const p = noticeEl();
    p.setAttribute('role', 'alert');
    p.textContent =
      `Missing required signature block(s): ${missing.map((rf) => REQUIRED_SIGNATURE_NAMES[rf.field_key]).join(', ')}. ` +
      'Every form needs all three sign-off stages — saving is refused until they are restored.';
    missingWarnBox.append(p);
    for (const rf of missing) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'form-pick';
      b.textContent = `+ Restore: ${REQUIRED_SIGNATURE_NAMES[rf.field_key]} signature`;
      b.addEventListener('click', () => { fields.push({ ...rf }); renderRows(); });
      missingWarnBox.append(b);
    }
  }

  function renderRows() {
    tbody.replaceChildren();
    fields.forEach((f, i) => {
      const tr = document.createElement('tr');
      // FIX (Finding 1a): a form is unusable forever for whichever stage
      // loses its signature block (see REQUIRED_SIGNATURE_FIELDS comment
      // above) — lock both the escape hatches (Remove, and switching Kind
      // away from 'signature') for these three specific rows, on top of the
      // save-time backstop below.
      const isRequiredSignature = REQUIRED_SIGNATURE_FIELDS.some((rf) => rf.field_key === f.field_key);

      const keyTd = document.createElement('td');
      keyTd.className = 'code';
      keyTd.textContent = f.field_key || '(pending label)';

      const labelTd = document.createElement('td');
      labelTd.className = 'edit-cell';
      const labelInput = document.createElement('input');
      labelInput.value = f.label;
      labelInput.placeholder = 'Label';
      labelInput.setAttribute('aria-label', `Label for row ${i + 1}`);
      labelInput.addEventListener('change', () => {
        f.label = labelInput.value;
        // A field admin-added in this session derives its key from the
        // label once, the first time that label produces a usable, unused
        // slug — after that the key is stable even if the label is edited
        // again. Seeded defaults (DEFAULT_FIELDS / an already-saved
        // mapping) always keep their fixed key regardless of label edits.
        if (!f.field_key) {
          const candidate = slugify(f.label);
          if (!candidate) {
            statusMsg.textContent = '';
          } else if (keyTaken(candidate, i)) {
            statusMsg.textContent = `Two fields cannot share the key "${candidate}". Try a different label.`;
          } else {
            f.field_key = candidate;
            statusMsg.textContent = '';
          }
        }
        renderRows();
      });
      labelTd.append(labelInput);

      const sectionTd = document.createElement('td');
      sectionTd.className = 'edit-cell';
      const sectionInput = document.createElement('input');
      sectionInput.value = f.section;
      sectionInput.placeholder = 'Section';
      sectionInput.setAttribute('aria-label', `Section for row ${i + 1}`);
      sectionInput.addEventListener('change', () => { f.section = sectionInput.value; });
      sectionTd.append(sectionInput);

      const kindTd = document.createElement('td');
      kindTd.className = 'edit-cell';
      const kindSelect = document.createElement('select');
      kindSelect.setAttribute('aria-label', `Kind for row ${i + 1}`);
      for (const k of ['text', 'signature']) {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k;
        if (k === f.kind) opt.selected = true;
        kindSelect.append(opt);
      }
      kindSelect.addEventListener('change', () => { f.kind = kindSelect.value; });
      if (isRequiredSignature) {
        kindSelect.disabled = true;
        kindSelect.title = 'Every form needs this signature block — its kind cannot be changed.';
      }
      kindTd.append(kindSelect);

      const reorderTd = document.createElement('td');
      reorderTd.className = 'actions';
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.textContent = '↑';
      upBtn.setAttribute('aria-label', `Move row ${i + 1} up`);
      upBtn.disabled = i === 0;
      upBtn.addEventListener('click', () => {
        [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
        renderRows();
      });
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.textContent = '↓';
      downBtn.setAttribute('aria-label', `Move row ${i + 1} down`);
      downBtn.disabled = i === fields.length - 1;
      downBtn.addEventListener('click', () => {
        [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]];
        renderRows();
      });
      reorderTd.append(upBtn, downBtn);

      const removeTd = document.createElement('td');
      removeTd.className = 'actions';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'Remove';
      if (isRequiredSignature) {
        removeBtn.disabled = true;
        removeBtn.title = 'Every form needs this signature block — it cannot be removed.';
      } else {
        removeBtn.addEventListener('click', () => {
          fields.splice(i, 1);
          renderRows();
        });
      }
      removeTd.append(removeBtn);

      tr.append(keyTd, labelTd, sectionTd, kindTd, reorderTd, removeTd);
      tbody.append(tr);
    });
    renderMissingSignatureWarning();
  }
  renderRows();

  const addWrap = document.createElement('div');
  addWrap.style.marginTop = '13px';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'form-pick';
  addBtn.textContent = '+ Add field';
  addBtn.addEventListener('click', () => {
    fields.push({ field_key: '', label: '', section: fields.at(-1)?.section ?? 'Record', kind: 'text' });
    renderRows();
  });
  addWrap.append(addBtn);
  sec.append(addWrap);

  const actWrap = document.createElement('div');
  actWrap.className = 'act';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save mapping';
  saveBtn.addEventListener('click', async () => {
    const seenKeys = new Set();
    for (const f of fields) {
      if (!f.label.trim()) { statusMsg.textContent = 'Every field needs a label.'; return; }
      if (!f.field_key) { statusMsg.textContent = 'Every field needs a key — give it a label first.'; return; }
      if (seenKeys.has(f.field_key)) {
        statusMsg.textContent = `Two fields share the key "${f.field_key}". Give one a different label.`;
        return;
      }
      seenKeys.add(f.field_key);
    }
    // FIX (Finding 1a) — the backstop: even though the UI above already
    // disables removing/retyping the three required signature rows, this
    // check refuses the save regardless of how `fields` got into a bad
    // state (e.g. a mapping saved by an earlier version of this screen, or
    // directly via the API). Refuses with a specific, named message — never
    // a generic or silent failure.
    for (const rf of REQUIRED_SIGNATURE_FIELDS) {
      const present = fields.some((f) => f.field_key === rf.field_key && f.kind === 'signature');
      if (!present) {
        statusMsg.textContent =
          `A record cannot be signed off without the ${REQUIRED_SIGNATURE_NAMES[rf.field_key]} signature block.`;
        return;
      }
    }
    try {
      await api.saveFormFields(
        form.id,
        fields.map(({ field_key, label, section, kind }) => ({ field_key, label, section, kind }))
      );
      mapperNotice = `Saved. "${form.title || form.file_name}" is now ready for technicians.`;
      mapperFormId = null;
      await renderScreen();
    } catch (err) {
      statusMsg.textContent = err.message;
    }
  });
  actWrap.append(saveBtn, statusMsg);
  sec.append(actWrap);

  container.append(sec);
}

boot();
