import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { validId } from './source/session.js';

/** An opt-in boundary shared by history, usage, notifications and control routes. */
export class SessionScope {
  private ids = new Set<string>();
  private file: string;
  constructor(
    dataDir: string,
    private mode: 'all' | 'created' = 'all',
  ) {
    this.file = path.join(dataDir, 'session-scope.json');
    if (mode === 'created') {
      try {
        const ids = JSON.parse(readFileSync(this.file, 'utf8'));
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !validId(id)))
          throw new Error();
        this.ids = new Set(ids);
      } catch (error: any) {
        if (error?.code !== 'ENOENT')
          throw new Error('Cannot read the private session scope; refusing to expose sessions.');
      }
    }
  }
  allows = (id: string) => this.mode === 'all' || this.ids.has(id);
  include = (id: string) => {
    if (this.mode === 'all' || this.ids.has(id)) return;
    if (!validId(id)) throw new Error('Invalid created thread id');
    const ids = new Set([...this.ids, id]);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify([...ids]) + '\n', { mode: 0o600 });
    renameSync(temporary, this.file);
    this.ids = ids;
  };
}
