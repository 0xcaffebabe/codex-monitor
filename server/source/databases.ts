import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SourceDatabases {
  state?: DatabaseSync;
  history?: DatabaseSync;
  columns: Set<string>;
  historyColumns: Set<string>;
  warnings: string[];
}
export function openCodexDatabases(home: string): SourceDatabases {
  const databases: SourceDatabases = {
    columns: new Set(),
    historyColumns: new Set(),
    warnings: [],
  };

  if (!existsSync(home)) {
    databases.warnings = ['找不到 Codex 数据目录，请检查 CODEX_HOME 配置。'];
    return databases;
  }
  for (const [prefix, target] of [
    ['state_', 'state'],
    ['thread_history_', 'history'],
  ] as const) {
    const files = readdirSync(home)
      .filter((n) => new RegExp(`^${prefix}\\d+\\.sqlite$`).test(n))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!files[0]) continue;
    try {
      const db = new DatabaseSync(path.join(home, files[0]), { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200;');
      databases[target] = db;
      if (target === 'state')
        databases.columns = new Set(
          db
            .prepare('PRAGMA table_info(threads)')
            .all()
            .map((x) => String(x.name)),
        );
      else
        databases.historyColumns = new Set(
          db
            .prepare('PRAGMA table_info(thread_items)')
            .all()
            .map((row) => String(row.name)),
        );
    } catch {
      databases.warnings.push(
        `无法读取 ${target === 'state' ? '会话索引' : '执行历史'}，将尝试 JSONL 记录。`,
      );
    }
  }

  return databases;
}
