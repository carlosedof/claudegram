import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectDir, parseSessions, compareForClobber } from './clagram.mjs';

test('encodeProjectDir replaces slashes with dashes', () => {
  assert.equal(encodeProjectDir('/workspace'), '-workspace');
  assert.equal(
    encodeProjectDir('/Users/caduolivera/Documents/projects/maxpan'),
    '-Users-caduolivera-Documents-projects-maxpan',
  );
});

test('parseSessions returns latest entry per key with a claudeSessionId, newest first', () => {
  const json = JSON.stringify({
    sessions: {
      '111': [
        { claudeSessionId: 'aaaaaaaa-0000-0000-0000-000000000000', lastMessagePreview: 'hi', lastActivity: '2026-06-13T10:00:00Z' },
      ],
      '222:3': [
        { claudeSessionId: 'bbbbbbbb-0000-0000-0000-000000000000', lastMessagePreview: 'yo', lastActivity: '2026-06-13T12:00:00Z' },
      ],
      '333': [ { lastMessagePreview: 'no id', lastActivity: '2026-06-13T13:00:00Z' } ],
    },
  });
  const out = parseSessions(json);
  assert.equal(out.length, 2);
  assert.equal(out[0].sessionKey, '222:3');
  assert.equal(out[0].claudeSessionId, 'bbbbbbbb-0000-0000-0000-000000000000');
  assert.equal(out[1].sessionKey, '111');
});

test('compareForClobber flags a newer/larger destination', () => {
  assert.equal(compareForClobber(null, { mtimeMs: 1, lines: 1 }), 'safe');
  assert.equal(compareForClobber({ mtimeMs: 100, lines: 5 }, { mtimeMs: 200, lines: 9 }), 'safe');
  assert.equal(compareForClobber({ mtimeMs: 300, lines: 5 }, { mtimeMs: 200, lines: 9 }), 'dest-newer');
  assert.equal(compareForClobber({ mtimeMs: 100, lines: 20 }, { mtimeMs: 200, lines: 9 }), 'dest-newer');
});
