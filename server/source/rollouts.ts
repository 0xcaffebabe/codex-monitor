import { existsSync, realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { SessionStatus, SessionTurnTiming, TimelineEvent } from '../../src/types.js';
import { jsonLines } from '../jsonl.js';
import { normalizeRecord } from '../normalize.js';
import type { InternalSession } from './session.js';

/** Bounded JSONL reads, pending calls and versioned parsing cache. */
export class RolloutStore {
  private jsonCache = new Map<
    string,
    {
      mtime: number;
      size: number;
      events: TimelineEvent[];
      status: SessionStatus;
      turnTiming?: SessionTurnTiming;
    }
  >();
  private rolloutReads = new Map<
    string,
    { version: string; promise: ReturnType<RolloutStore['parseRollout']> }
  >();
  constructor(private home: string) {}
  status(id: string): SessionStatus {
    return this.jsonCache.get(id)?.status ?? 'idle';
  }
  safeFile(file: string): string | null {
    if (!file || !file.endsWith('.jsonl')) return null;
    const plain = (value: string) => value.replace(/^\\\\\?\\(?=[A-Za-z]:[\\/])/, '');
    try {
      const real = plain(realpathSync(plain(file)));
      for (const dir of ['sessions', 'archived_sessions']) {
        const root = path.join(this.home, dir);
        if (!existsSync(root)) continue;
        const rel = path.relative(plain(realpathSync(root)), real);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return real;
      }
    } catch {
      /* An unavailable rollout is reported in the detail response. */
    }
    return null;
  }
  async pendingTools(s: InternalSession): Promise<TimelineEvent[]> {
    const file = this.safeFile(s.file);
    if (!file) return [];
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat(),
        start = Math.max(0, stat.size - 1024 * 1024),
        buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start) lines = lines.slice(1);
      const pending = new Map<string, TimelineEvent>();
      for (let i = 0; i < lines.length; i++) {
        try {
          const r = JSON.parse(lines[i]),
            p = r.payload ?? {};
          if (r.type !== 'response_item') continue;
          if (['function_call', 'custom_tool_call'].includes(p.type)) {
            const event = normalizeRecord(r, i);
            if (event && p.call_id) {
              event.id = 'pending-' + p.call_id;
              event.transient = true;
              pending.set(p.call_id, event);
            }
          } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type))
            pending.delete(p.call_id);
        } catch {}
      }
      return [...pending.values()];
    } finally {
      await handle.close();
    }
  }
  async read(s: InternalSession) {
    const file = this.safeFile(s.file);
    if (!file)
      return {
        events: [],
        status: 'idle' as SessionStatus,
        turnTiming: undefined,
      };
    const stat = statSync(file),
      cached = this.jsonCache.get(s.id);
    if (cached?.mtime === stat.mtimeMs && cached.size === stat.size) return cached;
    const version = `${stat.mtimeMs}:${stat.size}`,
      pending = this.rolloutReads.get(s.id);
    if (pending?.version === version) return pending.promise;
    const promise = this.parseRollout(s, file, stat);
    this.rolloutReads.set(s.id, { version, promise });
    try {
      return await promise;
    } finally {
      if (this.rolloutReads.get(s.id)?.promise === promise) this.rolloutReads.delete(s.id);
    }
  }
  private async parseRollout(
    s: InternalSession,
    file: string,
    stat: { mtimeMs: number; size: number },
  ) {
    const events: TimelineEvent[] = [];
    const byId = new Map<string, TimelineEvent>();
    let ordinal = 0;
    let status: SessionStatus = 'idle';
    let turnTiming: SessionTurnTiming | undefined;
    for await (const line of jsonLines(file, 8_000_000)) {
      ordinal++;
      try {
        const r = JSON.parse(line),
          p = r.payload ?? {};
        if (r.type === 'event_msg') {
          if (['task_started', 'turn_started'].includes(p.type)) {
            status = 'running';
            if (turnTiming) turnTiming.finishedAt = null;
          } else if (['task_complete', 'task_completed'].includes(p.type)) status = 'completed';
          else if (p.type === 'turn_aborted') status = 'interrupted';
          if (['task_complete', 'task_completed', 'turn_aborted'].includes(p.type)) {
            const timestamp = Date.parse(r.timestamp);
            if (turnTiming && Number.isFinite(timestamp))
              turnTiming.finishedAt = Math.max(turnTiming.startedAt, timestamp);
          }
        }
        const e = normalizeRecord(r, ordinal);
        if (
          r.type === 'response_item' &&
          ['function_call_output', 'custom_tool_call_output'].includes(p.type)
        ) {
          const tool = byId.get(p.call_id);
          if (tool) {
            tool.status = 'completed';
          }
          if (e?.kind !== 'user') continue;
        }
        if (!e) continue;
        const previous = events.at(-1);
        if (
          e.kind === 'user' &&
          Number.isFinite(e.timestamp) &&
          e.timestamp > 0 &&
          !(previous?.kind === 'user' && previous.text === e.text)
        )
          turnTiming = { startedAt: e.timestamp, finishedAt: null };
        if (byId.has(e.id)) Object.assign(byId.get(e.id)!, e);
        else {
          events.push(e);
          byId.set(e.id, e);
        }
      } catch {
        /* Concurrent writes can leave a partial last line; it is retried after mtime changes. */
      }
    }
    // Legacy Codex logs repeat user/assistant messages in event_msg and response_item.
    const dedup: TimelineEvent[] = [];
    for (const e of events) {
      const prev = dedup.at(-1);
      if (
        prev &&
        ['user', 'assistant'].includes(e.kind) &&
        prev.kind === e.kind &&
        prev.text === e.text
      )
        continue;
      dedup.push(e);
    }
    if (status === 'running' && Date.now() - stat.mtimeMs > 15 * 60000) status = 'stale';
    const result = { mtime: stat.mtimeMs, size: stat.size, events: dedup, status, turnTiming };
    if (this.jsonCache.size >= 5) this.jsonCache.delete(this.jsonCache.keys().next().value!);
    this.jsonCache.set(s.id, result);
    return result;
  }
}
