import { statSync } from 'node:fs';
import type { Session } from '../../src/types.js';
import { jsonLines } from '../jsonl.js';
import { textOf } from '../normalize.js';
import type { SourceDatabases } from './databases.js';
import type { RolloutStore } from './rollouts.js';
import type { InternalSession } from './session.js';

const REPLY_LIMIT = 128 * 1024;

export type SessionCompletion = {
  key: string;
  session: Session;
  turnId: string;
  completedAt: number;
  summary?: string;
};

export class CompletionReader {
  private cache = new Map<string, { version: string; events: SessionCompletion[] }>();
  constructor(
    private databases: SourceDatabases,
    private rollouts: RolloutStore,
  ) {}

  async read(sessions: InternalSession[], since: number) {
    const visible = new Map(
      sessions.filter((s) => !s.subagent && !s.archived).map((s) => [s.id, s]),
    );
    const events: SessionCompletion[] = [];
    const history = this.databases.history;
    if (history) {
      const rows = history
        .prepare(
          "SELECT thread_id,turn_id,completed_at FROM thread_turns WHERE status='completed' AND completed_at>=? ORDER BY completed_at,thread_id,rollout_ordinal,turn_id",
        )
        .all(Math.floor(since / 1000));
      for (const row of rows) {
        const session = visible.get(String(row.thread_id));
        if (!session) continue;
        events.push({
          key: `${session.id}:${row.turn_id}`,
          session,
          turnId: String(row.turn_id),
          completedAt: Number(row.completed_at) * 1000,
        });
      }
    }
    for (const session of visible.values()) {
      if (session.latestTurn || session.updatedAt < since - 15000) continue;
      const file = this.rollouts.safeFile(session.file);
      if (!file) continue;
      const stat = statSync(file),
        version = `${stat.size}:${stat.mtimeMs}`;
      let cached = this.cache.get(session.id);
      if (cached?.version !== version) {
        const parsed: SessionCompletion[] = [];
        let turnId = '',
          summary = '',
          ordinal = 0;
        for await (const line of jsonLines(file, 8_000_000)) {
          ordinal++;
          try {
            const record = JSON.parse(line),
              payload = record.payload ?? {};
            if (
              record.type === 'event_msg' &&
              ['task_started', 'turn_started'].includes(payload.type)
            ) {
              turnId = String(payload.turn_id || payload.id || `legacy-${ordinal}`);
              summary = '';
            }
            if (
              record.type === 'response_item' &&
              payload.type === 'message' &&
              payload.role === 'assistant'
            )
              summary = textOf(payload.content, REPLY_LIMIT);
            if (
              record.type === 'event_msg' &&
              ['task_complete', 'task_completed'].includes(payload.type)
            ) {
              const id = String(payload.turn_id || turnId || `legacy-${ordinal}`);
              const completedAt = Date.parse(record.timestamp);
              if (Number.isFinite(completedAt))
                parsed.push({
                  key: `${session.id}:${id}`,
                  session,
                  turnId: id,
                  completedAt,
                  summary: textOf(payload.last_agent_message ?? summary, REPLY_LIMIT),
                });
            }
          } catch {
            /* Partial JSONL lines are retried after the file changes. */
          }
        }
        cached = { version, events: parsed };
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(session.id, cached);
      }
      events.push(
        ...cached.events
          .filter((event) => event.completedAt >= since)
          .map((event) => ({ ...event, session })),
      );
    }
    return events;
  }

  summary(event: SessionCompletion) {
    return this.reply(event, 1000);
  }

  reply(event: Pick<SessionCompletion, 'session' | 'turnId' | 'summary'>, limit = REPLY_LIMIT) {
    if (event.summary !== undefined) return event.summary.slice(0, limit);
    const row = this.databases.history
      ?.prepare(
        `SELECT substr(json_extract(item_json,'$.text'),1,?) AS text,
              substr(json_extract(item_json,'$.content'),1,?) AS content
       FROM thread_items WHERE thread_id=? AND turn_id=?
       AND lower(replace(json_extract(item_json,'$.type'),'_',''))='agentmessage'
       AND (json_extract(item_json,'$.phase') IN ('final','final_answer') OR json_extract(item_json,'$.phase') IS NULL)
       ORDER BY rollout_ordinal DESC LIMIT 1`,
      )
      .get(limit, limit === 1000 ? 4000 : 1024 * 1024, event.session.id, event.turnId);
    if (typeof row?.text === 'string') return row.text;
    try {
      return textOf(JSON.parse(String(row?.content || '[]')), limit);
    } catch {
      return '';
    }
  }
}
