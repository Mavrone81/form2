# PM Records Android App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sideloadable Flutter APK that lets a technician fill, sign and PDF-preview maintenance records fully offline and sync them to the existing server; team leaders and engineers can sign in but cannot submit without a connection.

**Architecture:** The Node server stays the system of record and gains four small pieces: device tokens, a one-payload form bundle, idempotent record creation, and a technician-only sync route. The Flutter app (new `mobile/` folder) stores the bundle and device-owned draft records in SQLite, replays them to the server on reconnect, and renders preview PDFs on-device by running the server's own `pdf-record.js` in a hidden WebView.

**Tech Stack:** Server: Node 22, Express 4, better-sqlite3, node:test (unchanged, five runtime deps, no build step). Mobile: Flutter (Dart 3), sqflite, webview_flutter, esbuild (mobile-only, to bundle the PDF engine). CI: GitHub Actions.

## Global Constraints

- The server keeps EXACTLY five runtime dependencies and no devDependencies, no build step. All build tooling lives under `mobile/` only.
- No form-derived content (document numbers, machine names, task text, equipment names) anywhere in the repo: not in code, tests, fixtures, commit messages, or the app source. Tests use invented generic content ("Widget check", "Generic measurement A"). `npm run check:sensitive` must pass after every task.
- The sample forms folder and `test/fixtures.local.json` are gitignored and must stay so.
- Every server change is covered by node:test tests that run with bare `node --test` (never `node --test test/`).
- Server errors carry `code` ('FORBIDDEN' | 'NOT_FOUND' | 'INVALID'), never bare status numbers; routes map them via the existing `statusFor`.
- Workflow integrity rules are enforced in `server/workflow.js` / new `server/device-tokens.js`, never only in routes; a sync request can only perform technician-stage work regardless of what the client sends.
- The app never embeds form content in the APK: definitions are fetched after authentication only.
- Package id `com.bevorasg.pmrecords`, app name "PM Records", minSdk 26 (Android 8).
- UI copy: sentence case, plain verbs; disabled offline actions always say why ("Connection required to submit").

---

### Task 1: Device tokens (server)

**Files:**
- Create: `server/device-tokens.js`
- Modify: `server/db.js` (MIGRATIONS array)
- Modify: `server/routes.js` (login issues a token on request; revocation on user deactivate)
- Test: `test/device-tokens.test.js`

**Interfaces:**
- Produces: `issueDeviceToken(db, userId) -> {token, expires_at}`; `validateDeviceToken(db, token) -> user row or null`; `revokeUserTokens(db, userId)`; login response gains `device_token` when the request body carries `wantDeviceToken: true`.

- [ ] **Step 1: Migration.** Append to MIGRATIONS in `server/db.js` a `device_tokens` table created via a migration entry keyed on the table's absence (extend the migration loop to support `{ table, create: true, ddl }` entries that run when `pragma table_info` returns no columns):

```sql
create table if not exists device_tokens (
  id integer primary key,
  token_hash text not null unique,
  user_id integer not null references users(id),
  issued_at text not null,
  expires_at text not null,
  last_used_at text
);
```

- [ ] **Step 2: Failing tests** in `test/device-tokens.test.js` (in-memory db, `createUser` from auth.js):
  - issue returns a 64-hex token and stores only its sha256 hash (assert the raw token does not appear in the db)
  - validate returns the user for a live token, null for garbage, null after `expires_at` (issue with a mocked now by inserting a row with a past date), null for an inactive user
  - revokeUserTokens kills every token for that user and leaves other users' tokens alone
  - expiry is 30 days from issue
- [ ] **Step 3: Implement `server/device-tokens.js`** with `node:crypto` randomBytes(32) + sha256, following the scrypt/password-hash style already in `server/auth.js`. Validation joins users and requires `active = 1`.
- [ ] **Step 4: Wire routes.** In the login route, after `req.session.user = user`: if `req.body?.wantDeviceToken === true`, include `device_token` and `device_token_expires_at` in the JSON response. In the admin user-deactivate route, call `revokeUserTokens`.
- [ ] **Step 5: Run `node --test`, expect all green. Commit.**

### Task 2: Bearer auth middleware for device tokens (server)

**Files:**
- Modify: `server/routes.js`
- Test: `test/device-tokens.test.js` (extend), `test/api.test.js` (extend)

**Interfaces:**
- Produces: `tokenOrSession` middleware — accepts either a signed-in session (as `signedIn` does) or `Authorization: Bearer <token>`; on token auth sets `req.deviceUser` and `req.authVia = 'token'`, on session sets `req.authVia = 'session'`. A helper `actingUser(req)` returns the authenticated user either way. Routes using it must treat token auth as NOT a session (no session mutation).

- [ ] **Step 1: Failing HTTP tests:** a request with a valid Bearer token reaches a `tokenOrSession` route without a cookie; an expired/garbage token gets 401; a valid token for a deactivated user gets 401; session auth still works.
- [ ] **Step 2: Implement middleware** beside `signedIn` in routes.js. Token lookup via `validateDeviceToken`; update `last_used_at`.
- [ ] **Step 3: Tests green. Commit.**

### Task 3: The form bundle (server)

**Files:**
- Modify: `server/routes.js`
- Test: `test/bundle.test.js`

**Interfaces:**
- Produces: `GET /api/bundle` (auth: `tokenOrSession`) returning `{ generated_at, forms: [{ form, fields, frequencies, tasks, cellFor, titleCell, intervalCells, calibrationCells, grid }] }` — per form, exactly the payload of the existing `GET /forms/:id/fields` route plus the `GET /forms/:id/grid` payload, for every form with `state='ready'` and `file_type='xlsx'`. Fields include `options`.

- [ ] **Step 1: Failing tests** with two synthetic workbooks (reuse the writer helper style from `test/api.test.js`): bundle lists both; each entry carries fields (with `options`), tasks, cellFor, grid.columns/rows; a `needs_setup` form is absent; unauthenticated is 401; Bearer-token auth works.
- [ ] **Step 2: Implement** by refactoring the body of the `/forms/:id/fields` handler into a shared `formSpec(db, form)` async function used by both routes (no behavior change to the existing route — its tests already exist and must stay green), plus `buildGrid` per form. A form whose file fails to parse is skipped with a `skipped: [{id, error}]` list, never a 500 for the whole bundle.
- [ ] **Step 3: Tests green (including all pre-existing). Commit.**

### Task 4: Idempotent creation + technician-only sync (server)

**Files:**
- Modify: `server/db.js` (migration: `client_uuid` on submissions + unique index), `server/workflow.js`, `server/routes.js`
- Test: `test/sync.test.js`

**Interfaces:**
- Produces: `POST /api/sync` (auth: Bearer device token only, role technician only) with body `{ records: [{ client_uuid, formId, frequency, machineId, values, signaturePng, signedAtDevice }] }`. Per record, atomically: create-or-find submission by `client_uuid` → `saveFields` → `signAndAdvance` (technician stage). Response `{ results: [{ client_uuid, submissionId, state, error? }] }` — per-record errors never abort the batch. `createSubmission` gains optional `clientUuid`; a repeat POST with a known uuid returns the existing record and applies nothing twice (a second sign attempt on an already-advanced record reports `state` without error).

- [ ] **Step 1: Migration:** `alter table submissions add column client_uuid text` + `create unique index if not exists idx_sub_uuid on submissions(client_uuid) where client_uuid is not null`.
- [ ] **Step 2: Failing tests:**
  - happy path: one record → submission exists with fields, technician signature, state `pending_lead`
  - replaying the same batch → same submissionId, still exactly one signature, no error
  - two records where the second has an invalid Pass/Fail option value: first succeeds, second reports the INVALID message, batch returns 200
  - a team leader's device token → 403 for the whole route
  - session auth (no token) → 401 (sync is token-only, by design: it exists for devices)
  - signature must pass the existing PNG validation (`assertValidSignature`)
  - a record for an unknown formId reports NOT_FOUND for that record only
- [ ] **Step 3: Implement.** In workflow.js: `createSubmission` accepts `clientUuid`; add `findByClientUuid(db, uuid)`. Route wraps each record in try/catch, maps errors via the existing `statusFor` vocabulary into the per-record `error`.
- [ ] **Step 4: Tests green. Commit.**

### Task 5: PDF engine bundle (mobile/pdf-engine)

**Files:**
- Create: `mobile/pdf-engine/package.json` (esbuild devDependency; this folder is NOT the server), `mobile/pdf-engine/build.mjs`, `mobile/pdf-engine/entry.js`, `mobile/pdf-engine/harness.html`
- Test: `test/pdf-engine-golden.test.js` (server repo, node:test — golden comparison)

**Interfaces:**
- Produces: `mobile/pdf-engine/dist/pdf-engine.js` — an IIFE exposing `window.renderRecordPdf(inputJson) -> Promise<Uint8Array>` built from `server/pdf-record.js` + `web/js/sheet-layout.js` + PDFKit standalone, with fonts and the ICC profile injected as base64 assets at build time (the entry shims the `fs.readFileSync`/`fileURLToPath` asset loads). The build output is gitignored; CI builds it.

- [ ] **Step 1:** `entry.js` imports `renderRecordPdf` with an esbuild alias mapping `pdfkit` to `pdfkit/js/pdfkit.standalone.js` and a small virtual module replacing the `asset()` reads with embedded base64 (DejaVu ×3 + sRGB.icc, read from `assets/` at build time).
- [ ] **Step 2: Golden test** (skipped when `mobile/pdf-engine/dist/pdf-engine.js` is absent, mirroring the fixtures SKIP pattern): render the synthetic CAL_FIXTURE from `test/pdf-record.test.js` through the server renderer and through the bundle (executed in Node via `new Function`/vm with a `window` stub), byte-compare after zeroing both files' `/ID [...]` trailer arrays. Assert equal length ±0 and equal bytes.
- [ ] **Step 3: Build succeeds (`node mobile/pdf-engine/build.mjs`), golden test green. Commit** (source only; `dist/` gitignored).
- [ ] **Step 4:** `harness.html`: minimal page loading `pdf-engine.js`, listening for a `message` with input JSON, replying with the PDF bytes base64-encoded — this is the file the Flutter WebView loads from app assets.

### Task 6: Flutter scaffold + API client + auth

**Files:**
- Create: `mobile/app/` (flutter create, org com.bevorasg, project pmrecords), `mobile/app/lib/api/client.dart`, `mobile/app/lib/auth/session.dart`, `mobile/app/lib/auth/pin.dart`
- Test: `mobile/app/test/api_client_test.dart`, `mobile/app/test/pin_test.dart`

**Interfaces:**
- Produces: `ApiClient` (base URL configurable, default `https://eform.bevorasg.com/api`) with `login(username, password, {wantDeviceToken})`, `bundle()`, `sync(records)`, `queue()`, `submission(id)`, `sign(id, png)`, `reject(id, reason)`, `pdf(id)`; cookie jar for session; Bearer header when a device token is held. `SessionStore` keeps the device token + user in `flutter_secure_storage`; `PinLock` stores a salted sha256 of a 4–6 digit PIN and gates app open when offline.

- [ ] Steps: scaffold; pubspec deps (`http`, `sqflite`, `path_provider`, `flutter_secure_storage`, `webview_flutter`, `printing` for PDF display, `connectivity_plus`); write failing widget/unit tests for PIN hashing/verify and ApiClient request shapes against a local mock HttpServer; implement; `flutter test` green; commit.

### Task 7: Local database + bundle cache + sync queue

**Files:**
- Create: `mobile/app/lib/db/local_db.dart`, `mobile/app/lib/db/models.dart`, `mobile/app/lib/sync/queue.dart`
- Test: `mobile/app/test/local_db_test.dart`, `mobile/app/test/queue_test.dart` (sqflite_common_ffi for desktop test execution)

**Interfaces:**
- Produces: tables `bundle(form_id, json, fetched_at)`, `records(client_uuid pk, form_id, frequency, machine_id, values_json, signature_png, signed_at, status: draft|queued|synced|error, server_id, error)`; `SyncQueue.replay(api)` pushes every `queued` record, marks `synced` + stores `server_id`, records per-item errors without stopping, and is safe to run twice (server idempotency + local status guard).

- [ ] Steps: failing tests — draft CRUD; queue replay marks synced on success; replay with one failing record marks only it `error` and continues; a replay interrupted after server success but before local mark, re-run, ends `synced` with the same server_id (mock server returns same id for same uuid). Implement. Green. Commit.

### Task 8: Technician fill-in screens

**Files:**
- Create: `mobile/app/lib/screens/forms_list.dart`, `record_editor.dart`, `widgets/interval_picker.dart`, `widgets/task_list.dart`, `widgets/parts_table.dart`, `widgets/calibration_table.dart`, `widgets/signature_pad.dart`
- Test: `mobile/app/test/record_editor_test.dart`, `mobile/app/test/calibration_table_test.dart`

**Interfaces:**
- Consumes: bundle rows (fields incl. `options`, tasks with `freq`, frequencies) and the records table.
- Produces: a record editor that mirrors the web panel's semantics exactly: interval picker (only the form's own frequencies); task list dimmed-but-readable outside the cumulative scope (1M<3M<6M<Y — port `covers()` to Dart verbatim); parts table (4 columns); calibration table where a field with `options` renders a dropdown of `['—', ...options]` and free-text otherwise; machine id, special tools, remarks; signature pad drawing to PNG bytes. Saving writes `values_json` locally on every change; "Sign & queue" stores the PNG + `signed_at` and sets status `queued`.

- [ ] Steps: failing widget tests — Pass/Fail renders as dropdown with the blank option; picking Y widens task scope per the cumulative rule; a queued record becomes read-only. Implement screens (Material 3, monochrome document-control styling consistent with the web design). Green. Commit.

### Task 9: Preview (on-device PDF)

**Files:**
- Create: `mobile/app/lib/preview/engine.dart`, `mobile/app/lib/screens/preview.dart`; app asset bundling of `harness.html` + `pdf-engine.js` (copied by the CI/build script from `mobile/pdf-engine/dist/`)
- Test: `mobile/app/test/engine_input_test.dart`

**Interfaces:**
- Consumes: the bundle's per-form `grid`, `cellFor`, `titleCell`, `intervalCells`, `calibrationCells`; the record's current values + signature.
- Produces: `PreviewEngine.render(record) -> Uint8List` — builds the exact input JSON the server route builds (form identity from the bundle, submission stub with machine_id/frequency/created_at, snapshot, values, signatures list with the technician's PNG, grid, cell maps), posts it into the hidden WebView, awaits the base64 reply. `preview.dart` shows the bytes with `printing`'s PdfPreview (pinch-zoom on tablets). Works with no connectivity.

- [ ] Steps: failing test asserting the engine input JSON matches the server route's assembly for a fixture record (same key names, same shapes). Implement. Manual check deferred to Task 12's device pass. Commit.

### Task 10: Reviewer screens (online-only actions)

**Files:**
- Create: `mobile/app/lib/screens/review_queue.dart`, `review_record.dart`
- Test: `mobile/app/test/review_test.dart`

**Interfaces:**
- Consumes: `ApiClient.queue()/submission()/sign()/reject()`, `connectivity_plus`.
- Produces: lead/eng landing screen = their live queue; record view shows fields read-only + rejection composer + signature pad; **every submitting control is disabled when offline with the caption "Connection required to submit"**; queue fetch failure offline shows cached list (if any) marked "as of last connection".

- [ ] Steps: failing widget tests — offline state disables sign and reject and shows the caption; online enables. Implement. Green. Commit.

### Task 11: App shell, sync UX, roles

**Files:**
- Create: `mobile/app/lib/main.dart` routing by role, `mobile/app/lib/widgets/sync_banner.dart`
- Test: `mobile/app/test/shell_test.dart`

**Interfaces:** technician lands on their records + forms list with a persistent banner: "N records waiting to sync" → tap to sync now; auto-sync on connectivity regained; bundle refresh on each online login (stale bundle still usable offline with its `fetched_at` shown). PIN lock on cold start when offline; full login when online and token expired.

- [ ] Steps: failing tests for banner count and role routing; implement; green; commit.

### Task 12: CI, signing, release APK

**Files:**
- Create: `.github/workflows/android.yml`, `mobile/app/android` signing config reading env, extend `scripts/check-no-sensitive-files.sh` to sweep `mobile/`
- Modify: `.gitignore` (keystores, `mobile/pdf-engine/dist/`, Flutter build outputs)

- [ ] **Step 1:** Generate the release keystore locally (`keytool -genkeypair`, RSA 2048, 25-year validity, CN=PM Records), store it and its passwords as GitHub secrets (`gh secret set ANDROID_KEYSTORE_B64 / ANDROID_KEYSTORE_PASS / ANDROID_KEY_ALIAS / ANDROID_KEY_PASS`), and back the keystore up to the server at `/root/keys/pmrecords.keystore` (chmod 600). The keystore never enters the repo.
- [ ] **Step 2:** Workflow on tag `apk-*` and manual dispatch: checkout → setup Java 17 + Flutter stable → `node mobile/pdf-engine/build.mjs` → copy engine into app assets → `flutter test` → `flutter build apk --release` (signed from secrets) → upload APK as release asset. Also run the full server `node --test` and `check:sensitive` as gates.
- [ ] **Step 3:** Trigger once, download the APK, verify signature with `apksigner verify`. Commit workflow.
- [ ] **Step 4: Device pass (manual, with the user):** install on one phone + one tablet; airplane-mode: login blocked→PIN path, fill a record on a calibration form, preview PDF offline, sign & queue; reconnect: sync; verify the record in the team leader web queue and that the archived PDF matches the device preview.

---

## Execution notes

- Tasks 1–4 are pure server work and land first; the app tasks consume their exact response shapes, so freeze them (any change after Task 6 starts is a plan change).
- Task 5's golden test is the fidelity guarantee for the entire preview feature; do not weaken it to "similar" — byte equality after /ID normalization, or the task is not done.
- Flutter tests must run headless (`flutter test`) with sqflite_common_ffi; nothing in CI may need an emulator.
- The device pass in Task 12 needs the user's phone/tablet — schedule it with them; everything before it is verifiable without hardware.
