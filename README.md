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
