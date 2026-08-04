# PM Forms

A local web app for preventive maintenance record forms. It indexes PM forms
from an admin-configured folder and runs a technician → team leader →
engineer sign-off workflow, rendering each form alongside its fields.

## Running locally

```bash
npm install
npm start
```

## Testing

```bash
npm test
```

Some tests parse the real sample forms and are skipped unless the sensitive
form files are present locally and `scripts/build-fixtures.js` has been run
to generate `test/fixtures.local.json`. See the CI section below for what
that means for automated runs.

## Deployment (Docker Compose)

```bash
cp .env.example .env
# edit .env:
#   FORMS_HOST_DIR=/absolute/path/to/your/forms   (mounted read-only)
#   SESSION_SECRET=$(openssl rand -hex 32)        (required, >= 32 chars)
docker compose build
docker compose up -d
```

`compose.yaml` refuses to start without `SESSION_SECRET` and `FORMS_HOST_DIR`
set in `.env` — Compose fails fast with a clear message rather than the
container silently misbehaving. `server/config.js` enforces the same rule
inside the app: a `SESSION_SECRET` shorter than 32 characters throws at boot,
because a weak or absent secret lets sessions be forged or lets a restart
silently invalidate everyone's login.

Two volumes back the container:

- `${FORMS_HOST_DIR}:/forms:ro` — the forms folder, mounted **read-only**.
  The app must never modify a source form; the `:ro` flag makes that
  structural rather than a convention the code is trusted to honour.
- `pm-data:/data` — a named volume holding the SQLite database, so it
  survives container restarts and rebuilds.

On first boot, if `FORMS_DIR` is set and no forms folder has been configured
yet, the server points itself at `/forms` and runs an initial scan
automatically — a fresh container comes up already catalogued. Once an
admin sets (or changes) the folder from the UI, that choice is the source of
truth and boot no longer overrides it. If the initial scan fails (e.g. the
mount is empty or misconfigured), the server still starts — an admin needs
the app running to fix the path from the settings page.

Check health and sign-out state:

```bash
docker compose ps                 # expect "healthy"
curl -fsS localhost:3000/api/me   # -> null (signed out)
```

Stop with `docker compose down` (add `-v` to also drop the database volume).

## CI

GitHub Actions runs on every push and pull request (`.github/workflows/ci.yml`):

- **`test` job** — installs dependencies, runs `npm run check:sensitive` to
  guard against committed form content, then runs the full test suite.
- **`docker` job** — builds the Docker image and confirms the container
  starts and answers on `/api/me`.

**What CI does not cover:** the source PM forms (`Sample of Forms/`,
`PM Document 2026/`) and the generated `test/fixtures.local.json` are
commercially sensitive and git-ignored, so they do not exist in the CI
environment. The tests that parse the real forms skip as a result — this is
expected, not a failure. The workflow prints the skip count to the job
summary so a green run is never mistaken for full coverage. For full
coverage, run `npm test` locally with the sample forms present after
generating fixtures with `node scripts/build-fixtures.js`.

## Sensitive content guard

`npm run check:sensitive` (`scripts/check-no-sensitive-files.sh`) fails the
build if any form file, completed record, fixture map, or database has been
committed to git. It checks the git index, not the working tree, so locally
present ignored files are unaffected. This runs automatically in CI and can
also be run before committing.
