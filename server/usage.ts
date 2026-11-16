import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createZstdDecompress } from 'node:zlib';
import type { UsageData } from '../src/types.js';
import { PricingCatalog } from './pricing.js';
import type { CodexSource } from './source.js';
import {
  USAGE_PARSER_VERSION,
  UsageParser,
  type ParserState,
  type Tokens,
  type UsageRecord,
} from './usage-parser.js';
import { aggregateUsage } from './usage-query.js';

export interface UsageQuery {
  from?: number;
  to?: number;
  model?: string;
  session?: string;
  project?: string;
  subagents?: string;
  timezoneOffset?: number;
  offset?: number;
  limit?: number;
}
interface FileRow {
  file: string;
  size: number;
  mtime: number;
  identity: string;
  offset: number;
  state: string;
}
const MAX_LINE = 8 * 1024 * 1024;

export class UsageStore {
  private db: DatabaseSync;
  private scanPromise?: Promise<void>;
  private closed = false;
  private lastAttempt = 0;
  private revision = 0;
  private querySnapshot = '';
  private queryCache = new Map<string, UsageData>();
  private status: UsageData['scan'] = {
    running: false,
    completed: 0,
    files: 0,
    updatedAt: 0,
    errors: 0,
    invalidLines: 0,
    uncertainRecords: 0,
  };
  readonly pricing: PricingCatalog;
  constructor(
    private source: Pick<CodexSource, 'home' | 'usageSessions'> &
      Partial<Pick<CodexSource, 'allowsSession'>>,
    dataDir: string,
    pricingFile: string,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'usage.sqlite'));
    // Apply the scope at query time too: an existing cache can contain records
    // collected before the client enabled a narrower session scope.
    this.db.function('monitor_session_allowed', (id) =>
      this.source.allowsSession?.(String(id)) === false ? 0 : 1,
    );
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS usage_files(file TEXT PRIMARY KEY,size INTEGER,mtime REAL,identity TEXT,offset INTEGER,state TEXT);
      CREATE TABLE IF NOT EXISTS usage_requests(id TEXT PRIMARY KEY,file TEXT NOT NULL,session_id TEXT NOT NULL,model TEXT NOT NULL,timestamp INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_requests_time ON usage_requests(timestamp DESC);
      CREATE INDEX IF NOT EXISTS usage_requests_order ON usage_requests(timestamp DESC,id);
      CREATE INDEX IF NOT EXISTS usage_requests_session ON usage_requests(session_id);
      CREATE INDEX IF NOT EXISTS usage_requests_file ON usage_requests(file);
      CREATE TABLE IF NOT EXISTS usage_record_sources(id TEXT NOT NULL,file TEXT NOT NULL,PRIMARY KEY(id,file));
      CREATE INDEX IF NOT EXISTS usage_record_sources_file ON usage_record_sources(file);`);
    this.pricing = new PricingCatalog(pricingFile);
  }
  private discover() {
    const files: string[] = [];
    for (const name of ['sessions', 'archived_sessions']) {
      const root = path.join(this.source.home, name);
      if (!existsSync(root)) continue;
      const base = realpathSync(root);
      const walk = (dir: string) => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          if (item.isSymbolicLink()) continue;
          const file = path.join(dir, item.name);
          if (item.isDirectory()) walk(file);
          else if (item.isFile() && /\.jsonl(?:\.zst)?$/.test(item.name)) {
            const id = item.name.match(/[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}/i)?.[0] ?? '';
            if (this.source.allowsSession?.(id) === false) continue;
            const real = realpathSync(file),
              relative = path.relative(base, real);
            if (!relative.startsWith('..') && !path.isAbsolute(relative)) files.push(real);
          }
        }
      };
      walk(base);
    }
    // Rollout timestamp prefixes also order continuation pages of the same thread.
    return files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  }
  private async read(file: string, start: number, end: number, parser: UsageParser) {
    let pending = Buffer.alloc(0),
      skipping = parser.state.skipping ?? false,
      offset = start;
    const records: UsageRecord[] = [];
    if (end < start) return { records, offset };
    const input = createReadStream(file, { start, end });
    const stream = file.endsWith('.zst') ? input.pipe(createZstdDecompress()) : input;
    if (stream !== input) input.on('error', (error) => stream.destroy(error));
    try {
      for await (const raw of stream) {
        if (this.closed) break;
        const chunk = raw as Buffer;
        let cursor = 0,
          newline: number;
        while ((newline = chunk.indexOf(10, cursor)) >= 0) {
          const part = chunk.subarray(cursor, newline);
          if (!skipping && pending.length + part.length <= MAX_LINE) {
            const line = pending.length
              ? Buffer.concat([pending, part]).toString('utf8')
              : part.toString('utf8');
            records.push(...parser.parse(line));
          } else if (!skipping) parser.state.invalid++;
          offset += pending.length + part.length + 1;
          pending = Buffer.alloc(0);
          skipping = false;
          cursor = newline + 1;
        }
        const tail = chunk.subarray(cursor);
        if (!skipping && pending.length + tail.length <= MAX_LINE)
          pending = Buffer.concat([pending, tail]);
        else {
          if (!skipping) parser.state.invalid++;
          offset += pending.length + tail.length;
          pending = Buffer.alloc(0);
          skipping = true;
        }
      }
    } finally {
      input.destroy();
    }
    parser.state.skipping = skipping;
    // An unfinished line is retried on the next scan, including split UTF-8 bytes.
    return { records, offset };
  }
  sync(force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.scanPromise) return this.scanPromise;
    if (!force && Date.now() - this.lastAttempt < 15000) return Promise.resolve();
    this.lastAttempt = Date.now();
    this.status.running = true;
    this.scanPromise = this.scan().finally(() => {
      this.status.running = false;
      this.scanPromise = undefined;
    });
    return this.scanPromise;
  }
  private async scan() {
    try {
      const files = this.discover();
      this.status = {
        ...this.status,
        running: true,
        files: files.length,
        completed: 0,
        errors: 0,
        invalidLines: 0,
        uncertainRecords: 0,
      };
      const old = new Map(
        (this.db.prepare('SELECT * FROM usage_files').all() as unknown as FileRow[]).map((r) => [
          r.file,
          r,
        ]),
      );
      const baseline = new Map<string, Tokens>();
      const owners = new Map((await this.source.usageSessions()).map((s) => [s.id, s]));
      for (const file of files) {
        if (this.closed) return;
        try {
          const stat = statSync(file),
            previous = old.get(file),
            identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
          let state: ParserState | undefined = previous ? JSON.parse(previous.state) : undefined;
          if (
            !previous ||
            state?.version !== USAGE_PARSER_VERSION ||
            previous.size !== stat.size ||
            previous.mtime !== stat.mtimeMs ||
            previous.identity !== identity
          ) {
            const append =
              !file.endsWith('.zst') &&
              previous &&
              state?.version === USAGE_PARSER_VERSION &&
              previous.identity === identity &&
              stat.size > previous.size;
            const id =
              path.basename(file).match(/[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}/i)?.[0] ?? '';
            const filenameDate = path
              .basename(file)
              .match(/^rollout-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)/)?.[1];
            const fallbackCreated = filenameDate
              ? Date.parse(filenameDate.replace(/T(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3'))
              : undefined;
            const parser = new UsageParser(
              id,
              append ? state : undefined,
              baseline.get(id),
              owners.get(id)?.createdAt ?? fallbackCreated,
            );
            const result = await this.read(
              file,
              append ? previous.offset : 0,
              stat.size - 1,
              parser,
            );
            if (this.closed) return;
            state = parser.state;
            this.db.exec('BEGIN');
            try {
              if (!append)
                this.db.prepare('DELETE FROM usage_record_sources WHERE file=?').run(file);
              const insert = this.db.prepare(
                `INSERT INTO usage_requests VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE
                 SET file=excluded.file,model=excluded.model,timestamp=excluded.timestamp,data=excluded.data
                 WHERE usage_requests.model<>excluded.model OR usage_requests.timestamp<>excluded.timestamp OR usage_requests.data<>excluded.data`,
              );
              const provenance = this.db.prepare(
                'INSERT OR IGNORE INTO usage_record_sources VALUES(?,?)',
              );
              let changed = false;
              for (const row of result.records) {
                if (this.source.allowsSession?.(row.sessionId) === false) continue;
                const written = insert.run(
                  row.id,
                  file,
                  row.sessionId,
                  row.model,
                  row.timestamp,
                  JSON.stringify(row),
                );
                changed ||= !!written.changes;
                provenance.run(row.id, file);
              }
              this.db
                .prepare('INSERT OR REPLACE INTO usage_files VALUES(?,?,?,?,?,?)')
                .run(file, stat.size, stat.mtimeMs, identity, result.offset, JSON.stringify(state));
              this.db.exec('COMMIT');
              // Tool output appends update parser checkpoints, not token totals.
              if (changed) this.revision++;
            } catch (error) {
              this.db.exec('ROLLBACK');
              throw error;
            }
          }
          if (state) {
            if (state.total) baseline.set(state.sessionId, state.total);
            this.status.invalidLines += state.invalid;
            this.status.uncertainRecords += state.uncertain;
          }
        } catch {
          this.status.errors++;
        }
        this.status.completed++;
      }
      if (this.closed) return;
      const present = new Set(files);
      for (const file of old.keys())
        if (!present.has(file)) {
          this.db.prepare('DELETE FROM usage_record_sources WHERE file=?').run(file);
          this.db.prepare('DELETE FROM usage_files WHERE file=?').run(file);
          this.revision++;
        }
      const removed = this.db
        .prepare(
          'DELETE FROM usage_requests WHERE NOT EXISTS (SELECT 1 FROM usage_record_sources s WHERE s.id=usage_requests.id)',
        )
        .run();
      if (removed.changes) this.revision++;
      this.status.updatedAt = Date.now();
    } catch {
      this.status.errors++;
    }
  }
  async query(query: UsageQuery = {}): Promise<UsageData> {
    this.pricing.reload();
    const sessions = await this.source.usageSessions();
    // Titles and project attribution may change independently of token records.
    const metadata = createHash('sha256')
      .update(
        JSON.stringify(
          sessions.map((session) => [
            session.id,
            session.title,
            session.cwd,
            session.project,
            session.subagent,
          ]),
        ),
      )
      .digest('hex');
    const snapshot = `${this.revision}:${this.pricing.revision}:${metadata}`;
    if (snapshot !== this.querySnapshot) {
      this.queryCache.clear();
      this.querySnapshot = snapshot;
    }
    const cacheKey = JSON.stringify([
      query.from,
      query.to,
      query.model,
      query.session,
      query.project,
      query.subagents,
      query.timezoneOffset ?? -480,
      query.offset ?? 0,
      query.limit ?? 50,
    ]);
    const cached = this.queryCache.get(cacheKey);
    if (cached) return { ...cached, scan: { ...this.status }, warnings: this.warnings() };
    const clauses: string[] = ['monitor_session_allowed(session_id)=1'],
      args: (string | number)[] = [];
    if (query.from !== undefined) {
      clauses.push('timestamp>=?');
      args.push(query.from);
    }
    if (query.to !== undefined) {
      clauses.push('timestamp<?');
      args.push(query.to);
    }
    if (query.model) {
      clauses.push('model=?');
      args.push(query.model);
    }
    if (query.session) {
      clauses.push('session_id=?');
      args.push(query.session);
    }
    const rows = this.records(clauses, args);

    const result = aggregateUsage(
      rows,
      sessions,
      query,
      this.pricing,
      this.db
        .prepare(
          'SELECT DISTINCT model FROM usage_requests WHERE monitor_session_allowed(session_id)=1 ORDER BY model',
        )
        .all()
        .map((row) => String(row.model)),
      this.status,
      this.warnings(),
    );
    if (this.queryCache.size >= 16) this.queryCache.delete(this.queryCache.keys().next().value!);
    this.queryCache.set(cacheKey, result);
    return result;
  }
  private *records(clauses: string[], args: (string | number)[]) {
    const filter = clauses.length ? clauses.join(' AND ') + ' AND ' : '';
    const select = 'SELECT id,timestamp,data FROM usage_requests';
    let page = this.db
      .prepare(
        `${select} ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
      ORDER BY timestamp DESC,id LIMIT 2000`,
      )
      .all(...args);
    // Bound temporary row allocations while avoiding one native SQLite call per record.
    // Keyset pagination also avoids repeatedly walking an increasing OFFSET.
    const next = this.db.prepare(`${select} WHERE ${filter}timestamp<=? AND (timestamp<? OR id>?)
      ORDER BY timestamp DESC,id LIMIT 2000`);
    for (;;) {
      yield* page;
      if (page.length < 2000) return;
      const last = page[page.length - 1];
      page = next.all(...args, last.timestamp!, last.timestamp!, last.id!);
    }
  }
  private warnings() {
    const warnings = [this.pricing.warning];
    if (this.status.errors)
      warnings.push(`${this.status.errors} 个会话文件暂不可读，统计可能不完整。`);
    if (this.status.invalidLines)
      warnings.push(`已跳过 ${this.status.invalidLines} 条损坏或超过 8MB 的日志记录。`);
    if (this.status.uncertainRecords)
      warnings.push(`${this.status.uncertainRecords} 条继承用量缺少可靠基线，未计入统计。`);
    if (!this.status.files && this.status.updatedAt)
      warnings.push('尚未找到本地 JSONL 会话用量记录。');
    return warnings.filter(Boolean);
  }
  close() {
    this.closed = true;
    if (this.scanPromise) return this.scanPromise.finally(() => this.db.close());
    this.db.close();
    return Promise.resolve();
  }
}
