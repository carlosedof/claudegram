#!/usr/bin/env node
// clagram — handoff Claude sessions between this Mac and the Telegram/VM bot.
// Pure helpers below are unit-tested in clagram.test.mjs.

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
