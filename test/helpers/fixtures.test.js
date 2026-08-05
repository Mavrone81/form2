import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures } from './fixtures.js';

test('returns null when no local fixture file is present', () => {
  const f = loadFixtures('/nonexistent/fixtures.json');
  assert.equal(f, null);
});
