import { jsonLines } from '../jsonl.js';
import type { SourceDatabases } from './databases.js';
import type { RolloutStore } from './rollouts.js';
import type { InternalSession } from './session.js';
import type { Session } from '../../src/types.js';
import { delegatedInputSql } from './sql.js';

export type InputQuestion = { title: string; options: string[] };
export type SessionInputRequest = {
  key: string;
  session: Session;
  requestId: string;
  createdAt: number;
  questions: InputQuestion[];
};

function questionsFrom(value: unknown): InputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((question) => {
      if (!question || typeof question !== 'object') return [];
      const title = question.title ?? question.question;
      if (typeof title !== 'string' || !title.trim()) return [];
      const options = Array.isArray(question.options)
        ? question.options
            .flatMap((option: unknown) => {
              const label =
                typeof option === 'string'
                  ? option
                  : option && typeof option === 'object' && 'label' in option
                    ? option.label
                    : undefined;
              return typeof label === 'string' ? [label.slice(0, 150)] : [];
            })
            .slice(0, 5)
        : [];
      return [{ title: title.slice(0, 600), options }];
    })
    .slice(0, 3);
}

function inputQuestions(item: any): InputQuestion[] {
  const type = String(item.type || '')
    .replaceAll('_', '')
    .toLowerCase();
  if (type === 'agentmessage') return questionsFrom(item.questions);
  const tool = String(item.tool ?? item.name ?? '')
    .split(/[.:]/)
    .at(-1);
  if (!['request_user_input', 'request_user_input_async'].includes(tool || '')) return [];
  if (item.status && !['inProgress', 'in_progress', 'pending'].includes(item.status)) return [];
  try {
    const args = item.arguments ?? item.input ?? {};
    return questionsFrom((typeof args === 'string' ? JSON.parse(args) : args).questions);
  } catch {
    return [];
  }
}

/** Read structured questions only; prose and tool output cannot create reminders. */
export class InputRequestReader {
  constructor(
    private databases: SourceDatabases,
    private rollouts: RolloutStore,
  ) {}

  async read(sessions: InternalSession[], since: number) {
    const requests = new Map<string, SessionInputRequest>();
    const history = this.databases.history;
    const itemType = this.databases.historyColumns.has('item_type')
      ? 'item_type'
      : "json_extract(item_json,'$.type')";
    const add = (session: InternalSession, id: string, at: number, questions: InputQuestion[]) => {
      if (!questions.length || !Number.isFinite(at) || at < since) return;
      const key = `input:${session.id}:${id}`;
      requests.set(key, { key, session, requestId: id, createdAt: at, questions });
    };
    for (const session of sessions) {
      if (
        session.subagent ||
        session.archived ||
        (session.status !== 'running' && session.updatedAt < since - 15000)
      )
        continue;
      if (history && session.latestTurn) {
        // Native questions are projected as agentMessage.questions, including async requests.
        // Bound reads to each recent session and filter type before projecting JSON content.
        const rows = history
          .prepare(
            `SELECT item_id,rollout_ordinal,created_at_ms,
          CASE WHEN lower(replace(${itemType},'_',''))='agentmessage'
            THEN json_object('type','agentMessage','questions',json_extract(item_json,'$.questions'))
            ELSE json_object('type','dynamicToolCall','tool',json_extract(item_json,'$.tool'),
              'name',json_extract(item_json,'$.name'),'status',json_extract(item_json,'$.status'),
              'arguments',json_extract(item_json,'$.arguments')) END AS request_json
          FROM thread_items WHERE thread_id=? AND created_at_ms>=?
          AND lower(replace(${itemType},'_','')) IN ('agentmessage','dynamictoolcall')
          ORDER BY rollout_ordinal`,
          )
          .all(session.id, since);
        let lastUser = Number(
          history
            .prepare(
              `SELECT COALESCE(MAX(rollout_ordinal),-1) AS ordinal FROM thread_items
          WHERE thread_id=? AND (lower(replace(${itemType},'_',''))='usermessage'
            OR (lower(replace(${itemType},'_',''))='functioncalloutput' AND ${delegatedInputSql('item_json')}
              AND json_extract(item_json,'$.output') LIKE '<codex_delegation>%'))`,
            )
            .get(session.id)!.ordinal,
        );
        try {
          const liveUser = history
            .prepare(
              `SELECT COALESCE(MAX(rollout_ordinal),-1) AS ordinal FROM thread_realtime_items WHERE thread_id=?
            AND (lower(replace(json_extract(item_json,'$.type'),'_',''))='usermessage'
              OR (${delegatedInputSql('item_json')} AND json_extract(item_json,'$.output') LIKE '<codex_delegation>%'))`,
            )
            .get(session.id);
          lastUser = Math.max(lastUser, Number(liveUser?.ordinal ?? -1));
        } catch {
          /* Older history databases have no realtime table. */
        }
        for (const row of rows) {
          if (Number(row.rollout_ordinal) <= lastUser) continue;
          try {
            add(
              session,
              String(row.item_id),
              Number(row.created_at_ms),
              inputQuestions(JSON.parse(String(row.request_json))),
            );
          } catch {
            /* A malformed question cannot block other sessions. */
          }
        }
        try {
          const live = history
            .prepare(
              `SELECT item_id,rollout_ordinal,created_at_ms,
            json_object('type',json_extract(item_json,'$.type'),'questions',json_extract(item_json,'$.questions')) AS request_json
            FROM thread_realtime_items WHERE thread_id=? AND created_at_ms>=?
            AND lower(replace(json_extract(item_json,'$.type'),'_',''))='agentmessage'`,
            )
            .all(session.id, since);
          for (const row of live) {
            if (Number(row.rollout_ordinal) <= lastUser) continue;
            try {
              add(
                session,
                String(row.item_id),
                Number(row.created_at_ms),
                inputQuestions(JSON.parse(String(row.request_json))),
              );
            } catch {
              /* Realtime projections are replaced by the persisted item with the same ID. */
            }
          }
        } catch {
          /* Older Codex versions have no realtime table. */
        }
        continue;
      }
      const file = this.rollouts.safeFile(session.file);
      if (!file) continue;
      const pending = new Map<string, SessionInputRequest>();
      const asynchronous = new Set<string>();
      let ordinal = 0;
      for await (const line of jsonLines(file, 8_000_000)) {
        ordinal++;
        try {
          const record = JSON.parse(line),
            payload = record.payload ?? {};
          if (
            (record.type === 'response_item' &&
              payload.type === 'message' &&
              payload.role === 'user') ||
            (record.type === 'event_msg' && payload.type === 'user_message')
          ) {
            pending.clear();
            asynchronous.clear();
          }
          if (
            record.type === 'response_item' &&
            ['function_call_output', 'custom_tool_call_output'].includes(payload.type)
          ) {
            const request = pending.get(String(payload.call_id));
            if (request && !asynchronous.has(String(payload.call_id)))
              pending.delete(String(payload.call_id));
          }
          const item =
            record.type === 'event_msg' && payload.type === 'item_completed'
              ? payload.item
              : record.type === 'response_item'
                ? payload
                : undefined;
          if (!item) continue;
          const questions = inputQuestions(item);
          if (!questions.length) continue;
          const id = String(item.id ?? item.call_id ?? `line-${ordinal}`),
            createdAt = Date.parse(record.timestamp);
          if (!Number.isFinite(createdAt) || createdAt < since) continue;
          if (
            String(item.name ?? item.tool ?? '').endsWith('request_user_input_async') ||
            item.delivery === 'async'
          )
            asynchronous.add(id);
          pending.set(id, {
            key: `input:${session.id}:${id}`,
            session,
            requestId: id,
            createdAt,
            questions,
          });
        } catch {
          /* Concurrent partial JSONL writes are retried on the next poll. */
        }
      }
      for (const request of pending.values()) requests.set(request.key, request);
    }
    return [...requests.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}
