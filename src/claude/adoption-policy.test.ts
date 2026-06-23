import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAdopt } from './adoption-policy.js';

test('sync request for an archived session is NOT adopted (breaks the recreate loop)', () => {
  assert.equal(shouldAdopt({ source: 'sync' }, true), false);
});

test('sync request for a non-archived session IS adopted', () => {
  assert.equal(shouldAdopt({ source: 'sync' }, false), true);
});

test('explicit push (no source) adopts even an archived session — deliberate resurrect', () => {
  assert.equal(shouldAdopt({}, true), true);
  assert.equal(shouldAdopt({ source: 'push' }, true), true);
});

test('explicit push of a non-archived session is adopted', () => {
  assert.equal(shouldAdopt({}, false), true);
});
