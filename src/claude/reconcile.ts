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
  // Guard against overlapping reconcile passes: probing many threads can take
  // longer than POLL_MS, and a second pass while the first runs is wasteful.
  let running = false;
  setInterval(async () => {
    if (running) return;
    if (!fs.existsSync(CONTROL)) return;
    running = true;
    try {
      const n = await reconcileDeletedTopics(bot);
      console.log(`[reconcile] done — archived ${n} deleted topic(s)`);
    } catch (err) {
      console.error('[reconcile] failed:', err instanceof Error ? err.message : String(err));
    } finally {
      try { fs.unlinkSync(CONTROL); } catch { /* ignore */ }
      running = false;
    }
  }, POLL_MS);
  console.log(`[reconcile] watching ${CONTROL} (every ${POLL_MS}ms)`);
}
