# Claudegram `sync` — Bulk session → Telegram topics

**Date:** 2026-06-18
**Status:** Design approved (pending spec review)

## Problem

Pushing Claude sessions from the Mac to the Telegram bot is one-at-a-time
(`claudegram push <id>`). The user wants a single command that takes every
session they currently care about and creates one Telegram forum topic per
session, named after the session, distinguishing in-progress from finished
sessions — and a way to "retire" a session so it never comes back.

## Goals

- One command (`claudegram sync`) that creates a Telegram topic for each
  relevant local session, named after the session.
- Distinguish **live** (in-progress) from **ended** sessions, visibly.
- Idempotent: re-running never duplicates topics.
- A "retire" mechanism: closing **or** deleting a topic in Telegram permanently
  excludes that session from future syncs.
- Keep the Telegram topic list from filling up with dead topics.

## Non-goals

- Mapping each session's original working directory onto the VM. Adopted
  sessions run in `/workspace` on the VM (existing handoff behavior). Out of
  scope.
- Real-time mirroring / two-way live sync of an in-progress session. `sync` is a
  snapshot-at-invocation handoff.
- Version-controlling the standalone CLI (`~/bin/claudegram`); it stays a
  standalone script.

## Key facts established during design

- **Live vs ended is reliably detectable.** A live session has a running
  `claude` process carrying `--session-id <uuid>` in its argv. Ended = a
  transcript `.jsonl` with no matching live process. There is no native
  "session ended" flag in Claude Code — a session is just an append-only
  transcript file.
- **Session name = `aiTitle`.** Each transcript contains `{"type":"ai-title",
  "aiTitle": "...", "sessionId": "..."}` records (Claude Code's auto-generated
  title). The last one is the current title. Fallback when absent: the bot's
  existing `deriveName` (first user message).
- **Telegram has no topic-deleted event.** Service messages exist for
  `forum_topic_closed / created / edited / hidden / reopened / unhidden` — but
  **not** deleted. Deletion is therefore undetectable via updates and must be
  found by reconciliation (probing).
- **The handoff path already exists.** `claudegram push` scp's the transcript to
  the VM and drops `~/.claudegram/handoff-inbox/<id>.json` (`{id, name, ts}`).
  The bot (`src/claude/handoff-inbox.ts`) polls the inbox every 4s, creates a
  forum topic, binds the session, posts a ready message, deletes the request.
  It always creates a NEW topic (no dedup today).
- **Bot deploy:** repo `github.com/carlosedof/claudegram`, the VM auto-deploys
  from `main` every 15 min (`/usr/local/bin/claudegram-autodeploy.sh`). Local
  clone: `~/Documents/projects/claudegram` (working branch `private-responses`).

## Architecture

Two components. The CLI does discovery/filtering and reuses the existing push
path; the bot gains a status field, a close handler, and a reconcile step.

### Component 1 — `claudegram sync` (new CLI subcommand, `~/bin/claudegram`)

Algorithm:

1. **Detect live sessions.** Parse `ps -ww -o command=` for processes whose
   command contains `claude` and a `--session-id <uuid>`; collect the uuid set
   (`LIVE`).
2. **Collect candidate transcripts.** Walk `~/.claude/projects/*/*.jsonl`. Keep
   a transcript if its `mtime` is within the last 7 days **OR** its id ∈ `LIVE`.
   (mtime = last activity; covers "created or interacted in last 7 days". Live
   sessions are always kept regardless of age.)
3. **Name + status per candidate.** Extract the last `ai-title` record's
   `aiTitle` for the name (null → let the bot derive it). status = `live` if
   id ∈ `LIVE`, else `ended`.
4. **Reconcile + read VM state (one ssh round-trip region).** Trigger a bot
   reconcile (see Component 2), then read:
   - existing session ids that already have a topic (from `sessions.json`,
     via the existing `parseSessions`), and
   - retired ids (from `archived.json`).
5. **Filter.** Drop candidates whose id is already in `sessions.json` (has a
   topic) or in `archived.json` (retired).
6. **Push the rest.** For each: `scp <transcript>` → VM workspace project dir,
   then write `handoff-inbox/<id>.json` = `{id, name, status, ts}`.
7. **Summary.** Print `created N · skipped M (existing) · A retired · L live`.

The CLI needs no Telegram token; all Telegram interaction stays in the bot.

### Component 2 — Bot changes (`/opt/claudegram` → repo, deploy via `main`)

1. **Status-aware handoff** (`src/claude/handoff-inbox.ts`): accept optional
   `status` in the request. Prefix the topic name with 🟢 (live) / 💤 (ended)
   and tailor the ready message — for `live`, add a "⚠️ ainda rodando no Mac;
   continuar aqui pode divergir" warning.
2. **Close handler** (`src/bot/bot.ts`): `bot.on('message:forum_topic_closed')`.
   Resolve `sessionKey = chatId:threadId` → look up its `claudeSessionId` →
   append to `archived.json`, drop it from the live session map/history, then
   **delete the topic** (`deleteForumTopic`) so the list stays clean.
3. **Reconcile-on-demand** (new, e.g. `src/claude/reconcile.ts`): triggered by a
   control file the CLI drops (`~/.claudegram/handoff-inbox/_reconcile.json`,
   distinguished from session requests by the `_` prefix). For every known forum
   session (`sessions.json` key `chatId:threadId`), probe whether the thread
   still exists. Threads that have vanished (manual deletes) → append their
   `claudeSessionId` to `archived.json` and drop from the session map. Delete
   the control file when done (the CLI polls for its removal, with a timeout
   fallback, mirroring the inbox handshake).

   **Probe method (to validate early):** Telegram has no read-only "get topic"
   call. The candidate probe is a lightweight `sendChatAction(groupId,
   'typing', { message_thread_id })`; a deleted thread is expected to return a
   "message thread not found" error. This MUST be validated against a real
   deleted topic before relying on it. **Fallback if the probe is unreliable:**
   rely on the close handler (close → archive + delete) as the primary retire
   path; manual deletion then simply isn't auto-detected and the user closes
   instead of deleting.

### `archived.json`

Lives in the bot state volume next to `sessions.json`
(`/root/.claudegram/archived.json`). Shape: `{ "ids": ["<claudeSessionId>", ...] }`.
Written by the close handler and reconcile; read by the CLI via
`docker exec claudegram cat`.

## Data flow

```
claudegram sync
  ├─ ps              → LIVE set
  ├─ walk projects   → candidates (7d ∪ LIVE) + aiTitle + status
  ├─ ssh: drop _reconcile.json ; wait removal
  │     └─ bot: probe known threads → update archived.json, prune sessions
  ├─ ssh: read sessions.json (existing) + archived.json (retired)
  ├─ filter out existing ∪ retired
  └─ for each remaining: scp transcript ; write handoff-inbox/<id>.json
        └─ bot inbox poll → createForumTopic(name w/ status) → bind → ready msg

Telegram: user closes topic
  └─ bot forum_topic_closed → archive id + delete topic
Telegram: user deletes topic (no event)
  └─ caught at next sync's reconcile → archive id
```

## Edge cases & risks

- **Two writers (live sessions).** Continuing a live session in Telegram while
  it's still running on the Mac can diverge the append-only transcript. Mitigation:
  the 🟢 marker + ready-message warning. Accepted for v1 (snapshot semantics).
- **No aiTitle yet** (brand-new session): pass `name: null`; bot falls back to
  `deriveName`.
- **All transcripts land in one VM project** (`/workspace`); adopted sessions
  run with cwd `/workspace`. Existing behavior, not regressed here.
- **Reconcile race.** Doing reconcile *before* the existing/retired read in the
  same sync prevents a just-deleted topic's session from being re-pushed as a
  duplicate.
- **Probe spam.** Reconcile probes only known forum threads (tens, not the 248
  historical transcripts). `typing` actions are ephemeral.
- **Many candidates.** The 7-day window bounds the set; a project with hundreds
  of old transcripts contributes only its recent ones.

## Testing

- **CLI (unit, mirror `claudegram.test.mjs` pure-helper style):**
  - live-session parser over sample `ps` output (extracts uuids, ignores
    unrelated `claude` strings),
  - 7-day recency filter (boundary at exactly 7 days; live always kept),
  - `aiTitle` extraction (last record wins; missing → null),
  - skip logic (existing ∪ retired removed; everything else kept).
- **Bot (unit):** `archived.json` append is idempotent (no dup ids) and
  creates the file if missing.
- **Manual / integration:** validate the deleted-thread probe; run `sync` end to
  end (create topics, close one → archived + deleted, delete one → archived next
  sync, re-run sync → no duplicates).

## Deploy / branch flow

- CLI: edit `~/bin/claudegram` directly (standalone).
- Bot: implement on a feature branch, open a PR. Merge to `main` (which triggers
  VM autodeploy) only with explicit per-merge approval.

## Open defaults (adjustable on review)

- Command name: `claudegram sync`.
- Status emojis: 🟢 live / 💤 ended, as a topic-name prefix.
- Recency window: 7 days by transcript mtime.
