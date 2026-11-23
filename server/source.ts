import { existsSync, statSync } from 'node:fs';
import type {
  SessionOutline,
  SessionPage,
  SessionTurnTiming,
  TimelineEvent,
} from '../src/types.js';
import { contextFromRollout } from './context.js';
import { localImage, normalizeImagePath } from './media.js';
import { normalizeItem } from './normalize.js';
import type { SourceDatabases } from './source/databases.js';
import { openCodexDatabases } from './source/databases.js';
import { savedImage } from './source/images.js';
import { completionFilePaths, messageFiles, withMessageFiles } from './source/message-files.js';
import { messageImagePath, messageImages, withMessageImages } from './source/message-images.js';
import { SessionOutlineReader } from './source/outline.js';
import { RolloutStore } from './source/rollouts.js';
import { SessionIndex } from './source/session-index.js';
import { publicSession, validId, type InternalSession } from './source/session.js';
import { displayItemSql } from './source/sql.js';
import { CompletionReader, type SessionCompletion } from './source/completions.js';
import { InputRequestReader } from './source/input-requests.js';
import { ComputerUseReader } from './source/computer-use.js';
import type { SessionScope } from './session-scope.js';
import { historyTurnTiming } from './source/turn-timing.js';

export { validId } from './source/session.js';
/** Coordinates metadata, persisted history and rollout readers. */
export class CodexSource {
  private databases: SourceDatabases;
  private index: SessionIndex;
  private rollouts: RolloutStore;
  private outlines: SessionOutlineReader;
  private completionReader: CompletionReader;
  private inputRequestReader: InputRequestReader;
  private computerUseReader: ComputerUseReader;
  constructor(
    public home: string,
    private scope?: Pick<SessionScope, 'allows' | 'include'>,
  ) {
    this.databases = openCodexDatabases(home);
    this.rollouts = new RolloutStore(home);
    this.index = new SessionIndex(home, this.databases, this.rollouts, scope?.allows);
    this.outlines = new SessionOutlineReader(this.databases, this.rollouts);
    this.completionReader = new CompletionReader(this.databases, this.rollouts);
    this.inputRequestReader = new InputRequestReader(this.databases, this.rollouts);
    this.computerUseReader = new ComputerUseReader(this.databases, this.rollouts);
  }
  refresh(force = false) {
    return this.index.refresh(force);
  }
  include(id: string) {
    this.scope?.include(id);
  }
  allowsSession = (id: string) => this.scope?.allows(id) ?? true;
  overview() {
    return this.index.overview();
  }
  list(query: Parameters<SessionIndex['list']>[0]) {
    return this.index.list(query);
  }
  attentionSessions(since: number) {
    return this.index.attentionSessions(since);
  }
  get(id: string) {
    return this.index.get(id);
  }
  usageSessions() {
    return this.index.usageSessions();
  }
  async completions(since: number) {
    return this.completionReader.read(await this.index.notificationSessions(), since);
  }
  completionReply(event: SessionCompletion) {
    return this.completionReader.reply(event);
  }
  async completionFiles(id: string, turnId: string, occurredAt: number) {
    const session = await this.get(id);
    if (!session) return null;
    const event = (await this.completionReader.read([session], occurredAt))
      .find((entry) => entry.turnId === turnId && entry.completedAt === occurredAt);
    if (!event) return null;
    return { cwd: session.cwd, paths: completionFilePaths(this.completionReader.reply(event)) };
  }
  async inputRequests(since: number) {
    return this.inputRequestReader.read(await this.index.notificationSessions(), since);
  }
  activity(id: string): { turnId: string; compacting: boolean; running: boolean } | undefined {
    if (!validId(id) || (this.scope && !this.scope.allows(id)) || !this.databases.history) return;
    const turn = this.databases.history
      .prepare(
        'SELECT turn_id,status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1',
      )
      .get(id);
    if (!turn) return;
    const itemType = this.databases.historyColumns.has('item_type')
      ? 'item_type'
      : "json_extract(item_json,'$.type')";
    const running = ['inProgress', 'in_progress'].includes(String(turn.status));
    return {
      turnId: String(turn.turn_id),
      running,
      compacting:
        running &&
        !!this.databases.history
          .prepare(
            `SELECT 1 FROM thread_items WHERE thread_id=? AND turn_id=?
             AND lower(replace(${itemType},'_',''))='contextcompaction' LIMIT 1`,
          )
          .get(id, turn.turn_id!),
    };
  }
  async version(id: string) {
    const s = await this.get(id);
    if (!s) return '';
    const file = this.rollouts.safeFile(s.file);
    let fingerprint = 'missing';
    if (file) {
      const stat = statSync(file);
      fingerprint = `${stat.size}-${stat.mtimeMs}`;
    }
    return JSON.stringify([s.updatedAt, s.status, s.title, s.cwd, fingerprint]);
  }
  async detail(id: string, before?: number, limit = 70): Promise<SessionPage | null> {
    const s = await this.get(id);
    if (!s) return null;
    const warnings: string[] = [];
    let events: TimelineEvent[] = [];
    let total = 0;
    let next: number | null = null;
    let hasComputerUse = false;
    let turnTiming: SessionTurnTiming | undefined;
    if (this.databases.history && s.historyMode !== 'legacy') {
      try {
        total = Number(
          this.databases.history
            .prepare('SELECT count(*) AS n FROM thread_items WHERE thread_id=?')
            .get(id)!.n,
        );
        const rows = this.databases.history
          .prepare(
            `SELECT i.item_id,${displayItemSql('i.item_json')} AS item_json,i.rollout_ordinal,i.created_at_ms,i.turn_id,i.started_at_ms,i.completed_at_ms
             FROM (SELECT turn_id,item_id FROM thread_items WHERE thread_id=? AND rollout_ordinal<? ORDER BY rollout_ordinal DESC LIMIT ?) AS page
             JOIN thread_items i ON i.thread_id=? AND i.turn_id=page.turn_id AND i.item_id=page.item_id
             ORDER BY i.rollout_ordinal DESC`,
          )
          .all(id, before ?? Number.MAX_SAFE_INTEGER, limit + 1, id);
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        rows.reverse();
        for (const row of rows) {
          try {
            const e = normalizeItem(
              JSON.parse(String(row.item_json)),
              String(row.item_id),
              Number(row.created_at_ms),
              String(row.turn_id),
            );
            if (e) {
              e.durationMs ??=
                row.completed_at_ms && row.started_at_ms
                  ? Number(row.completed_at_ms) - Number(row.started_at_ms)
                  : undefined;
              events.push(e);
            }
          } catch {
            warnings.push('一条执行记录无法解析，已跳过。');
          }
        }
        if (hasMore && rows[0]) next = Number(rows[0].rollout_ordinal);
        turnTiming = historyTurnTiming(this.databases, s);
        if (before === undefined) {
          try {
            const live = this.databases.history
              .prepare(
                `SELECT item_id,${displayItemSql('item_json')} AS item_json,created_at_ms FROM thread_realtime_items WHERE thread_id=? ORDER BY rollout_ordinal`,
              )
              .all(id);
            for (const row of live) {
              try {
                const e = normalizeItem(
                  JSON.parse(String(row.item_json)),
                  String(row.item_id),
                  Number(row.created_at_ms),
                );
                if (e) {
                  const i = events.findIndex((x) => x.id === e.id);
                  if (i >= 0) events[i] = e;
                  else events.push(e);
                }
              } catch {}
            }
          } catch {}
        }
      } catch {
        warnings.push('执行历史暂时不可读，已尝试 JSONL 记录。');
        total = 0;
      }
    }
    if (!total) {
      const parsed = await this.rollouts.read(s);
      turnTiming = parsed.turnTiming;
      hasComputerUse = parsed.events.some((event) => event.computerUse);
      events = parsed.events;
      total = events.length;
      const end = before ?? total;
      const start = Math.max(0, end - limit);
      events = events.slice(start, end);
      next = start > 0 ? start : null;
      if (s.statusSource === 'rollout') s.status = parsed.status;
      if (!this.rollouts.safeFile(s.file))
        warnings.push('此会话的本地记录文件不存在或不在允许的会话目录内。');
    }
    if (before === undefined && s.status === 'running' && this.databases.history && total > 0) {
      const pending = await this.rollouts.pendingTools(s);
      for (const event of pending) if (!events.some((e) => e.id === event.id)) events.push(event);
      events.sort((a, b) => a.timestamp - b.timestamp);
    }
    const version = await this.version(id);
    return {
      session: publicSession(s),
      events: events.map((event) => withMessageFiles(withMessageImages(event))),
      total,
      before: next,
      version,
      turnTiming,
      hasComputerUse:
        hasComputerUse ||
        events.some((event) => event.computerUse) ||
        this.computerUseReader.has(s, version),
      warnings: [...new Set(warnings)],
      context: await (async () => {
        const file = this.rollouts.safeFile(s.file);
        if (!file) return undefined;
        try {
          return await contextFromRollout(file);
        } catch {
          return undefined;
        }
      })(),
    };
  }
  async outline(id: string): Promise<SessionOutline | null> {
    const session = await this.get(id);
    return session ? this.outlines.read(session, await this.version(id)) : null;
  }
  async computerUse(id: string, before?: number, limit?: number) {
    const session = await this.get(id);
    return session
      ? this.computerUseReader.page(session, await this.version(id), before, limit)
      : null;
  }
  async computerUseImage(id: string, itemId: string, index: number) {
    const session = await this.get(id);
    return session
      ? this.computerUseReader.image(session, await this.version(id), itemId, index)
      : null;
  }
  private async message(session: InternalSession, itemId: string, preferRealtime = false) {
    const id = session.id;
    const { history } = this.databases;
    if (history) {
      const saved = () =>
        history
          .prepare(`SELECT ${displayItemSql('item_json')} AS item_json FROM thread_items WHERE thread_id=? AND item_id=? LIMIT 1`)
          .get(id, itemId);
      const live = () => {
        try {
          return history
            .prepare(`SELECT ${displayItemSql('item_json')} AS item_json FROM thread_realtime_items WHERE thread_id=? AND item_id=? LIMIT 1`)
            .get(id, itemId);
        } catch {
          // Older history databases have no realtime table.
        }
      };
      const row = preferRealtime ? live() ?? saved() : saved() ?? live();
      if (row) {
        try {
          const event = normalizeItem(JSON.parse(String(row.item_json)), itemId, 0);
          if (event) return event;
        } catch {
          return null;
        }
      } else if (session.historyMode !== 'legacy') return null;
    }
    const parsed = await this.rollouts.read(session);
    return parsed.events.find((event) => event.id === itemId) ?? null;
  }
  async fileLink(id: string, itemId: string, linkId: string) {
    const session = await this.get(id);
    if (!session) return null;
    const event = await this.message(session, itemId, true);
    const link = event && messageFiles(event).find((file) => file.id === linkId);
    return link ? { cwd: session.cwd, link } : null;
  }
  async image(id: string, itemId: string, imageIndex?: number) {
    const session = await this.get(id);
    if (!session) return null;
    const event = await this.message(session, itemId);
    if (!event) return null;
    if (imageIndex !== undefined) {
      const image = messageImages(event)[imageIndex];
      return image?.source ? localImage(messageImagePath(image.source)) : null;
    }
    if (!event.image || !event.text) return null;
    const file = normalizeImagePath(event.text);
    if (existsSync(file)) return localImage(file);
    const saved = await savedImage(this.rollouts.safeFile(session.file), itemId);
    if (saved) return saved;
    return localImage(file);
  }
  async export(id: string) {
    const session = await this.get(id);
    if (!session) return null;
    let before: number | undefined;
    let batches: TimelineEvent[][] = [];
    for (;;) {
      const page = await this.detail(id, before, 200);
      if (!page) break;
      batches.unshift(page.events);
      if (page.before === null) break;
      before = page.before;
    }
    return (
      `# ${session.title}\n\n项目：${session.cwd}\n\n会话：${id}\n\n` +
      batches
        .flat()
        .map(
          (e) =>
            `## ${e.kind === 'user' ? '你' : e.kind === 'assistant' ? 'Codex' : (e.title ?? e.name ?? e.kind)} · ${new Date(e.timestamp).toISOString()}\n\n${e.text}\n${e.output ? '\n```text\n' + e.output + '\n```\n' : ''}`,
        )
        .join('\n')
    );
  }
  close() {
    this.databases.state?.close();
    this.databases.history?.close();
  }
}
