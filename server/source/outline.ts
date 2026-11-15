import type {
  OutlineEntry,
  SessionOutline,
  SessionStatus,
  TimelineEvent,
} from '../../src/types.js';
import { normalizeItem } from '../normalize.js';
import type { SourceDatabases } from './databases.js';
import type { RolloutStore } from './rollouts.js';
import type { InternalSession } from './session.js';
import { delegatedInputSql } from './sql.js';

/** Projects a compact directory without loading complete tool payloads. */
export class SessionOutlineReader {
  private outlineCache = new Map<string, SessionOutline>();
  constructor(
    private databases: Pick<SourceDatabases, 'history' | 'historyColumns'>,
    private rollouts: Pick<RolloutStore, 'read'>,
  ) {}
  async read(session: InternalSession, version: string): Promise<SessionOutline | null> {
    const id = session.id;
    const cached = this.outlineCache.get(id);
    if (cached?.version === version) return cached;
    const entries: OutlineEntry[] = [];
    let current: OutlineEntry | undefined, currentTurn: string | undefined;
    const add = (event: TimelineEvent, ordinal: number, status: SessionStatus, turnId?: string) => {
      if (turnId !== undefined && turnId !== currentTurn) {
        currentTurn = turnId;
        current = undefined;
      }
      if (!['user', 'assistant', 'tool'].includes(event.kind)) return;
      if (!current || (event.kind === 'user' && current.prompt)) {
        current = {
          id: event.id,
          ordinal,
          timestamp: event.timestamp,
          prompt: '',
          reply: '',
          tools: 0,
          status,
        };
        entries.push(current);
      }
      if (event.kind === 'user') {
        current.id = event.id;
        current.ordinal = ordinal;
        current.timestamp = event.timestamp;
        current.prompt = event.text.slice(0, 500);
      } else {
        if (event.kind === 'assistant' && event.text.trim())
          current.reply = event.text
            .replace(/[#*`]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 220);
        else if (event.kind === 'tool') current.tools++;
      }
    };
    let projected = false;
    if (this.databases.history && session.historyMode !== 'legacy') {
      try {
        const type = this.databases.historyColumns.has('item_type')
          ? 'item_type'
          : "CASE WHEN json_valid(item_json) THEN json_extract(item_json,'$.type') ELSE '' END";
        const normalizedType = `lower(replace(${type},'_',''))`;
        const rows = this.databases.history
          .prepare(
            `SELECT item_id,rollout_ordinal,created_at_ms,turn_id,${type} AS item_type,
             CASE WHEN ${normalizedType} IN ('usermessage','agentmessage') THEN item_json
                  WHEN ${normalizedType}='functioncalloutput' THEN
                    CASE WHEN ${delegatedInputSql('item_json')} THEN item_json ELSE NULL END
                  ELSE NULL END AS message_json
             FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal`,
          )
          .all(id);
        const statuses = new Map(
          this.databases.history
            .prepare('SELECT turn_id,status FROM thread_turns WHERE thread_id=?')
            .all(id)
            .map((row) => [String(row.turn_id), String(row.status)]),
        );
        for (const row of rows) {
          const raw = statuses.get(String(row.turn_id));
          const status: SessionStatus =
            raw === 'inProgress'
              ? session.status === 'stale'
                ? 'stale'
                : 'running'
              : raw === 'failed'
                ? 'failed'
                : raw === 'interrupted'
                  ? 'interrupted'
                  : raw === 'completed'
                    ? 'completed'
                    : 'idle';
          if (row.message_json) {
            try {
              const event = normalizeItem(
                JSON.parse(String(row.message_json)),
                String(row.item_id),
                Number(row.created_at_ms),
                String(row.turn_id),
              );
              if (event) add(event, Number(row.rollout_ordinal), status, String(row.turn_id));
            } catch {}
          } else if (
            !['reasoning', 'plan', 'contextcompaction'].includes(
              String(row.item_type).toLowerCase(),
            )
          )
            add(
              {
                id: String(row.item_id),
                kind: 'tool',
                text: '',
                timestamp: Number(row.created_at_ms),
              },
              Number(row.rollout_ordinal),
              status,
              String(row.turn_id),
            );
        }
        projected = rows.length > 0;
      } catch {}
    }
    if (!projected) {
      const parsed = await this.rollouts.read(session);
      parsed.events.forEach((event, ordinal) => add(event, ordinal, parsed.status));
    }
    const result = { sessionId: id, entries, version };
    if (this.outlineCache.size >= 8)
      this.outlineCache.delete(this.outlineCache.keys().next().value!);
    this.outlineCache.set(id, result);
    return result;
  }
}
