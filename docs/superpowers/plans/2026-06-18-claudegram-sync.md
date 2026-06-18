# Claudegram `sync` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `claudegram sync` command that creates one Telegram topic per relevant local Claude session (live + active in the last 7 days), named by the session's auto-title and marked live/ended, with topics retired when closed or deleted in Telegram.

**Architecture:** The CLI (`scripts/claudegram.mjs`, an importable ESM script copied to `~/bin/claudegram`) discovers sessions, filters, and reuses the existing handoff-inbox push path. The bot gains a status-aware topic name, a `forum_topic_closed` handler that archives + deletes the topic, and a reconcile watcher that archives topics deleted out-of-band (Telegram emits no delete event).

**Tech Stack:** Node ESM (`node --test`) for the CLI; TypeScript + grammY + tsx for the bot. Bot deploys from `main` via the VM's 15-min autodeploy.

## Global Constraints

- Bot source files are TypeScript with `.js` import specifiers (e.g. `import { x } from './foo.js'`). Match this.
- Node `>=20`. CLI tests run with `node --test`; bot tests run with `node --import tsx --test <file>`.
- The bot state dir is `~/.claudegram/` (on the VM, `/root/.claudegram/`). New state file: `~/.claudegram/archived.json` shaped `{ "ids": ["<uuid>", ...] }`.
- Persisted writes use `atomicWriteFileSync` from `src/utils/atomic-write.js`.
- Session keys: `"<chatId>"` for plain chats, `"<chatId>:<threadId>"` for forum topics. Use `buildSessionKey` / `parseSessionKey` from `src/utils/session-key.js`.
- Status values are exactly `'live'` and `'ended'`. Topic-name emoji: `🟢` live, `💤` ended, `🔄` unknown/fallback.
- Per repo `CLAUDE.md`: any user-facing feature change MUST update `docs/index.html` (feature card).
- Merging to `main` (which triggers deploy) requires explicit per-merge approval from the user. Open the PR; do not merge unprompted.
- The CLI source of truth is `scripts/claudegram.mjs`; `~/bin/claudegram` is a copy that must be re-synced after edits.

---

### Task 1: CLI pure helpers

**Files:**
- Modify: `scripts/claudegram.mjs` (add four exported functions near the existing exports at the top)
- Test: `scripts/claudegram.test.mjs` (append tests)

**Interfaces:**
- Produces:
  - `parseLiveSessionIds(psText: string) => string[]` — lowercased UUIDs of running `claude` processes carrying `--session-id`.
  - `extractAiTitle(jsonlText: string) => string | null` — the last `ai-title` record's `aiTitle`, trimmed; null if none.
  - `withinDays(mtimeMs: number, nowMs: number, days: number) => boolean` — inclusive at the boundary.
  - `selectToPush(candidates: {id:string}[], existingIds: string[], archivedIds: string[]) => {id:string}[]` — candidates minus ids present in either set.

- [ ] **Step 1: Write the failing tests** — append to `scripts/claudegram.test.mjs`:

```js
import {
  parseLiveSessionIds,
  extractAiTitle,
  withinDays,
  selectToPush,
} from './claudegram.mjs';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Documents/projects/claudegram && node --test scripts/claudegram.test.mjs`
Expected: FAIL — `SyntaxError`/`does not provide an export named 'parseLiveSessionIds'`.

- [ ] **Step 3: Implement the helpers** — in `scripts/claudegram.mjs`, add after the existing `compareForClobber` export (before `const CFG = {`):

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Documents/projects/claudegram && node --test scripts/claudegram.test.mjs`
Expected: PASS — all tests (existing + 4 new) green.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/projects/claudegram
git add scripts/claudegram.mjs scripts/claudegram.test.mjs
git commit -m "feat(cli): add sync helpers (live ids, ai-title, recency, skip)"
```

---

### Task 2: `claudegram sync` orchestration + dispatch

**Files:**
- Modify: `scripts/claudegram.mjs` (add `cmdSync` + remote helpers; wire dispatch; update usage)
- Modify: `docs/index.html` (feature card)
- Sync: copy `scripts/claudegram.mjs` → `~/bin/claudegram`

**Interfaces:**
- Consumes: `parseLiveSessionIds`, `extractAiTitle`, `withinDays`, `selectToPush` (Task 1); existing in-file `sh`, `CFG`, `remoteProjDir`, `parseSessions`, `encodeProjectDir`.
- Produces: a `sync` subcommand. No new exports (orchestration is impure; verified manually).

- [ ] **Step 1: Add the remote helpers + `cmdSync`** — in `scripts/claudegram.mjs`, add after the existing `cmdPush` function (before the dispatch block near the bottom):

```js
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

// Drop a control file the bot's reconcile watcher consumes; wait (best-effort) for it
// to be processed so the archived list is fresh before we decide what to push.
async function triggerReconcile() {
  const req = JSON.stringify({ ts: new Date().toISOString() });
  try {
    execFileSync('ssh', [CFG.host,
      `docker exec -i claudegram sh -c 'mkdir -p /root/.claudegram/handoff-inbox && cat > /root/.claudegram/handoff-inbox/_reconcile.json'`],
      { input: req, encoding: 'utf8' });
    for (let i = 0; i < 16; i++) {
      const exists = sh('ssh', [CFG.host,
        `docker exec claudegram sh -c 'test -f /root/.claudegram/handoff-inbox/_reconcile.json && echo yes || echo no'`]).trim();
      if (exists === 'no') return;
      await new Promise((r) => setTimeout(r, 500));
    }
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
      let title = null;
      try { title = extractAiTitle(readFileSync(full, 'utf8')); } catch { /* no title */ }
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
  for (const c of toPush) {
    sh('scp', [c.path, `${CFG.host}:${remoteProjDir()}/${c.id}.jsonl`]);
    const req = JSON.stringify({ id: c.id, name: c.name, status: c.status, ts: new Date().toISOString() });
    execFileSync('ssh', [CFG.host,
      `docker exec -i claudegram sh -c 'mkdir -p /root/.claudegram/handoff-inbox && cat > /root/.claudegram/handoff-inbox/${c.id}.json'`],
      { input: req, encoding: 'utf8' });
    created++;
    console.log(`  + ${c.status === 'live' ? '🟢' : '💤'} ${c.name || c.id}`);
  }
  console.log(`\nSynced: ${created} new topic(s) · ${candidates.length - toPush.length} already existed/retired · ${liveSet.size} live.`);
  if (created) console.log('Open Telegram — topics appear within a few seconds.');
}
```

- [ ] **Step 2: Wire the dispatch + usage** — in `scripts/claudegram.mjs`, replace the existing dispatch block:

Old:
```js
  if (cmd === 'pull') cmdPull();
  else if (cmd === 'push') cmdPush();
  else { console.error('Usage: claudegram pull | push [<id>]'); process.exit(1); }
```
New:
```js
  if (cmd === 'pull') cmdPull();
  else if (cmd === 'push') cmdPush();
  else if (cmd === 'sync') cmdSync();
  else { console.error('Usage: claudegram pull | push [<id>] | sync'); process.exit(1); }
```

- [ ] **Step 3: Syntax-check and re-run the unit tests**

Run: `cd ~/Documents/projects/claudegram && node --check scripts/claudegram.mjs && node --test scripts/claudegram.test.mjs`
Expected: no syntax errors; all tests PASS.

- [ ] **Step 4: Sync the CLI copy on PATH**

Run: `cp ~/Documents/projects/claudegram/scripts/claudegram.mjs ~/bin/claudegram && chmod +x ~/bin/claudegram`
Expected: no output. Then `claudegram` with no args prints `Usage: claudegram pull | push [<id>] | sync`.

- [ ] **Step 5: Update the website** — in `docs/index.html`, add inside the features grid (use the existing `feature-card` markup, `data-category="session"`):

```html
<div class="feature-card" data-category="session">
  <div class="feature-icon">🔭</div>
  <h3>Bulk Session Sync</h3>
  <p>Run <code>claudegram sync</code> on your Mac to mirror every live or recently-active Claude session into its own Telegram topic, named by the session's title. Close or delete a topic to retire that session.</p>
</div>
```

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/projects/claudegram
git add scripts/claudegram.mjs docs/index.html
git commit -m "feat(cli): claudegram sync — bulk session→topic with reconcile"
```

---

### Task 3: Bot — archived-sessions store

**Files:**
- Create: `src/claude/archived-sessions.ts`
- Test: `src/claude/archived-sessions.test.ts`
- Modify: `tsconfig.json` (exclude test files from the build), `package.json` (add `test` script)

**Interfaces:**
- Produces:
  - `class ArchivedSessions` with `constructor(file?: string)`, `has(id: string): boolean`, `add(id: string): void`, `all(): string[]`.
  - `const archivedSessions: ArchivedSessions` — singleton backed by `~/.claudegram/archived.json`.

- [ ] **Step 1: Write the failing test** — create `src/claude/archived-sessions.test.ts`:

```ts
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
```

- [ ] **Step 2: Add the `test` script** — in `package.json`, add to `"scripts"`:

```json
    "test": "node --import tsx --test src/claude/archived-sessions.test.ts"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/Documents/projects/claudegram && npm test`
Expected: FAIL — cannot find module `./archived-sessions.js`.

- [ ] **Step 4: Implement the store** — create `src/claude/archived-sessions.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

interface ArchivedData {
  ids: string[];
}

/**
 * Set of Claude session ids whose Telegram topic was retired (closed or deleted).
 * `claudegram sync` reads this to permanently exclude them from future syncs.
 */
export class ArchivedSessions {
  private ids = new Set<string>();

  constructor(private file: string = path.join(os.homedir(), '.claudegram', 'archived.json')) {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as ArchivedData;
        if (Array.isArray(parsed.ids)) this.ids = new Set(parsed.ids);
      }
    } catch (err) {
      console.error('[archived] load failed, starting empty:', err instanceof Error ? err.message : String(err));
      this.ids = new Set();
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(this.file, JSON.stringify({ ids: [...this.ids] }, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('[archived] save failed:', err instanceof Error ? err.message : String(err));
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.save();
  }

  all(): string[] {
    return [...this.ids];
  }
}

export const archivedSessions = new ArchivedSessions();
```

- [ ] **Step 5: Exclude tests from the production build** — in `tsconfig.json`, change the `exclude` array:

Old:
```json
  "exclude": ["node_modules", "dist"]
```
New:
```json
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
```

- [ ] **Step 6: Run test + typecheck to verify they pass**

Run: `cd ~/Documents/projects/claudegram && npm test && npm run typecheck`
Expected: tests PASS; typecheck exits 0 with no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/projects/claudegram
git add src/claude/archived-sessions.ts src/claude/archived-sessions.test.ts tsconfig.json package.json
git commit -m "feat(bot): archived-sessions store for retired topics"
```

---

### Task 4: Bot — status-aware handoff inbox + ignore control files

**Files:**
- Modify: `src/claude/handoff-inbox.ts`

**Interfaces:**
- Consumes: handoff request JSON now optionally carries `status: 'live' | 'ended'` (written by `cmdSync`, Task 2).
- Produces: topic names prefixed with `🟢`/`💤`/`🔄`; status-tailored ready message; control files (`_`-prefixed) ignored by the session loop.

- [ ] **Step 1: Ignore control files in the inbox scan** — in `src/claude/handoff-inbox.ts`, edit the `readdirSync` filter:

Old:
```js
      files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.json'));
```
New:
```js
      files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
```

- [ ] **Step 2: Widen the request type** — in `src/claude/handoff-inbox.ts`, edit the request declaration:

Old:
```js
      let req: { id?: string; name?: string | null };
```
New:
```js
      let req: { id?: string; name?: string | null; status?: string };
```

- [ ] **Step 3: Build a status-prefixed topic name** — in `src/claude/handoff-inbox.ts`, replace the name line inside the `try` block:

Old:
```js
        const name = (req.name || deriveName(transcript)).slice(0, 60);
        const topic = await bot.api.createForumTopic(groupId, name);
```
New:
```js
        const status = req.status === 'live' ? 'live' : req.status === 'ended' ? 'ended' : undefined;
        const emoji = status === 'live' ? '🟢' : status === 'ended' ? '💤' : '🔄';
        const raw = (req.name && req.name.trim())
          ? req.name.trim()
          : deriveName(transcript).replace(/^🔄\s*/, '');
        const name = `${emoji} ${raw}`.slice(0, 60);
        const topic = await bot.api.createForumTopic(groupId, name);
```

- [ ] **Step 4: Tailor the ready message by status** — in `src/claude/handoff-inbox.ts`, replace the `sendMessage` call:

Old:
```js
        await bot.api.sendMessage(
          groupId,
          '✅ Sessão do Mac pronta aqui. Manda uma mensagem pra continuar de onde parou.',
          { message_thread_id: threadId },
        );
```
New:
```js
        const ready = status === 'live'
          ? '🟢 Sessão do Mac (ainda rodando lá) pronta aqui. Continuar por aqui enquanto roda no Mac pode divergir o histórico.'
          : '✅ Sessão do Mac pronta aqui. Manda uma mensagem pra continuar de onde parou.';
        await bot.api.sendMessage(groupId, ready, { message_thread_id: threadId });
```

- [ ] **Step 5: Typecheck**

Run: `cd ~/Documents/projects/claudegram && npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/projects/claudegram
git add src/claude/handoff-inbox.ts
git commit -m "feat(bot): status-aware handoff topics; ignore _control files"
```

---

### Task 5: Bot — retire-on-close handler

**Files:**
- Create: `src/bot/handlers/topic-closed.handler.ts`
- Modify: `src/bot/bot.ts` (import + register handler)

**Interfaces:**
- Consumes: `sessionManager` (`getSession`, `clearSession`), `sessionHistory` (`getLastSession`, `clearHistory`), `archivedSessions.add` (Task 3), `buildSessionKey`.
- Produces: `handleTopicClosed(ctx: Context): Promise<void>`.

- [ ] **Step 1: Create the handler** — create `src/bot/handlers/topic-closed.handler.ts`:

```ts
import { Context } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import { sessionHistory } from '../../claude/session-history.js';
import { archivedSessions } from '../../claude/archived-sessions.js';
import { buildSessionKey } from '../../utils/session-key.js';

/**
 * When a forum topic is closed, retire its session (so `claudegram sync` never
 * recreates it) and delete the topic to keep the topic list clean.
 */
export async function handleTopicClosed(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (chatId === undefined || threadId === undefined) return;

  const sessionKey = buildSessionKey(chatId, threadId);
  const claudeSessionId =
    sessionManager.getSession(sessionKey)?.claudeSessionId ??
    sessionHistory.getLastSession(sessionKey)?.claudeSessionId;

  if (claudeSessionId) archivedSessions.add(claudeSessionId);
  sessionManager.clearSession(sessionKey);
  sessionHistory.clearHistory(sessionKey);

  try {
    await ctx.api.deleteForumTopic(chatId, threadId);
  } catch (err) {
    console.error('[topic-closed] delete failed:', err instanceof Error ? err.message : String(err));
  }
  console.log(`[topic-closed] retired ${sessionKey} (${claudeSessionId ?? 'no session'})`);
}
```

- [ ] **Step 2: Register the handler** — in `src/bot/bot.ts`, add the import alongside the other handler imports (near the top), and the registration next to the other `bot.on('message:...')` lines (e.g. just before `bot.on('message:voice', handleVoice);`):

Import:
```ts
import { handleTopicClosed } from './handlers/topic-closed.handler.js';
```
Registration:
```ts
  // Retire + delete a session's topic when the user closes it.
  bot.on('message:forum_topic_closed', handleTopicClosed);
```

- [ ] **Step 3: Typecheck**

Run: `cd ~/Documents/projects/claudegram && npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/projects/claudegram
git add src/bot/handlers/topic-closed.handler.ts src/bot/bot.ts
git commit -m "feat(bot): retire + delete session topic on forum_topic_closed"
```

---

### Task 6: Bot — reconcile watcher for deleted topics

**Files:**
- Create: `src/claude/reconcile.ts`
- Modify: `src/index.ts` (start the watcher)

**Interfaces:**
- Consumes: `sessionHistory.getAllActiveSessions`/`clearHistory`, `sessionManager.clearSession`, `archivedSessions.add`, `parseSessionKey`, grammY `Bot` + `GrammyError`.
- Produces: `reconcileDeletedTopics(bot: Bot): Promise<number>`, `startReconcileWatcher(bot: Bot): void`.

- [ ] **Step 1: Create the reconcile module** — create `src/claude/reconcile.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bot, GrammyError } from 'grammy';
import { sessionHistory } from './session-history.js';
import { sessionManager } from './session-manager.js';
import { archivedSessions } from './archived-sessions.js';
import { parseSessionKey } from '../utils/session-key.js';

const CONTROL = path.join(os.homedir(), '.claudegram', 'handoff-inbox', '_reconcile.json');
const POLL_MS = 2000;

// Telegram has no read-only "get topic" call, so we poke a typing action: a
// deleted thread responds with "message thread not found".
async function threadExists(bot: Bot, chatId: number, threadId: number): Promise<boolean> {
  try {
    await bot.api.sendChatAction(chatId, 'typing', { message_thread_id: threadId });
    return true;
  } catch (err) {
    const desc = err instanceof GrammyError ? err.description
      : err instanceof Error ? err.message : String(err);
    if (/thread not found/i.test(desc)) return false;
    return true; // unknown error: assume it exists, never false-archive
  }
}

/** Archive every known forum session whose topic was deleted out-of-band. Returns count archived. */
export async function reconcileDeletedTopics(bot: Bot): Promise<number> {
  let archived = 0;
  for (const [sessionKey, entry] of sessionHistory.getAllActiveSessions()) {
    const { chatId, threadId } = parseSessionKey(sessionKey);
    if (threadId === undefined) continue; // plain chat, no topic to reconcile
    if (await threadExists(bot, chatId, threadId)) continue;
    if (entry.claudeSessionId) archivedSessions.add(entry.claudeSessionId);
    sessionManager.clearSession(sessionKey);
    sessionHistory.clearHistory(sessionKey);
    archived++;
    console.log(`[reconcile] topic gone for ${sessionKey} → archived ${entry.claudeSessionId ?? '(none)'}`);
  }
  return archived;
}

/** Watch for the CLI's `_reconcile.json` control file and reconcile when it appears. */
export function startReconcileWatcher(bot: Bot): void {
  setInterval(async () => {
    if (!fs.existsSync(CONTROL)) return;
    try {
      const n = await reconcileDeletedTopics(bot);
      console.log(`[reconcile] done — archived ${n} deleted topic(s)`);
    } catch (err) {
      console.error('[reconcile] failed:', err instanceof Error ? err.message : String(err));
    } finally {
      try { fs.unlinkSync(CONTROL); } catch { /* ignore */ }
    }
  }, POLL_MS);
  console.log(`[reconcile] watching ${CONTROL} (every ${POLL_MS}ms)`);
}
```

- [ ] **Step 2: Start the watcher** — in `src/index.ts`, add the import next to `startHandoffInbox`, and the call right after `startHandoffInbox(bot);`:

Import:
```ts
import { startReconcileWatcher } from './claude/reconcile.js';
```
Call (after `startHandoffInbox(bot);`):
```ts
  // Reconcile topics deleted in Telegram (no delete event exists) when `claudegram sync` asks.
  startReconcileWatcher(bot);
```

- [ ] **Step 3: Typecheck**

Run: `cd ~/Documents/projects/claudegram && npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/projects/claudegram
git add src/claude/reconcile.ts src/index.ts
git commit -m "feat(bot): reconcile + archive topics deleted out-of-band"
```

---

### Task 7: Integration verification + PR

**Files:** none (verification + delivery)

- [ ] **Step 1: Full local gate**

Run: `cd ~/Documents/projects/claudegram && npm test && npm run typecheck && npm run build && node --check scripts/claudegram.mjs`
Expected: tests PASS; typecheck 0 errors; build emits `dist/` with no error; CLI syntax OK.

- [ ] **Step 2: Push branch and open a draft PR (do NOT merge)**

```bash
cd ~/Documents/projects/claudegram
git push -u origin feat/claudegram-sync
gh pr create --draft --base main --title "feat: claudegram sync (bulk session→topic handoff)" \
  --body "Implements docs/superpowers/specs/2026-06-18-claudegram-sync-design.md. CLI \`sync\` + status-aware topics + retire-on-close + reconcile-on-delete. Merge to main triggers VM autodeploy — awaiting explicit approval."
```
Expected: PR URL printed. Stop here for review; merging needs explicit user OK (deploy is automatic from `main`).

- [ ] **Step 3: Post-merge end-to-end check (only after the user approves the merge and ≤15-min autodeploy runs)**

Verify on the VM and in Telegram:
- `ssh contabo "docker logs claudegram --tail 20"` shows `[reconcile] watching …`.
- Run `claudegram sync` locally → new topics appear, named `🟢 …` (live) / `💤 …` (ended); re-running creates no duplicates (`already existed/retired` count rises).
- Close a topic in Telegram → it is deleted; `ssh contabo "docker exec claudegram cat /root/.claudegram/archived.json"` contains that session id; next `sync` does not recreate it.
- Delete a topic in Telegram → next `sync` (which triggers reconcile) adds its id to `archived.json` and does not recreate it.
- **Probe validation:** confirm the deleted-topic case actually archived (proves the `sendChatAction` "thread not found" probe works). If it does not, fall back to close-only retirement and note it in the PR.

---

## Self-Review

**Spec coverage:**
- `claudegram sync` command → Task 2. ✓
- Live vs ended detection → Task 1 (`parseLiveSessionIds`) + Task 2 (status). ✓
- Name = aiTitle with fallback → Task 1 (`extractAiTitle`) + Task 4 (deriveName fallback). ✓
- 7-day window → Task 1 (`withinDays`) + Task 2. ✓
- Idempotency (skip existing) → Task 1 (`selectToPush`) + Task 2. ✓
- Retire on close (archive + delete topic) → Task 5. ✓
- Retire on delete (reconcile, no delete event) → Task 6 + Task 2 (`triggerReconcile`). ✓
- `archived.json` store → Task 3. ✓
- Status emoji + live warning → Task 4. ✓
- Probe-method validation + fallback → Task 7 Step 3. ✓
- Website update mandate → Task 2 Step 5. ✓
- Merge-approval constraint → Task 7 Step 2. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code; commands have expected output. ✓

**Type consistency:** `archivedSessions.add/has/all`, `parseSessionKey → {chatId, threadId?}`, `buildSessionKey(chatId, threadId)`, status literals `'live'|'ended'`, emojis `🟢/💤/🔄`, and request shape `{id, name, status, ts}` are used identically across the CLI (Task 2) and bot (Tasks 3–6). ✓
