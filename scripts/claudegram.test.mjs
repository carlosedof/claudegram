import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectDir, parseSessions, compareForClobber } from './claudegram.mjs';
import {
  parseLiveSessionIds,
  extractAiTitle,
  withinDays,
  selectToPush,
} from './claudegram.mjs';

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

test('compareForClobber refuses only when destination has more lines', () => {
  assert.equal(compareForClobber(null, { lines: 1 }), 'safe');
  assert.equal(compareForClobber({ lines: 5 }, { lines: 9 }), 'safe');       // dest behind -> overwrite ok
  assert.equal(compareForClobber({ lines: 9 }, { lines: 9 }), 'safe');       // equal -> ok
  assert.equal(compareForClobber({ lines: 20 }, { lines: 9 }), 'dest-newer'); // dest ahead -> refuse
});

test('parseLiveSessionIds extracts uuids from claude proc lines, ignores others', () => {
  const ps = [
    '/Users/x/.local/bin/claude --session-id a2b24ece-e1d2-45a5-9ba0-7776f34140c3 --settings /tmp/s',
    'node /app/server/index.js',
    '/Users/x/.local/bin/claude --session-id DD02ACC9-9F4E-4387-A682-B1AFD6CBC626',
    'node /Users/x/bin/claudegram sync',
  ].join('\n');
  const ids = parseLiveSessionIds(ps);
  assert.deepEqual(ids.sort(), [
    'a2b24ece-e1d2-45a5-9ba0-7776f34140c3',
    'dd02acc9-9f4e-4387-a682-b1afd6cbc626',
  ]);
});

test('extractAiTitle returns the last ai-title, trimmed; null when absent', () => {
  const jsonl = [
    '{"type":"user","message":{"content":"hi"}}',
    '{"type":"ai-title","aiTitle":"First title","sessionId":"x"}',
    '{"type":"assistant"}',
    '{"type":"ai-title","aiTitle":"  Final title  ","sessionId":"x"}',
  ].join('\n');
  assert.equal(extractAiTitle(jsonl), 'Final title');
  assert.equal(extractAiTitle('{"type":"user"}\n{"type":"assistant"}'), null);
});

test('withinDays is inclusive at the boundary', () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  assert.equal(withinDays(now - 7 * day, now, 7), true);   // exactly 7d -> in
  assert.equal(withinDays(now - 7 * day - 1, now, 7), false); // just over -> out
  assert.equal(withinDays(now, now, 7), true);
});

test('selectToPush drops ids already having a topic or archived', () => {
  const candidates = [{ id: 'keep' }, { id: 'has-topic' }, { id: 'retired' }];
  const out = selectToPush(candidates, ['has-topic'], ['retired']);
  assert.deepEqual(out.map((c) => c.id), ['keep']);
});
