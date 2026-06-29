import { Context, InlineKeyboard } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../config.js';
import { sessionManager } from '../../claude/session-manager.js';
import { clearConversation } from '../../providers/provider-router.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { pickWorkspaceRoots } from './workspace-roots.js';

/**
 * When a user creates a new forum topic, offer the workspace roots (the
 * top-level folders under WORKSPACE_DIR, e.g. maxpan / pessoal) as buttons. The
 * pick (handleWorkspaceCallback) sets that folder as the session's working
 * directory, so the Claude session runs there.
 *
 * Topics the bot itself created (sync/handoff adoption) are skipped — they
 * already have a bound session and working directory.
 */
export async function handleTopicCreated(ctx: Context): Promise<void> {
  if (ctx.from?.id && ctx.me?.id && ctx.from.id === ctx.me.id) return; // bot-created topic
  const threadId = ctx.message?.message_thread_id;
  if (threadId === undefined) return;

  let roots: string[] = [];
  try {
    roots = pickWorkspaceRoots(fs.readdirSync(config.WORKSPACE_DIR, { withFileTypes: true }));
  } catch {
    return;
  }
  if (!roots.length) return; // no folders to choose from — leave the default

  const kb = new InlineKeyboard();
  for (const r of roots) kb.text(r, `ws:${r}`);

  try {
    await ctx.reply('📂 Escolha o workspace desta sessão:', {
      message_thread_id: threadId,
      reply_markup: kb,
    });
  } catch (err) {
    console.error('[topic-created] failed to post picker:', err instanceof Error ? err.message : String(err));
  }
}

/** Handle a `ws:<name>` button: bind <name> as the session's working directory. */
export async function handleWorkspaceCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('ws:')) return;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) { await ctx.answerCallbackQuery(); return; }
  const { sessionKey } = keyInfo;
  const name = data.slice('ws:'.length);

  // Validate against the live listing — `name` must be an actual top-level
  // workspace folder. This also blocks any path traversal (e.g. "../x").
  let roots: string[] = [];
  try {
    roots = pickWorkspaceRoots(fs.readdirSync(config.WORKSPACE_DIR, { withFileTypes: true }));
  } catch {
    roots = [];
  }
  if (!roots.includes(name)) {
    await ctx.answerCallbackQuery({ text: 'Workspace inválido' });
    return;
  }

  const target = path.join(config.WORKSPACE_DIR, name);
  sessionManager.getOrCreate(sessionKey, config.WORKSPACE_DIR);
  sessionManager.setWorkingDirectory(sessionKey, target);
  clearConversation(sessionKey);

  await ctx.answerCallbackQuery({ text: `Workspace: ${name}` });
  try {
    await ctx.editMessageText(`✅ Workspace: ${name}\n\nManda sua mensagem — a sessão vai rodar nessa pasta.`);
  } catch {
    // message may be uneditable (too old); the callback answer already confirmed
  }
}
