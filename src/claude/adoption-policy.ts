// Decides whether a handoff-inbox request should create (adopt) a Telegram topic.
//
// Root cause this guards against: `claudegram sync` keeps a LIVE session as a
// candidate every run. When the user deletes that session's topic, reconcile
// archives it — but the CLI's own `selectToPush` archived-filter races with
// reconcile (it can time out or read a not-yet-updated archived list), so the
// CLI still drops a handoff request and the bot recreated the topic, every
// cycle. The bot is the authority on what's archived (it does the archiving),
// so we enforce the retire decision HERE, where it's race-free.
//
// Only `sync`-originated requests are suppressed: an explicit `claudegram push`
// (no `source`) is a deliberate user action and may resurrect a retired session.

export interface AdoptionRequest {
  source?: string;
}

export function shouldAdopt(req: AdoptionRequest, isArchived: boolean): boolean {
  if (isArchived && req.source === 'sync') return false;
  return true;
}
