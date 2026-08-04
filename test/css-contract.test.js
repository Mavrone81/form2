import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');

test('light panels pin color-scheme so dark-mode viewers do not get white-on-white', () => {
  assert.match(css, /color-scheme:\s*light/);
});

test('form controls declare their own colour', () => {
  // Inputs do not inherit colour. Without this, a white input background in a
  // dark-mode browser renders white text on white.
  assert.match(css, /input[^{]*,[^{]*textarea[^{]*\{[^}]*color:/s);
});

test('out-of-scope rows are tinted, never faded', () => {
  const rule = /\.row-out\b[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'expected a .row-out rule');
  assert.match(rule[1], /background:/, 'de-emphasis is by background tint');
  assert.doesNotMatch(rule[1], /opacity:\s*0?\.[0-6]/, 'must not fade the text');
});

test('reduced motion is honoured', () => {
  assert.match(css, /prefers-reduced-motion/);
});
