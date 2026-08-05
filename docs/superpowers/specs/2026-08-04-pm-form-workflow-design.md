# Preventive Maintenance Form Workflow — Design

Date: 2026-08-04
Status: Approved

## Purpose

Replace the paper/Excel handling of Preventive Maintenance (PM) record forms with a local
web app. An admin points the system at a folder of form files. A technician picks a form
from that folder, sees the form rendered on the left and the fillable fields on the right,
fills it in, signs, and submits. The record then moves through Team Leader and Engineer
sign-off, each signing on a signature pad.

The forms are **not** hardcoded. The folder is the source of truth, so forms can be added,
revised or removed without touching the code.

## Success criteria

- An admin can set a forms folder from within the app and rescan it.
- Excel forms in that folder are indexed automatically and usable with no setup.
- PDF forms become usable once an admin has defined their field mapping.
- A technician can pick any ready form and see form-left / fields-right in one screen.
- A submission moves Technician → Team Leader → Engineer, each signing before submit.
- Each stage locks once signed; earlier stages are read-only to later stages.
- An admin can create and edit users and assign roles.

## Architecture

```
   forms folder (admin-configured)
   ├── *.xlsx ──▶ excel parser  ──▶ auto field spec ──▶ ready
   └── *.pdf  ──▶ admin mapping ──▶ manual field spec ─▶ ready
                       │
                       ▼ (until mapped)
                  "needs setup"

   form catalog (DB) ──▶ technician picks a form
                              │
                              ├──▶ left pane   HTML grid (xlsx) | PDF viewer (pdf)
                              └──▶ right pane  field panel

   SQLite: settings · form_catalog · form_fields · users · submissions · signatures
```

### Components

**`server/scanner`** — Walks the configured folder, finds `.xlsx` and `.pdf`, and reconciles
the result against the `form_catalog` table: new files are added, missing files are marked
inactive (never deleted — old submissions must keep referencing them), and changed files are
re-parsed. Input: a folder path. Output: a catalog diff.

**`server/excel-parser`** — Reads one `.xlsx`, returns a form definition. Testable
standalone. See "Excel indexing" below.

**`server/pdf-reader`** — Reads page count and metadata for a `.pdf`. Does not attempt field
extraction; fields come from the admin mapping.

**`server/renderer-model`** — Turns a parsed sheet into a grid model for the left pane: cell
values, merge ranges, column widths, borders, bold/alignment. Pure data, no DOM — snapshot-
testable. Excel only; PDFs are served as-is.

**`server/auth`** — Username + password login, hashed passwords, session cookies. Exposes
`currentUser(req)` and a `requireRole(...roles)` guard.

**`server/workflow`** — Owns submission state transitions and who may act on what. Single
source of truth for stage ordering.

**`server/db`** — SQLite access. Schema + queries. No business logic.

**`web/form-view`** — Left pane. Renders the grid model as an HTML table honouring merges and
widths, or embeds the PDF for PDF forms.

**`web/field-panel`** — Right pane. Renders the field spec as inputs; marks locked stages
read-only. Identical for Excel and PDF forms — it consumes a field spec and does not care
where it came from.

**`web/field-mapper`** — Admin-only. Defines the field list for a PDF form.

**`web/signature-pad`** — Canvas capturing pointer events (mouse / touch / stylus). Emits a
PNG data URL. Standalone, no app dependencies.

## Form sources

### Folder configuration

The forms folder path is stored in a `settings` row, set and changed from an admin screen.
Changing it triggers a rescan; there is no restart and no config file to edit. An admin can
also rescan the current folder on demand, for when files change on disk.

The folder is read-only to the app. Source form files are **never** modified.

### Form readiness

Every discovered file lands in the catalog with a state:

| Type | State | Reason |
|---|---|---|
| `.xlsx` parsed OK | `ready` | Fields auto-extracted |
| `.xlsx` parse failed | `needs_setup` | Admin can map fields manually as a fallback |
| `.pdf` | `needs_setup` | Until an admin defines its fields |
| any, mapped by admin | `ready` | |
| file no longer on disk | `inactive` | Hidden from technicians, kept for old submissions |

**Technicians only ever see `ready` forms.** Admins see everything, with `needs_setup`
surfaced as a to-do list so it is obvious what is blocking a form from being used.

### Excel indexing

The parser locates sections by **anchor text**, not fixed cell addresses, because positions
shift between files. It addresses sheets **by index, never by name** — observed sheet names
are inconsistent and non-unique (several sample files share one sheet name, and two
distinct forms reuse the same sheet name).

| Section | Anchor | Extracted |
|---|---|---|
| Header | `Document Title:` | title, doc number, revision, page |
| Frequency | distinct values in the `Freq.` column | the options this form actually uses |
| Special tools | `Special Tools Required:` | blank to the right |
| Parts required | `Parts Required:` | header row + following blank bordered rows |
| PPE | `PPE Required:` | static numbered list |
| Safety | `Safety:` | static text |
| Procedure | `Procedure:` | static text |
| Task table | row containing `No` + `Freq` + `Instruction` | one row per task until the first blank **Instruction** cell |
| Signatures | `Maintenance Performed by:`, `Verified By:` ×2 | three name + date blocks |
| Remarks | `Remarks:` | static text + free-text entry |

Two rules above are load-bearing and were derived from the actual files, not assumed:

**The task table terminates on a blank Instruction cell, never on a blank `No`.** In one sample form, a row is a real task with an empty `No` cell, and the numbering also
skips a value. Terminating on `No` truncates that form from 11 tasks to 3. The `No` column is
display numbering only; rows are identified by their sheet row index.

**Frequency options come from the `Freq.` column, not the header row.** The header wording is
inconsistent across files — "Three Monthly (3M)" vs "Three Month (3M)" — and one sample's
header omits Yearly even though the form is used monthly through six-monthly. The column
values are clean and are always one of `1M`, `3M`, `6M`, `Y`.

**Interval scope is cumulative, not exclusive.** Several forms state in their own remarks
that a yearly service requires the 3M and 6M work to be performed at the same time.
Selecting an interval therefore brings every shorter interval into scope as well, ordered
`1M < 3M < 6M < Y`. A yearly service on form F01 is **18 tasks, not the 1 row marked `Y`**.

Treating this as a plain filter would show a technician a single task for a yearly service and
let 17 required checks drop off a signed QA record. The rule lives in the workflow layer, not
the UI, so it holds no matter which screen collects the data.

The Status column is found as the header cell right of `Instruction`; its column differs per
file and **two sample forms have no Status column at all** (F04, F09). For those, a status field per task
is still offered in the right pane.

A parse failure never stops the server. The file is logged, marked `needs_setup`, and every
other form stays available.

### PDF field mapping

An admin opens a `needs_setup` PDF, sees it rendered on the left, and builds its field list
on the right: for each field a label, a section heading to group under, and its order. All
fields are free text in this version. Signature blocks are added as a field of kind
`signature` — the workflow needs to know which fields the three sign-off stages own.

The mapping is stored against the form and reused for every submission of that form. Editing
a mapping does not alter submissions already made against it — those keep the field set they
were filled with, so an old record always renders the way it was signed.

The same mapper is available for Excel forms whose auto-parse produced a poor result, which
is why the `.xlsx` parse-failure path is recoverable rather than fatal.

## Field types

All entry fields are **free text** in this version. No dropdowns, no validation beyond
"required to submit". This is deliberate — the vocabulary in use is not yet settled, and
constraining it early would be wrong.

The one exception is `signature`, which is not text but a captured image plus signer identity
and timestamp.

## Workflow

```
draft ──▶ pending_lead ──▶ pending_engineer ──▶ approved
```


| From | Action | Who | To |
|---|---|---|---|
| draft | fill, sign, submit | technician (owner) | pending_lead |
| pending_lead | review, sign, submit | team_leader | pending_engineer |
| pending_engineer | review, sign, approve | engineer | approved |

Rules:

- A user only sees the queue matching their role. Technicians additionally see their own
  submissions in any state.
- Signing is required before submitting at every stage.
- On submit, that stage's fields and signature lock and become read-only to later stages.
- `approved` is terminal — the record is fully read-only.
- Rejection is **out of scope** for this version. A record needing correction is handled
  outside the system. The state column is a string so `rejected` can be added later without
  migration.

## Roles

| Role | Can |
|---|---|
| technician | Create, fill, sign and submit a form; view own submissions |
| team_leader | View `pending_lead` queue; sign and submit to engineer |
| engineer | View `pending_engineer` queue; sign and approve |
| admin | Set the forms folder, rescan, map PDF fields, create and edit users |

A user has exactly one role. Admin is a management role and does not appear in the sign-off
chain.

## Data model

```
settings
  key, value                                      -- incl. forms_folder

form_catalog
  id, file_path, file_name, file_type,            -- xlsx | pdf
  title, doc_number, revision,
  state, content_hash, last_scanned_at            -- ready | needs_setup | inactive

form_fields
  id, form_id, field_key, label, section,
  kind, sort_order, source                        -- kind: text | signature
                                                  -- source: parsed | admin

users
  id, username (unique), password_hash, full_name, role, active, created_at

submissions
  id, form_id, form_snapshot, machine_id, frequency, state,
  created_by, created_at, updated_at

submission_fields
  id, submission_id, field_key, label, value      -- free text

signatures
  id, submission_id, stage, user_id, full_name,
  image_png, signed_at                            -- stage ∈ technician|team_leader|engineer
```

`submission_fields` is key/value rather than wide columns because the field set differs per
form (sample task counts range from 4 to 18 rows). It stores `label` alongside the value so a
record still reads correctly after its form's mapping is edited.

`form_snapshot` holds the field spec as it stood when the submission was created — the reason
editing a mapping cannot retroactively change signed records.

`content_hash` lets a rescan detect a changed file and re-parse only what moved.

SQLite, single file on disk. No external database to install.

## Signature capture

An HTML canvas listening to Pointer Events, so mouse, finger and stylus all work through one
code path, with `pressure` used for stroke width where reported. Output is a PNG data URL
stored against the submission with the signer's account name and a **server-side** timestamp
— a client clock must not determine the signed date on a QA record.

## Error handling

- Parse failure on one form: log, mark `needs_setup`, keep serving the rest.
- Folder missing or unreadable: admin screen shows the error; previously catalogued forms
  stay usable rather than vanishing.
- Source file deleted: marked `inactive`, hidden from technicians, existing submissions
  unaffected.
- Submitting without a signature: rejected with a clear message, nothing persisted.
- Acting on a submission not in your role's state: 403, state unchanged.
- Two users acting on one submission at once: the transition checks current state inside the
  write, so the second action fails cleanly rather than double-advancing.

## Testing

- **Scanner**: adding, removing and changing files produces the right catalog diff; a removed
  file goes `inactive` rather than being deleted.
- **Excel parser**: run against all 12 sample files and assert the exact task count, status
  column and frequency set recorded in the appendix. Highest-value test — it is the component
  most likely to break on a form's quirks, and the F11 count (11, not 3) specifically
  guards the blank-`No` case.
- **Renderer model**: snapshot the grid for one representative form.
- **Workflow**: each legal transition advances state; each illegal one is refused and leaves
  state untouched.
- **Cumulative interval scope**: selecting `Y` on form F01 puts 18 tasks in scope, not 1;
  selecting `3M` puts 14. Guards the compliance rule directly.
- **Mapping immutability**: editing a form's mapping does not change an existing submission.
- **Auth**: role guards allow the right role and refuse the others.

## Seed data

Four demo accounts, one per role, created on first run so the whole chain can be walked
immediately. Passwords are printed to the console at seed time and must be changed via the
admin screen. Local evaluation only.

## Security note

The sample forms are sensitive and are excluded from version control via `.gitignore`
(`Sample of Forms/`, `*.xlsx`, `*.xls`). The forms folder is configured at runtime and its
contents are never committed. The SQLite database and captured signatures are likewise
ignored, since submissions contain signature images and signer names.

## Visual design

Direction: **document control**. The interface behaves like the QA document system it feeds
— monochrome, grid-forward, with codes (document numbers, revisions, interval codes) set in
a monospace face because they are codes. A single accent carries the record's state: red
while unapproved, green once approved. Nothing else is coloured.

Mockups of the three directions considered are in `docs/design/directions.html` (local only
— they render real form content).

### Contrast rules

These are requirements, not preferences. A technician must be able to read every line on the
record, including rows this visit does not cover.

- **Instruction and Freq text must never be faded, greyed, or set in a light tint.** Rows
  outside the selected interval are de-emphasised by tinting the row background and labelling
  the status cell "not in scope" — the words themselves stay at full reading contrast.
- **Every form control sets its text colour explicitly**, and light panels declare
  `color-scheme: light`. Inputs do not inherit colour: a control with a white background and
  no declared colour renders white-on-white for any viewer in dark mode.
- Body text meets WCAG AA (4.5:1). Interactive controls have a visible keyboard focus ring.
- The layout is responsive to a single column, and honours `prefers-reduced-motion`.

## Out of scope

- Rejection / send-back flow
- Export back to `.xlsx` (the app is the record; printing the approved view to PDF is the
  filed copy)
- Positional field overlays on PDFs — the mapper defines a field *list*, not boxes drawn on
  the page
- OCR of scanned PDFs
- Email or push notification of pending items
- Editing source form files
- Multi-user deployment, HTTPS, network hardening — this is a local app

## Appendix — sample form parse expectations

Equipment names and document numbers are sensitive and are **not** recorded here. The
mapping from these IDs to real files, and the per-form parse expectations, live in
`docs/design/form-fixtures.local.md`, which is git-ignored. The parser tests read that file.

| ID | Tasks | Status col | Frequencies |
|---|---|---|---|
| F01 | 18 | present | 3M 6M Y |
| F02 | 6 | present | 1M 3M |
| F03 | 4 | present | 1M |
| F04 | 14 | *none* | 3M 6M Y |
| F05 | 15 | present | 3M 6M Y |
| F06 | 15 | present | 3M 6M Y |
| F07 | 13 | present | 1M 3M 6M |
| F08 | 9 | present | 3M 6M Y |
| F09 | 18 | *none* | 1M 3M 6M Y |
| F10 | 10 | present | 1M 3M 6M |
| F11 | 11 | present | 1M 3M 6M |
| F12 | 13 | present | 1M 3M 6M Y |

Cumulative scope, for the three forms that exercise the rule hardest:

| ID | 1M | 3M | 6M | Y |
|---|---|---|---|---|
| F01 | — | 14 | 17 | 18 |
| F03 | 4 | 4 | 4 | 4 |
| F11 | 4 | 6 | 11 | 11 |
