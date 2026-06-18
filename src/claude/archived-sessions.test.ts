import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArchivedSessions } from './archived-sessions.js';

function tmpFile(): string {
  return path.join(os.tmpdir(), `archived-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

test('add persists, dedups, and survives reload', () => {
  const f = tmpFile();
  const a = new ArchivedSessions(f);
  a.add('id-1');
  a.add('id-1');
  a.add('id-2');
  assert.deepEqual(a.all().sort(), ['id-1', 'id-2']);

  const b = new ArchivedSessions(f);
  assert.equal(b.has('id-1'), true);
  assert.equal(b.has('id-3'), false);
  assert.deepEqual(b.all().sort(), ['id-1', 'id-2']);
  fs.unlinkSync(f);
});

test('missing file starts empty', () => {
  const a = new ArchivedSessions(tmpFile());
  assert.deepEqual(a.all(), []);
});
