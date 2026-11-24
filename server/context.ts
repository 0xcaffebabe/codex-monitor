import { open, stat } from 'node:fs/promises';
import type { SessionContext } from '../src/types.js';
import { jsonLines } from './jsonl.js';

type CompactionRecord = 'checkpoint' | 'event' | 'item';
type ContextSnapshot = {
  version: string;
  identity: string;
  size: number;
  offset: number;
  counts: Record<CompactionRecord, number>;
  context: SessionContext;
};

const cache = new Map<string, ContextSnapshot>();
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function compactionRecord(record: any): CompactionRecord | undefined {
  if (record.type === 'compacted') return 'checkpoint';
  if (record.type !== 'event_msg') return;
  const p = record.payload;
  if (p?.type === 'context_compacted') return 'event';
  if (
    p?.type === 'item_completed' &&
    String(p.item?.type).replaceAll('_', '').toLowerCase() === 'contextcompaction'
  )
    return 'item';
}

export async function contextFromRollout(file: string): Promise<SessionContext> {
  const info = await stat(file),
    identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`,
    version = `${info.size}-${info.mtimeMs}`,
    saved = cache.get(file);
  const sameFile = saved?.identity === identity ? saved : undefined;
  if (sameFile?.version === version) return sameFile.context;
  const previous = sameFile && sameFile.size < info.size ? sameFile : undefined;
  const counts = previous ? { ...previous.counts } : { checkpoint: 0, event: 0, item: 0 };
  const start = previous?.offset ?? 0;
  const handle = await open(file, 'r'),
    size = Math.min(info.size, 2 * 1024 * 1024),
    buffer = Buffer.alloc(size);
  let used: number | null = null,
    limit: number | null = null,
    updatedAt: number | null = null,
    offset = start;
  try {
    const { bytesRead } = await handle.read(buffer, 0, size, info.size - size);
    const tail = buffer.subarray(0, bytesRead);
    const lastNewline = tail.lastIndexOf(10);
    if (lastNewline >= 0) offset = info.size - size + lastNewline + 1;
    let lines = tail.toString('utf8').split('\n');
    if (info.size > size) lines = lines.slice(1);
    for (const line of lines) {
      try {
        const record = JSON.parse(line),
          p = record.payload ?? {};
        if (count(p.model_context_window) && p.model_context_window > 0)
          limit = p.model_context_window;
        if (record.type === 'session_meta' && count(p.context_window) && p.context_window > 0)
          limit = p.context_window;
        if (compactionRecord(record)) {
          used = null;
          updatedAt = null;
        }
        if (record.type === 'event_msg' && p.type === 'token_count' && p.info) {
          if (count(p.info.model_context_window) && p.info.model_context_window > 0)
            limit = p.info.model_context_window;
          const usage = p.info.last_token_usage;
          if (usage) {
            const total = count(usage.total_tokens)
              ? usage.total_tokens
              : count(usage.input_tokens) && count(usage.output_tokens)
                ? usage.input_tokens + usage.output_tokens
                : null;
            if (total !== null) {
              used = total;
              updatedAt = Date.parse(record.timestamp) || null;
            }
          }
        }
      } catch {}
    }
  } finally {
    await handle.close();
  }
  if (offset > start) {
    for await (const line of jsonLines(file, 8_000_000, {
      start,
      end: offset - 1,
      oversizedPrefixBytes: 256,
    })) {
      // Compaction checkpoints can contain a full replacement history, even on oversized lines.
      if (
        /^\s*\{\s*(?:"timestamp"\s*:\s*"[^"]*"\s*,\s*)?"type"\s*:\s*"compacted"\s*,/.test(line)
      ) {
        counts.checkpoint++;
      } else if (/compact/i.test(line)) {
        try {
          const kind = compactionRecord(JSON.parse(line));
          if (kind) counts[kind]++;
        } catch {}
      }
    }
  }
  const context = {
    usedTokens: used,
    limitTokens: limit,
    percent: used !== null && limit !== null ? (used / limit) * 100 : null,
    updatedAt,
    // The checkpoint and completion notifications may describe the same compaction.
    compactionCount: Math.max(counts.checkpoint, counts.event, counts.item),
  };
  if (saved !== cache.get(file)) return context;
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(file, { version, identity, size: info.size, offset, counts, context });
  return context;
}
