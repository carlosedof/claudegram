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
