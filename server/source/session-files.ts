import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionStatus } from '../../src/types.js';
import type { InternalSession } from './session.js';

export async function scanSessions(
  home: string,
  status: (id: string) => SessionStatus,
): Promise<InternalSession[]> {
  const files: { file: string; archived: boolean }[] = [];
  const walk = (dir: string, archived: boolean) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, archived);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ file: f, archived });
    }
  };
  for (const dir of ['sessions', 'archived_sessions'])
    walk(path.join(home, dir), dir === 'archived_sessions');
  const titles = new Map<string, string>();
  try {
    for (const line of readFileSync(path.join(home, 'session_index.jsonl'), 'utf8').split('\n')) {
      try {
        const r = JSON.parse(line);
        titles.set(r.id, r.thread_name);
      } catch {}
    }
  } catch {}
  const sessions: InternalSession[] = [];
  for (const { file, archived } of files) {
    const id = path.basename(file).match(/[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}/i)?.[0];
    if (!id) continue;
    let meta: any = {};
    const input = createReadStream(file, { encoding: 'utf8', start: 0, end: 32767 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (r.type === 'session_meta') {
            meta = r.payload;
            break;
          }
        } catch {}
      }
    } finally {
      lines.close();
      input.destroy();
    }
    const stat = statSync(file);
    const cwd = meta.cwd || '';
    sessions.push({
      id,
      title: titles.get(id) || `会话 ${id.slice(0, 8)}`,
      cwd,
      project: path.basename(cwd.replaceAll('\\', '/')) || '未指定项目',
      createdAt: Date.parse(meta.timestamp) || stat.birthtimeMs,
      updatedAt: stat.mtimeMs,
      archived,
      model: '',
      tokens: 0,
      preview: '',
      status: status(id),
      statusSource: 'rollout',
      file,
      historyMode: 'legacy',
      subagent: JSON.stringify(meta.source ?? '').includes('subagent'),
    });
  }
  return sessions;
}
