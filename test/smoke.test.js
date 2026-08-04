import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package declares ESM and a node engine floor', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.engines.node.startsWith('>=2'));
});
