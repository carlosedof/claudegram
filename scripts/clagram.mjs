#!/usr/bin/env node
// clagram — handoff Claude sessions between this Mac and the Telegram/VM bot.
// Pure helpers (encodeProjectDir/parseSessions/compareForClobber) are unit-tested
// in clagram.test.mjs. The pull/push orchestration is verified manually.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

export function encodeProjectDir(cwd) {
  return cwd.replace(/\//g, '-');
}

export function parseSessions(jsonString) {
  const data = JSON.parse(jsonString);
  const out = [];
  for (const [sessionKey, entries] of Object.entries(data.sessions || {})) {
    const entry = (entries || []).find((e) => e && e.claudeSessionId);
    if (entry) {
      out.push({
        sessionKey,
        claudeSessionId: entry.claudeSessionId,
        preview: entry.lastMessagePreview || '',
        lastActivity: entry.lastActivity || '',
      });
    }
  }
  out.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  return out;
}

// dest/src: null or { lines: number }. The transcript is append-only, so more
// lines = more content. Refuse only if the destination is strictly ahead.
export function compareForClobber(dest, src) {
  if (!dest) return 'safe';
  return dest.lines > src.lines ? 'dest-newer' : 'safe';
}

const CFG = {
  host: process.env.CLAGRAM_SSH_HOST || 'contabo',
  remoteCwd: process.env.CLAGRAM_REMOTE_CWD || '/workspace',
  localWorkspace: process.env.CLAGRAM_LOCAL_WORKSPACE || join(homedir(), 'Documents/projects/maxpan'),
  remoteHome: process.env.CLAGRAM_REMOTE_HOME || '/root',
};

const remoteProjDir = () => `${CFG.remoteHome}/.claude/projects/${encodeProjectDir(CFG.remoteCwd)}`;
const localProjDir = () => join(homedir(), '.claude', 'projects', encodeProjectDir(CFG.localWorkspace));

// Command used to open a pulled session locally. Defaults to the `claudeb`
// alias expansion (skip permission prompts). Override with CLAGRAM_CLAUDE_CMD.
const CLAUDE_CMD = (process.env.CLAGRAM_CLAUDE_CMD || 'claude --dangerously-skip-permissions').split(/\s+/);

function sh(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' });
}

function fileMeta(p) {
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').split('\n').length;
  return { mtimeMs: statSync(p).mtimeMs, lines };
}

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function cmdPull() {
  const json = sh('ssh', [CFG.host, 'docker', 'exec', 'claudegram', 'cat', '/root/.claudegram/sessions.json']);
  const sessions = parseSessions(json);
  if (!sessions.length) { console.error('No sessions with a claudeSessionId on the VM.'); process.exit(1); }
  sessions.forEach((s, i) => console.log(`[${i}] ${s.claudeSessionId}  ${s.sessionKey}  ${s.preview}`));
  const pick = sessions[Number(await ask('Pick a session #: '))];
  if (!pick) { console.error('Invalid choice.'); process.exit(1); }
  const id = pick.claudeSessionId;
  const dest = join(localProjDir(), `${id}.jsonl`);
  mkdirSync(localProjDir(), { recursive: true });
  const force = process.argv.includes('--force');
  const remoteLines = Number(sh('ssh', [CFG.host, `wc -l < ${remoteProjDir()}/${id}.jsonl`]).trim()) + 1;
  if (!force && compareForClobber(fileMeta(dest), { lines: remoteLines }) === 'dest-newer') {
    console.error(`Local copy looks newer/larger than the VM's. Re-run with --force to overwrite.`);
    process.exit(1);
  }
  sh('scp', [`${CFG.host}:${remoteProjDir()}/${id}.jsonl`, dest]);
  const launchLine = `${CLAUDE_CMD.join(' ')} --resume ${id}`;
  if (process.argv.includes('--print')) {
    console.log(`\nPulled. Continue with:\n  cd ${CFG.localWorkspace} && ${launchLine}`);
    return;
  }
  console.log(`\nPulled. Resuming ${id} in ${CFG.localWorkspace} ...\n`);
  const r = spawnSync(CLAUDE_CMD[0], [...CLAUDE_CMD.slice(1), '--resume', id], { cwd: CFG.localWorkspace, stdio: 'inherit' });
  if (r.error) {
    console.log(`Could not launch ${CLAUDE_CMD[0]} (${r.error.message}). Run manually:\n  cd ${CFG.localWorkspace} && ${launchLine}`);
    process.exit(1);
  }
  process.exit(r.status ?? 0);
}

async function cmdPush() {
  let id = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
  if (!id) {
    const dir = localProjDir();
    const jsonls = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)
      : [];
    if (!jsonls.length) { console.error('No local sessions found; pass an explicit <id>.'); process.exit(1); }
    id = jsonls[0].f.replace(/\.jsonl$/, '');
  }
  const src = join(localProjDir(), `${id}.jsonl`);
  if (!existsSync(src)) { console.error(`Local session ${id} not found at ${src}`); process.exit(1); }
  const force = process.argv.includes('--force');
  const remoteExists = sh('ssh', [CFG.host, `test -f ${remoteProjDir()}/${id}.jsonl && echo yes || echo no`]).trim() === 'yes';
  if (remoteExists && !force) {
    const remoteLines = Number(sh('ssh', [CFG.host, `wc -l < ${remoteProjDir()}/${id}.jsonl`]).trim()) + 1;
    if (compareForClobber({ lines: remoteLines }, fileMeta(src)) === 'dest-newer') {
      console.error(`VM copy looks newer/larger. Re-run with --force to overwrite.`);
      process.exit(1);
    }
  }
  sh('scp', [src, `${CFG.host}:${remoteProjDir()}/${id}.jsonl`]);
  // Ask the bot to auto-create a topic and adopt the session (no manual /adopt).
  const nameIdx = process.argv.indexOf('--name');
  const name = nameIdx !== -1 ? (process.argv[nameIdx + 1] || null) : null;
  const req = JSON.stringify({ id, name, ts: new Date().toISOString() });
  execFileSync('ssh', [CFG.host,
    `docker exec -i claudegram sh -c 'mkdir -p /root/.claudegram/handoff-inbox && cat > /root/.claudegram/handoff-inbox/${id}.json'`],
    { input: req, encoding: 'utf8' });
  console.log(`\nPushed. The bot will create a new Telegram topic with this session shortly - open Telegram.`);
  console.log(`(Fallback if it does not appear: send "/adopt ${id}" in any topic.)`);
}

// Only dispatch when run directly (not when imported by the test file), so
// `node --test` importing this module has zero side effects.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
const isMain = import.meta.url === pathToFileURL(invoked).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'pull') cmdPull();
  else if (cmd === 'push') cmdPush();
  else { console.error('Usage: clagram pull | push [<id>]'); process.exit(1); }
}
