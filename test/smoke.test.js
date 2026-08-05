import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package declares ESM and a node engine floor', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.engines.node.startsWith('>=2'));
});

// Finding 7: GitHub's default shell is `bash -e`, NOT `-o pipefail`, so
// `npm test | tee ...` exits with tee's status and a failing suite goes green.
// The 140/140 gate is only real if the pipeline propagates the failure.
test('the CI test step propagates a failing suite through its pipe', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = /- name: Run tests\n([\s\S]*?)(?=\n {6}- |\n {2}\w)/.exec(ci);
  assert.ok(step, 'expected a "Run tests" step in .github/workflows/ci.yml');
  const body = step[1];
  assert.match(body, /npm test/, 'the step must run the suite');
  assert.match(body, /\|\s*tee/, 'the step still tees its output for the summary step');
  assert.match(body, /shell:\s*bash/, 'the step must pin its shell so pipefail is honoured');
  assert.match(body, /set -o pipefail/, 'without pipefail the step exits with tee\'s status, never the suite\'s');
});
