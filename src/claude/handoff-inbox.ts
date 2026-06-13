import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Bot } from 'grammy';
import { config } from '../config.js';
import { sessionManager } from './session-manager.js';
import { clearConversation } from '../providers/provider-router.js';
import { buildSessionKey } from '../utils/session-key.js';

// Inbox lives in the bot's state volume; `claudegram push` drops <id>.json here
// (via docker exec). We poll it and, for each request, create a fresh Telegram
// forum topic, bind the pushed session to it, and post a ready message — so a
// Mac->Telegram handoff needs no manual /adopt.
const INBOX = path.join(os.homedir(), '.claudegram', 'handoff-inbox');
const POLL_MS = 4000;

/** Topic title from the conversation's first user text message (falls back to a default). */
function deriveName(transcriptPath: string): string {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
    for (const line of lines) {
      let m: Record<string, unknown>;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type !== 'user') continue;
      const msg = m.message as { content?: unknown } | undefined;
      const content = msg?.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const block = content.find((b) => b && (b as { type?: string }).type === 'text') as { text?: string } | undefined;
        text = block?.text || '';
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text) return ('🔄 ' + text).slice(0, 60);
    }
  } catch {
    // fall through to default
  }
  return '🔄 Handoff';
}

export function startHandoffInbox(bot: Bot): void {
  fs.mkdirSync(INBOX, { recursive: true });
  const groupId = config.ALLOWED_GROUP_IDS[0];
  if (!groupId) {
    console.warn('[handoff-inbox] no ALLOWED_GROUP_IDS — auto-handoff disabled');
    return;
  }
  const projectDir = config.WORKSPACE_DIR.replace(/\//g, '-');

  setInterval(async () => {
    let files: string[];
    try {
      files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      const reqPath = path.join(INBOX, f);
      let req: { id?: string; name?: string | null };
      try {
        req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
      } catch {
        try { fs.unlinkSync(reqPath); } catch { /* ignore */ }
        continue;
      }
      const id = req.id;
      if (!id) { try { fs.unlinkSync(reqPath); } catch { /* ignore */ } continue; }
      const transcript = path.join(os.homedir(), '.claude', 'projects', projectDir, `${id}.jsonl`);
      if (!fs.existsSync(transcript)) {
        // transcript not (yet) on disk — drop the request to avoid a stuck loop
        try { fs.unlinkSync(reqPath); } catch { /* ignore */ }
        continue;
      }
      try {
        const name = (req.name || deriveName(transcript)).slice(0, 60);
        const topic = await bot.api.createForumTopic(groupId, name);
        const threadId = topic.message_thread_id;
        const sessionKey = buildSessionKey(groupId, threadId);
        clearConversation(sessionKey);
        sessionManager.getOrCreate(sessionKey, config.WORKSPACE_DIR);
        sessionManager.setClaudeSessionId(sessionKey, id);
        await bot.api.sendMessage(
          groupId,
          '✅ Sessão do Mac pronta aqui. Manda uma mensagem pra continuar de onde parou.',
          { message_thread_id: threadId },
        );
        fs.unlinkSync(reqPath);
        console.log(`[handoff-inbox] adopted ${id} into new topic ${threadId} ("${name}")`);
      } catch (err) {
        // Likely a permissions/API error (bot needs can_manage_topics). Drop the
        // request so it doesn't retry forever; the /adopt fallback still works.
        console.error('[handoff-inbox] failed for', f, '-', err instanceof Error ? err.message : String(err));
        try { fs.unlinkSync(reqPath); } catch { /* ignore */ }
      }
    }
  }, POLL_MS);

  console.log(`[handoff-inbox] watching ${INBOX} → group ${groupId} (every ${POLL_MS}ms)`);
}
