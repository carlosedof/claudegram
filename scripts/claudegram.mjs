#!/usr/bin/env node
// claudegram — handoff Claude sessions between this Mac and the Telegram/VM bot.
// Pure helpers (encodeProjectDir/parseSessions/compareForClobber) are unit-tested
// in claudegram.test.mjs. The pull/push orchestration is verified manually.

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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// UUIDs of running `claude` processes that carry --session-id. Input: `ps -ww -o command=`.
export function parseLiveSessionIds(psText) {
  const ids = new Set();
  for (const line of psText.split('\n')) {
    if (!/\bclaude\b/.test(line) || !line.includes('--session-id')) continue;
    const m = line.match(new RegExp(`--session-id[ =](${UUID_RE.source})`, 'i'));
    if (m) ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

// The session's current auto-title: the last `ai-title` record's aiTitle, trimmed. null if none.
export function extractAiTitle(jsonlText) {
  let title = null;
  for (const line of jsonlText.split('\n')) {
    if (!line.includes('"ai-title"')) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
        title = o.aiTitle.trim();
      }
    } catch { /* skip malformed line */ }
  }
  return title;
}

// Inclusive recency check.
export function withinDays(mtimeMs, nowMs, days) {
  return nowMs - mtimeMs <= days * 24 * 60 * 60 * 1000;
}

// Drop candidates whose id already has a topic (existingIds) or is retired (archivedIds).
export function selectToPush(candidates, existingIds, archivedIds) {
  const skip = new Set([...existingIds, ...archivedIds]);
  return candidates.filter((c) => !skip.has(c.id));
}

// Extract the readable conversation (user asks + assistant prose) from a
// transcript, dropping tool calls, thinking, results and other noise, then
// keep the first turn (the original ask = the topic) plus the last `tailTurns`
// turns (the current state). Each turn is capped, and the whole thing is bounded
// so it's cheap to summarize. Returns '' when there's nothing readable.
export function condenseTranscript(jsonlText, opts = {}) {
  const { tailTurns = 16, perTurn = 500, maxChars = 9000 } = opts;
  const turns = [];
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const role = d.type === 'user' ? 'U' : d.type === 'assistant' ? 'A' : null;
    if (!role) continue;
    const content = d.message && d.message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) turns.push(`[${role}] ${text.slice(0, perTurn)}`);
  }
  if (!turns.length) return '';
  const head = turns[0];
  const tail = turns.length > tailTurns ? turns.slice(-tailTurns) : turns.slice(1);
  const lines = [head];
  if (turns.length > tail.length + 1) lines.push('...');
  for (const t of tail) if (t !== head) lines.push(t);
  let out = lines.join('\n');
  if (out.length > maxChars) out = head + '\n...\n' + out.slice(-(maxChars - head.length - 5));
  return out;
}

const CFG = {
  host: process.env.CLAUDEGRAM_SSH_HOST || 'contabo',
  remoteCwd: process.env.CLAUDEGRAM_REMOTE_CWD || '/workspace',
  localWorkspace: process.env.CLAUDEGRAM_LOCAL_WORKSPACE || join(homedir(), 'Documents/projects/maxpan'),
  remoteHome: process.env.CLAUDEGRAM_REMOTE_HOME || '/root',
};

const remoteProjDir = () => `${CFG.remoteHome}/.claude/projects/${encodeProjectDir(CFG.remoteCwd)}`;
const localProjDir = () => join(homedir(), '.claude', 'projects', encodeProjectDir(CFG.localWorkspace));

// Command used to open a pulled session locally. Defaults to the `claudeb`
// alias expansion (skip permission prompts). Override with CLAUDEGRAM_CLAUDE_CMD.
const CLAUDE_CMD = (process.env.CLAUDEGRAM_CLAUDE_CMD || 'claude --dangerously-skip-permissions').split(/\s+/);

function sh(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' });
}

// First line of the recap prompt. Doubles as a signature: a `claude -p` recap
// call is itself a session whose first user message is this prompt, so we use it
// to recognize and skip recap-generation transcripts (see isRecapTranscript).
const RECAP_PROMPT_HEADER =
  'Você recebe a transcrição condensada de uma sessão de trabalho com o Claude Code';

// True if a transcript is a recap-generation session (its first user message is
// the recap prompt). Those must never be synced as topics — otherwise every sync
// turns prior recap calls into junk topics, compounding each run.
export function isRecapTranscript(jsonlText) {
  for (const line of jsonlText.split('\n')) {
    if (!line.includes('"user"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user') continue;
    const c = d.message && d.message.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
    return text.includes(RECAP_PROMPT_HEADER);
  }
  return false;
}

// Generate a short recap of a session to post as the first message of its
// Telegram topic, so the title alone isn't the only context. Summarizes the
// condensed transcript with a cheap local `claude -p` call. `--no-session-persistence`
// keeps the call from writing its own transcript into ~/.claude/projects (which
// would otherwise be re-synced as junk topics). Returns null (and the bot falls
// back to just the ready line) if there's nothing to summarize or the call fails.
function generateRecap(jsonlText) {
  const condensed = condenseTranscript(jsonlText);
  if (!condensed) return null;
  const model = process.env.CLAUDEGRAM_RECAP_MODEL || 'claude-haiku-4-5';
  const prompt = [
    RECAP_PROMPT_HEADER,
    '(linhas [U]=usuário, [A]=assistente). Escreva um recap em português de 2 a 4 linhas',
    'curtas para servir de contexto no topo de um tópico do Telegram: do que se trata,',
    'o que foi feito/decidido, e o estado atual. Sem saudação, sem markdown, sem listas,',
    'apenas o texto do recap.',
    '',
    '--- TRANSCRIÇÃO ---',
    condensed,
  ].join('\n');
  try {
    const out = execFileSync('claude', ['-p', '--no-session-persistence', '--model', model], {
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const recap = (out || '').trim();
    return recap ? recap.slice(0, 600) : null;
  } catch {
    return null;
  }
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

function readRemoteSessions() {
  return sh('ssh', [CFG.host, 'docker', 'exec', 'claudegram', 'cat', '/root/.claudegram/sessions.json']);
}

function readRemoteArchived() {
  try {
    const txt = sh('ssh', [CFG.host, 'docker', 'exec', 'claudegram', 'sh', '-c',
      'cat /root/.claudegram/archived.json 2>/dev/null || echo "{}"']);
    const o = JSON.parse(txt);
    return Array.isArray(o.ids) ? o.ids : [];
  } catch {
    return [];
  }
}

// Drop a control file the bot's reconcile watcher consumes, then wait until it's
// processed so the archived list is fresh BEFORE we decide what to push.
// Reconcile probes every known topic (one rate-limited reopenForumTopic call
// each), so it can take a while with many topics — we must wait for it to finish,
// otherwise a session archived by reconcile gets re-pushed in the same run.
async function triggerReconcile() {
  const req = JSON.stringify({ ts: new Date().toISOString() });
  const maxWaitMs = Number(process.env.CLAUDEGRAM_RECONCILE_WAIT_MS || 180000);
  try {
    execFileSync('ssh', [CFG.host,
      `docker exec -i claudegram sh -c 'mkdir -p /root/.claudegram/handoff-inbox && cat > /root/.claudegram/handoff-inbox/_reconcile.json'`],
      { input: req, encoding: 'utf8' });
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const exists = sh('ssh', [CFG.host,
        `docker exec claudegram sh -c 'test -f /root/.claudegram/handoff-inbox/_reconcile.json && echo yes || echo no'`]).trim();
      if (exists === 'no') return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.error('  (reconcile did not finish within wait window; proceeding — a stale delete may re-sync once)');
  } catch {
    // best-effort: dedup still holds via the existing-sessions check
  }
}

async function cmdSync() {
  const now = Date.now();
  const DAYS = Number(process.env.CLAUDEGRAM_SYNC_DAYS || 7);

  // 1. Live sessions = running `claude` procs carrying --session-id.
  let liveIds = [];
  try { liveIds = parseLiveSessionIds(sh('ps', ['-ww', '-o', 'command='])); } catch { liveIds = []; }
  const liveSet = new Set(liveIds);

  // 2. Candidate transcripts across every local project: live OR mtime within DAYS.
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const candidates = [];
  const seen = new Set();
  let projDirs = [];
  try { projDirs = readdirSync(projectsRoot); } catch { projDirs = []; }
  for (const pd of projDirs) {
    const dir = join(projectsRoot, pd);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '');
      if (seen.has(id)) continue;
      const full = join(dir, f);
      let mtimeMs;
      try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
      const live = liveSet.has(id);
      if (!live && !withinDays(mtimeMs, now, DAYS)) continue;
      seen.add(id);
      let text = '';
      try { text = readFileSync(full, 'utf8'); } catch { continue; }
      // Skip recap-generation sessions so they never become topics.
      if (isRecapTranscript(text)) continue;
      const title = extractAiTitle(text);
      candidates.push({ id, path: full, name: title, status: live ? 'live' : 'ended' });
    }
  }
  if (!candidates.length) {
    console.log(`No live or recent (≤${DAYS}d) sessions to sync.`);
    return;
  }

  // 3. Reconcile deleted topics, then read what the VM already has + what's retired.
  await triggerReconcile();
  const existingIds = parseSessions(readRemoteSessions()).map((s) => s.claudeSessionId);
  const archivedIds = readRemoteArchived();

  // 4. Push only sessions without a topic and not retired.
  const toPush = selectToPush(candidates, existingIds, archivedIds);
  let created = 0;
  const wantRecap = !process.env.CLAUDEGRAM_NO_RECAP;
  for (const c of toPush) {
    sh('scp', [c.path, `${CFG.host}:${remoteProjDir()}/${c.id}.jsonl`]);
    let recap = null;
    if (wantRecap) {
      try { recap = generateRecap(readFileSync(c.path, 'utf8')); } catch { recap = null; }
    }
    const req = JSON.stringify({ id: c.id, name: c.name, status: c.status, recap, ts: new Date().toISOString() });
    execFileSync('ssh', [CFG.host,
      `docker exec -i claudegram sh -c 'mkdir -p /root/.claudegram/handoff-inbox && cat > /root/.claudegram/handoff-inbox/${c.id}.json'`],
      { input: req, encoding: 'utf8' });
    created++;
    console.log(`  + ${c.status === 'live' ? '🟢' : '💤'} ${c.name || c.id}${recap ? ' 📋' : ''}`);
  }
  console.log(`\nSynced: ${created} new topic(s) · ${candidates.length - toPush.length} already existed/retired · ${liveSet.size} live.`);
  if (created) console.log('Open Telegram — topics appear within a few seconds.');
}

// Only dispatch when run directly (not when imported by the test file), so
// `node --test` importing this module has zero side effects.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
const isMain = import.meta.url === pathToFileURL(invoked).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'pull') cmdPull();
  else if (cmd === 'push') cmdPush();
  else if (cmd === 'sync') cmdSync();
  else { console.error('Usage: claudegram pull | push [<id>] | sync'); process.exit(1); }
}
