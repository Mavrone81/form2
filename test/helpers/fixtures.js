import { readFileSync, existsSync } from 'node:fs';

const DEFAULT = new URL('../fixtures.local.json', import.meta.url).pathname;

// The real forms are sensitive and are not in the repo. Tests that need them
// call this and skip when it returns null, so the suite still runs elsewhere.
export function loadFixtures(path = DEFAULT) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const SKIP = 'no local form fixtures — run scripts/build-fixtures.js';
