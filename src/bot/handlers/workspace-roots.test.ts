import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWorkspaceRoots } from './workspace-roots.js';

function ent(name: string, dir: boolean) {
  return { name, isDirectory: () => dir };
}

test('returns visible directories, sorted', () => {
  const entries = [ent('pessoal', true), ent('maxpan', true)];
  assert.deepEqual(pickWorkspaceRoots(entries), ['maxpan', 'pessoal']);
});

test('drops dotfiles/dotdirs and non-directories', () => {
  const entries = [
    ent('maxpan', true),
    ent('.claudegram', true), // hidden state dir
    ent('CLAUDE.md', false), // file
    ent('pessoal', true),
  ];
  assert.deepEqual(pickWorkspaceRoots(entries), ['maxpan', 'pessoal']);
});

test('empty when nothing qualifies', () => {
  assert.deepEqual(pickWorkspaceRoots([ent('CLAUDE.md', false), ent('.git', true)]), []);
});
