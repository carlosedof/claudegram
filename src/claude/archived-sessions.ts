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
