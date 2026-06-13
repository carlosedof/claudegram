# Session Handoff (Mac ↔ Telegram/VM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue the same Claude conversation across the Mac (local `claude`) and Telegram/VM (`@olitermbot`), preserving context, via an explicit on-demand handoff.

**Architecture:** One stable `session-id`; the transcript (`<id>.jsonl`) is copied between Mac and VM over SSH, placed in the destination's per-cwd project dir, and resumed with `claude --resume`. A Mac CLI (`claudegram`) does pull/push; a `/adopt` bot command binds a pushed session to a Telegram topic. Repo folder names on the VM are unified to match the Mac so relative file paths resolve after handoff.

**Tech Stack:** Node ESM (Mac CLI, no deps, `node --test` for pure helpers), TypeScript (bot command), SSH/scp, Docker (VM bot).

**Reference spec:** `docs/superpowers/specs/2026-06-13-session-handoff-design.md`

**Environment facts:**
- VM access: `ssh contabo` (root). Bot container: `claudegram`. Deploy: edit `src/`, `docker compose build` (typecheck gate), commit+push `private-responses`, `docker compose up -d`.
- VM transcripts (host, bind-mounted): `/root/.claude/projects/-workspace/<id>.jsonl`.
- VM session registry: `/root/.claudegram/sessions.json` (Docker volume; read via `docker exec claudegram cat ...`).
- Mac workspace: `/Users/caduolivera/Documents/projects/maxpan`. Mac transcripts: `~/.claude/projects/-Users-caduolivera-Documents-projects-maxpan/<id>.jsonl`.
- Project-dir encoding: cwd with `/` → `-`.
- NOTE: the RTK proxy can filter `ls` output on the Mac — use `find`/glob/python to inspect dirs, never trust `ls`.

---

### Task 0: Spike — validate cross-environment resume (GATE)

Validate the core assumption before building anything. No code; a manual experiment with a clear pass/fail. If it fails, stop and revise the spec.

**Files:** none (throwaway).

- [ ] **Step 1: Pick a real, small VM session id**

Run:
```bash
ssh contabo 'docker exec claudegram cat /root/.claudegram/sessions.json' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); \
print('\n'.join(f\"{k} {e[0].get('claudeSessionId')} {e[0].get('lastMessagePreview','')[:40]}\" \
for k,e in d['sessions'].items() if e and e[0].get('claudeSessionId')))"
```
Expected: lines of `sessionKey <uuid> <preview>`. Pick one `<uuid>` whose transcript is small-ish.

- [ ] **Step 2: Copy the transcript to the Mac project dir**

Run (replace `<id>`):
```bash
mkdir -p "/Users/caduolivera/Documents/projects/maxpan" 2>/dev/null
DEST="$HOME/.claude/projects/-Users-caduolivera-Documents-projects-maxpan"
mkdir -p "$DEST"
scp "contabo:/root/.claude/projects/-workspace/<id>.jsonl" "$DEST/<id>.jsonl"
```
Expected: file copied, no error.

- [ ] **Step 3: Resume on the Mac and observe**

Run:
```bash
cd /Users/caduolivera/Documents/projects/maxpan && claude --resume <id>
```
Then ask: "what were we just talking about?" and request a small file read in one of the repos.

Pass criteria (record results in the commit message of Task 1):
1. Claude loads with the prior conversation context (it "remembers").
2. A file read/operation works against the local `maxpan/` layout.

- [ ] **Step 4: Decide**

If both pass → proceed to Task 1.
If resume fails (wrong project dir name, cwd rejected) → STOP. The likely fix is matching the project-dir encoding; re-inspect `ls ~/.claude/projects` (via `find`) for how `claude` named the dir, and update `encodeProjectDir` assumptions in Task 3 before continuing.

- [ ] **Step 5: Clean up the spike transcript**

Run: `rm -f "$HOME/.claude/projects/-Users-caduolivera-Documents-projects-maxpan/<id>.jsonl"`

---

### Task 1: Unify repo folder names on the VM (prerequisite)

Rename the diverging repos under the VM workspace so relative paths match the Mac. This dir (`/opt/claudegram/workspace`) is NOT in git (gitignored), so renames are plain filesystem ops — no commit. The bind mount reflects them live; no rebuild needed.

**Files (VM):**
- Modify (rename): `/opt/claudegram/workspace/{backend,ms-ai,ms-operation,ms-routines,ms-ping,university}`
- Maybe modify: `/opt/claudegram/workspace/CLAUDE.md` (if it lists repo names)

- [ ] **Step 1: Confirm sources exist and targets are free**

Run:
```bash
ssh contabo 'cd /opt/claudegram/workspace && for m in "backend back" "ms-ai ai-ms" "ms-operation operation-ms" "ms-routines routines-ms" "ms-ping ping-ms" "university university-ms"; do set -- $m; \
if [ -e "$1/.git" ] && [ ! -e "$2" ]; then echo "OK: $1 -> $2"; else echo "SKIP: $1 -> $2 (src missing or dst exists)"; fi; done'
```
Expected: `OK:` for each pair you intend to rename. Investigate any `SKIP:` before proceeding.

- [ ] **Step 2: Perform the renames (only the OK pairs)**

Run:
```bash
ssh contabo 'cd /opt/claudegram/workspace && \
mv backend back && mv ms-ai ai-ms && mv ms-operation operation-ms && \
mv ms-routines routines-ms && mv ms-ping ping-ms && mv university university-ms && \
echo DONE'
```
Expected: `DONE`. (Drop any pair that was `SKIP` in Step 1.)

- [ ] **Step 3: Update workspace CLAUDE.md references if present**

Run:
```bash
ssh contabo 'grep -nE "backend|ms-ai|ms-operation|ms-routines|ms-ping|/workspace/university" /opt/claudegram/workspace/CLAUDE.md 2>/dev/null || echo "no refs"'
```
If refs found, edit that file replacing old→new names (`backend`→`back`, `ms-ai`→`ai-ms`, `ms-operation`→`operation-ms`, `ms-routines`→`routines-ms`, `ms-ping`→`ping-ms`, `university`→`university-ms`). If `no refs`, skip.

- [ ] **Step 4: Verify the new layout and that the bot is unaffected**

Run:
```bash
ssh contabo 'for d in back ai-ms operation-ms routines-ms ping-ms university-ms; do [ -e "/opt/claudegram/workspace/$d/.git" ] && echo "ok $d" || echo "MISSING $d"; done; docker ps --filter name=claudegram --format "{{.Names}} {{.Status}}"'
```
Expected: `ok <name>` for each, and the `claudegram` container still `Up`.

---

### Task 2: `/adopt <id>` bot command

Lets a Telegram topic adopt a session id pushed from the Mac, so the next message resumes it. No test framework exists for the bot — verification is the build (typecheck) plus a manual Telegram check.

**Files (in `/opt/claudegram`):**
- Modify: `src/bot/handlers/command.handler.ts` (add `handleAdopt`)
- Modify: `src/bot/bot.ts` (import + register the command)
- Modify: `src/claude/command-parser.ts` (add to help list)
- Modify: `docs/index.html` (add command row — required by repo CLAUDE.md)

- [ ] **Step 1: Add `handleAdopt` to command.handler.ts**

Append this function (all imports it needs — `sessionManager`, `clearConversation`, `config`, `getSessionKeyFromCtx`, `fs`, `os`, `path` — are already imported at the top of the file):

```ts
/**
 * /adopt <session-id> — bind a Claude session id (e.g. one pushed from the Mac
 * via `claudegram push`) to the current chat/topic, so the next message resumes it.
 * Part of the Mac<->Telegram handoff (docs/superpowers/specs/2026-06-13-session-handoff-design.md).
 */
export async function handleAdopt(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.reply('Could not determine the session for this chat.');
    return;
  }
  const sessionKey = keyInfo.sessionKey;
  const id = (typeof ctx.match === 'string' ? ctx.match : '').trim();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) {
    await ctx.reply('Usage: /adopt <session-id>  (the id is printed by `claudegram push` on your Mac)');
    return;
  }
  // The transcript must already be on the VM under the workspace project dir.
  const projectDir = config.WORKSPACE_DIR.replace(/\//g, '-');
  const transcript = path.join(os.homedir(), '.claude', 'projects', projectDir, `${id}.jsonl`);
  if (!fs.existsSync(transcript)) {
    await ctx.reply(`Session ${id} not found on the VM. Run \`claudegram push\` first.`);
    return;
  }
  // Drop stale in-memory agent state for this topic, then bind the adopted id.
  clearConversation(sessionKey);
  sessionManager.getOrCreate(sessionKey, config.WORKSPACE_DIR);
  sessionManager.setClaudeSessionId(sessionKey, id);
  await ctx.reply(`✅ Adopted session ${id}. Send a message to continue where you left off on the Mac.`);
}
```

- [ ] **Step 2: Register the command in bot.ts**

In `src/bot/bot.ts`, add `handleAdopt` to the existing import from `./handlers/command.handler.js` (the block that already imports `handleContinue`, `handleResume`, etc.), then register it next to the other session commands (after the `bot.command('continue', handleContinue);` line, ~line 182):

```ts
  bot.command('adopt', handleAdopt);
```

- [ ] **Step 3: Add `/adopt` to the help/command list**

In `src/claude/command-parser.ts`, find the array/list of command descriptions (the one consumed by `getAvailableCommands`) and add an entry mirroring the existing format, e.g.:

```ts
  { command: '/adopt', description: 'Adopt a session id pushed from your Mac (claudegram push)' },
```
(Match the exact object shape used by the surrounding entries in that file.)

- [ ] **Step 4: Add the command row to docs/index.html (required by repo CLAUDE.md)**

In `docs/index.html`, in the Session commands grid, add:

```html
<div class="command-row">
  <code class="command-code">/adopt &lt;id&gt;</code>
  <span class="command-desc">Adopt a session pushed from your Mac (claudegram push) into this topic</span>
</div>
```

- [ ] **Step 5: Build (typecheck gate)**

Run:
```bash
ssh contabo 'cd /opt/claudegram && docker compose build 2>&1 | grep -iE "tsc|error|Built"; echo EXIT=${PIPESTATUS[0]}'
```
Expected: `> tsc` runs, no `error TSxxxx`, `claudegram-claudegram Built`, `EXIT=0`.

- [ ] **Step 6: Commit, push, deploy**

```bash
ssh contabo 'cd /opt/claudegram && git add src/bot/handlers/command.handler.ts src/bot/bot.ts src/claude/command-parser.ts docs/index.html && \
git -c user.name="Cadu Oliveira" -c user.email="cadu@maxpan.com.br" commit -m "feat: /adopt command to bind a pushed Mac session to a topic" && \
git push origin private-responses && docker compose up -d'
```
Expected: commit created, pushed, container recreated.

- [ ] **Step 7: Manual Telegram verification**

In a topic: send `/adopt nonsense` → expect the Usage message. Send `/adopt 00000000-0000-0000-0000-000000000000` → expect "not found". (Full positive path is exercised in Task 5.)

---

### Task 3: `claudegram` CLI — pure helpers + unit tests (TDD)

Create the CLI skeleton with the pure, testable helpers first. Lives in the repo so it is versioned; the Mac gets it in Task 5.

**Files (in `/opt/claudegram`):**
- Create: `scripts/claudegram.mjs`
- Create: `scripts/claudegram.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/claudegram.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectDir, parseSessions, compareForClobber } from './claudegram.mjs';

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
  assert.equal(out[0].sessionKey, '222:3'); // newer
  assert.equal(out[0].claudeSessionId, 'bbbbbbbb-0000-0000-0000-000000000000');
  assert.equal(out[1].sessionKey, '111');
});

test('compareForClobber flags a newer/larger destination', () => {
  assert.equal(compareForClobber(null, { mtimeMs: 1, lines: 1 }), 'safe');
  assert.equal(compareForClobber({ mtimeMs: 100, lines: 5 }, { mtimeMs: 200, lines: 9 }), 'safe');
  assert.equal(compareForClobber({ mtimeMs: 300, lines: 5 }, { mtimeMs: 200, lines: 9 }), 'dest-newer');
  assert.equal(compareForClobber({ mtimeMs: 100, lines: 20 }, { mtimeMs: 200, lines: 9 }), 'dest-newer');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `ssh contabo 'cd /opt/claudegram && node --test scripts/claudegram.test.mjs'`
Expected: FAIL — `Cannot find module './claudegram.mjs'` or export errors.

- [ ] **Step 3: Write the helpers in scripts/claudegram.mjs**

Create `scripts/claudegram.mjs` (helpers only for now; CLI wiring added in Task 4):

```js
#!/usr/bin/env node
// claudegram — handoff Claude sessions between this Mac and the Telegram/VM bot.
// Pure helpers below are unit-tested in claudegram.test.mjs.

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

// dest/src: null or { mtimeMs: number, lines: number }. Returns 'safe' | 'dest-newer'.
export function compareForClobber(dest, src) {
  if (!dest) return 'safe';
  if (dest.mtimeMs > src.mtimeMs || dest.lines > src.lines) return 'dest-newer';
  return 'safe';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `ssh contabo 'cd /opt/claudegram && node --test scripts/claudegram.test.mjs'`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
ssh contabo 'cd /opt/claudegram && git add scripts/claudegram.mjs scripts/claudegram.test.mjs && \
git -c user.name="Cadu Oliveira" -c user.email="cadu@maxpan.com.br" commit -m "feat(claudegram): pure helpers for session handoff CLI + tests"'
```

---

### Task 4: `claudegram` CLI — pull/push orchestration

Wire the SSH/scp commands and arg parsing around the helpers. This part touches the network and filesystem; it is verified manually in Task 5 (no automated test).

**Files (in `/opt/claudegram`):**
- Modify: `scripts/claudegram.mjs`

- [ ] **Step 1: Add config, helpers for SSH/scp, and the pull/push commands**

Append to `scripts/claudegram.mjs`:

```js
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const CFG = {
  host: process.env.CLAUDEGRAM_SSH_HOST || 'contabo',
  remoteCwd: process.env.CLAUDEGRAM_REMOTE_CWD || '/workspace',
  localWorkspace: process.env.CLAUDEGRAM_LOCAL_WORKSPACE || join(homedir(), 'Documents/projects/maxpan'),
  remoteHome: process.env.CLAUDEGRAM_REMOTE_HOME || '/root',
};

const remoteProjDir = () => `${CFG.remoteHome}/.claude/projects/${encodeProjectDir(CFG.remoteCwd)}`;
const localProjDir = () => join(homedir(), '.claude', 'projects', encodeProjectDir(CFG.localWorkspace));

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
  // anti-clobber: compare remote (src) line count/mtime against local (dest)
  const remoteLines = Number(sh('ssh', [CFG.host, `wc -l < ${remoteProjDir()}/${id}.jsonl`]).trim()) + 1;
  if (!force && compareForClobber(fileMeta(dest), { mtimeMs: Date.now(), lines: remoteLines }) === 'dest-newer') {
    console.error(`Local copy looks newer/larger than the VM's. Re-run with --force to overwrite.`);
    process.exit(1);
  }
  sh('scp', [`${CFG.host}:${remoteProjDir()}/${id}.jsonl`, dest]);
  console.log(`\nPulled. Continue with:\n  cd ${CFG.localWorkspace} && claude --resume ${id}`);
}

async function cmdPush() {
  const argId = process.argv[3];
  let id = argId;
  if (!id) {
    // default to the most-recently-modified local transcript (node-native; no `ls`)
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
    if (compareForClobber({ mtimeMs: Date.now(), lines: remoteLines }, fileMeta(src)) === 'dest-newer') {
      console.error(`VM copy looks newer/larger. Re-run with --force to overwrite.`);
      process.exit(1);
    }
  }
  sh('scp', [src, `${CFG.host}:${remoteProjDir()}/${id}.jsonl`]);
  console.log(`\nPushed. In the target Telegram topic, send:\n  /adopt ${id}\nthen message to continue.`);
}

// Only dispatch when run directly (not when imported by the test file), so
// `node --test` importing this module has zero side effects.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'pull') cmdPull();
  else if (cmd === 'push') cmdPush();
  else { console.error('Usage: claudegram pull | push [<id>]'); process.exit(1); }
}
```

Note: the `isMain` guard is essential — without it, importing the module under `node --test` would run the dispatch and `process.exit(1)`, killing the test run.

- [ ] **Step 2: Re-run the unit tests (guard against regressions)**

Run: `ssh contabo 'cd /opt/claudegram && node --test scripts/claudegram.test.mjs'`
Expected: PASS — 3 tests, 0 failures (importing the file must not error or hang).

- [ ] **Step 3: Commit and push**

```bash
ssh contabo 'cd /opt/claudegram && git add scripts/claudegram.mjs && \
git -c user.name="Cadu Oliveira" -c user.email="cadu@maxpan.com.br" commit -m "feat(claudegram): pull/push session handoff over SSH" && \
git push origin private-responses'
```

---

### Task 5: Install on the Mac + end-to-end round-trip

**Files (Mac):**
- Create: `~/bin/claudegram` (symlink) and shell PATH/config

- [ ] **Step 1: Get the CLI onto the Mac and make it runnable**

On the Mac:
```bash
mkdir -p ~/bin ~/claudegram-cli
scp contabo:/opt/claudegram/scripts/claudegram.mjs ~/claudegram-cli/claudegram.mjs
chmod +x ~/claudegram-cli/claudegram.mjs
ln -sf ~/claudegram-cli/claudegram.mjs ~/bin/claudegram
# ensure ~/bin is on PATH (zsh):
grep -q 'export PATH="$HOME/bin:$PATH"' ~/.zshrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```
Then open a new shell or `source ~/.zshrc`. Run `claudegram` (no args) → expect the usage error.

- [ ] **Step 2: Telegram → Mac (pull)**

In a Telegram topic, have a short real conversation (e.g. "lembre que meu número da sorte é 42"). Then on the Mac:
```bash
claudegram pull
```
Pick that session. Run the printed `cd ... && claude --resume <id>` and ask "qual meu número da sorte?".
Expected: Claude answers 42 (context carried from Telegram).

- [ ] **Step 3: Mac → Telegram (push + /adopt)**

Continue on the Mac (e.g. "agora meu número é 99"), exit. Then:
```bash
claudegram push
```
Copy the printed `/adopt <id>`, send it in the target Telegram topic, then ask "qual meu número agora?".
Expected: bot answers 99 (context carried back from the Mac).

- [ ] **Step 4: Anti-clobber check**

Run `claudegram push <id>` again for a session whose VM copy is now newer (after Step 3's Telegram turn).
Expected: it refuses with the "VM copy looks newer" message unless `--force`.

- [ ] **Step 5: Record results**

If all pass, the feature is complete. Note any friction from the repo-name divergence (paths the model couldn't find) for a possible future "path translation" follow-up (out of scope here).

---

## Self-review notes

- **Spec coverage:** pull (Telegram→Mac) = Task 4/5; push (Mac→Telegram) = Task 4/5; `/adopt` = Task 2; repo-name unification = Task 1; stable session-id ping-pong = inherent in pull/push using the same id; anti-clobber = Task 4 (`compareForClobber`) + Task 5 Step 4; spike = Task 0. All spec sections covered.
- **Out of scope (not implemented, per spec):** continuous sync, Mac watcher, uncommitted files, absolute-path translation, multi-machine.
- **Type/name consistency:** `encodeProjectDir`, `parseSessions`, `compareForClobber` defined in Task 3 and used identically in Task 4; `handleAdopt` defined in Task 2 Step 1 and registered in Step 2.
