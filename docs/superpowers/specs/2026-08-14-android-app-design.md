# PM Records Android App — Design

Approved 2026-08-14. Native Android app (Flutter) for phones and tablets,
installed by sideloaded APK. The server at eform.bevorasg.com remains the
system of record: workflow rules, accounts, the archive and the authoritative
PDF all stay where they are. The app adds one capability the web cannot give:
a technician fills, signs and previews records with no connection at all, and
the work syncs up when the network returns.

This document deliberately contains no form content. Forms are referred to
only by count or by role ("the three forms that carry a calibration table");
document numbers, machine names and task text never appear in this repo.

## Roles

| Role | Online | Offline |
|---|---|---|
| Technician | everything, as on the web | create, fill, sign records; work queues on the device |
| Team leader / Engineer | sign in, review queue, sign, reject | sign in and view cached screens; every submitting action disabled with a visible "connection required" notice |
| Admin | not in the app | — (admin work stays on the web) |

"Cannot submit offline" is enforced in the app AND by the server: a sync
request can only carry technician-stage work, so a modified client cannot
push a review verdict it was never entitled to queue.

## Offline model

- **Form bundle.** After an online sign-in the app downloads every ready
  form's definition — fields, tasks, intervals, parts and calibration tables,
  cell metadata — in one payload, and stores it in the app's own SQLite
  database. The APK itself ships with no form content; content exists on a
  device only after that device has authenticated.
- **Device-owned records.** A record created offline gets a device-generated
  UUID and lives only on the device until synced. Records that already exist
  on the server are read-only in the app while offline. A rejected record is
  corrected online, where the rejection reason lives.
- **Sync.** On reconnect (and on demand) the app replays each queued record:
  create submission (carrying the UUID) → save fields → technician signature.
  The server treats the UUID as an idempotency key: a retried or interrupted
  sync can never produce a duplicate record. After a successful sync the
  record's owner is the server and the local copy becomes a read-only mirror.
- **No merge conflicts by design.** Offline work is always the creation of a
  new record; nothing offline can modify a record another actor may have
  touched.

## Preview — the real PDF, offline

The Preview button renders the actual final document from the current values.
Offline this works because the app embeds the same PDF renderer the server
runs — `server/pdf-record.js` plus the shared `web/js/sheet-layout.js` — in a
hidden WebView used purely as a rendering engine (PDFKit's standalone browser
build; fonts and the ICC profile bundled as assets). Identical code, identical
bytes: fidelity to the controlled documents is preserved by construction, not
re-implemented on a second platform.

The engine consumes the same inputs the server route assembles (grid, cell
map, values, signatures), which the bundle provides per form. If the embedded
engine ever fails on a device, the app falls back to the server-rendered PDF
when online and says plainly that preview needs a connection when not.

## Authentication on the device

- Online sign-in uses the existing credentials and issues the device a
  **device token** bound to that user, stored in Android Keystore-backed
  storage. Re-opening the app offline requires a short PIN set at first
  sign-in (unlock only — the token is what authenticates).
- Every offline action is stamped with the token's identity; the server
  validates the token at sync, so a synced record is attributable exactly as
  a web-made one. Tokens are revocable server-side (admin deactivating the
  user kills the token) and expire after 30 days without an online sign-in.
- Team leader / engineer tokens confer nothing at sync time — review actions
  remain session-authenticated, online, through the existing routes.

## Server additions (small; the five-dependency, no-build rule holds)

1. `GET /api/bundle` — every ready form's definition in one payload, session
   or device-token authenticated.
2. Idempotent submission creation: an optional client UUID column with a
   unique index; a repeat POST with a known UUID returns the existing record.
3. Device-token table and auth middleware (issue on login when the client
   asks; validate on sync routes; revoke with the user).
4. A sync endpoint accepting the create→fields→sign sequence for
   technician-stage work only.

Existing permissions, validation (including constrained Pass/Fail answers),
signature PNG checks and rate limiting apply to synced work unchanged.

## Repo and build

- New top-level `mobile/` folder: the Flutter project. Its toolchain is its
  own; the server keeps five runtime dependencies and no build step.
- GitHub Actions builds a **signed APK** on tag/release; the keystore lives
  in CI secrets, never in the repo. The APK is downloaded from the release
  and sideloaded (Android 8+, phones and tablets).
- The existing sensitive-content guard extends to `mobile/`: no form-derived
  strings in the app source, tests or fixtures.

## Testing

- Server additions: node:test as now (bundle shape, idempotent create,
  token issue/validate/revoke, technician-only sync enforcement).
- Flutter: widget tests for the fill-in screens (interval scoping, parts and
  calibration tables, Pass/Fail selects), unit tests for the sync queue and
  its retry/dedupe behaviour, a golden test that the embedded engine's PDF
  byte-matches the server's for the same synthetic inputs.
- Manual pass on one phone and one tablet: airplane-mode fill → sign →
  reconnect → sync → record appears in the team leader's web queue → archived
  PDF identical to the device preview.

## Out of scope (V1)

- iOS.
- Offline review/sign/reject for team leader or engineer.
- Offline editing of any record that exists on the server (including
  rejected ones).
- Play Store distribution and Android auto-update; installing a new APK over
  the old one is the update path.
- Admin functions in the app.
