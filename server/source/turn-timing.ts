import type { SessionTurnTiming } from '../../src/types.js';
import { normalizeItem } from '../normalize.js';
import type { SourceDatabases } from './databases.js';
import type { InternalSession } from './session.js';
import { delegatedInputSql } from './sql.js';

/** Read the latest prompt independently of the visible history page. */
export function historyTurnTiming(
  databases: SourceDatabases,
  session: InternalSession,
): SessionTurnTiming | undefined {
  const history = databases.history;
  if (!history) return;
  try {
    const type = databases.historyColumns.has('item_type')
      ? 'item_type'
      : "json_extract(item_json,'$.type')";
    const prompts = history
      .prepare(
        `SELECT item_id,item_json,created_at_ms,rollout_ordinal FROM thread_items
         WHERE thread_id=? AND json_valid(item_json)
         AND (lower(replace(${type},'_',''))='usermessage' OR (${delegatedInputSql('item_json')}))
         ORDER BY rollout_ordinal DESC`,
      )
      .iterate(session.id);
    for (const row of prompts) {
      const event = normalizeItem(
        JSON.parse(String(row.item_json)),
        String(row.item_id),
        Number(row.created_at_ms),
      );
      if (event?.kind !== 'user' || !Number.isFinite(event.timestamp) || event.timestamp <= 0)
        continue;
      const startedAt = event.timestamp;
      const turn = history
        .prepare(
          'SELECT status,completed_at FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1',
        )
        .get(session.id);
      if (!['completed', 'interrupted', 'failed'].includes(String(turn?.status ?? session.status)))
        return { startedAt, finishedAt: null };
      let finishedAt = Number(turn?.completed_at) * 1000;
      if (!Number.isFinite(finishedAt) || finishedAt <= 0) {
        const last = history
          .prepare(
            `SELECT MAX(created_at_ms) AS created_at_ms,MAX(completed_at_ms) AS completed_at_ms
             FROM thread_items WHERE thread_id=? AND rollout_ordinal>=?`,
          )
          .get(session.id, row.rollout_ordinal!);
        finishedAt = Math.max(Number(last?.created_at_ms) || 0, Number(last?.completed_at_ms) || 0);
      }
      return { startedAt, finishedAt: Math.max(startedAt, finishedAt) };
    }
  } catch {
    // Timing metadata must not prevent the conversation from being read.
  }
}
