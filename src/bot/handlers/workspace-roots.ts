// Top-level workspace folders offered as the session root when a new Telegram
// topic is created. Visible directories only (no dotfiles like .claudegram),
// sorted. With the VM layout (/workspace/{maxpan,pessoal}) this yields
// ['maxpan', 'pessoal'] and auto-adapts if more folders are added.

export interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
}

export function pickWorkspaceRoots(entries: DirEntryLike[]): string[] {
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}
