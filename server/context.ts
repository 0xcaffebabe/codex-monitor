import { open, stat } from 'node:fs/promises';
import type { SessionContext } from '../src/types.js';
const cache = new Map<string, { version: string; context: SessionContext }>();
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
export async function contextFromRollout(file: string): Promise<SessionContext> {
  const info = await stat(file),
    version = `${info.size}-${info.mtimeMs}`,
    saved = cache.get(file);
  if (saved?.version === version) return saved.context;
  const handle = await open(file, 'r'),
    size = Math.min(info.size, 2 * 1024 * 1024),
    buffer = Buffer.alloc(size);
  let used: number | null = null,
    limit: number | null = null,
    updatedAt: number | null = null;
  try {
    const { bytesRead } = await handle.read(buffer, 0, size, info.size - size);
    let lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (info.size > size) lines = lines.slice(1);
    for (const line of lines) {
      try {
        const record = JSON.parse(line),
          p = record.payload ?? {};
        if (count(p.model_context_window) && p.model_context_window > 0)
          limit = p.model_context_window;
        if (record.type === 'session_meta' && count(p.context_window) && p.context_window > 0)
          limit = p.context_window;
        if (
          record.type === 'compacted' ||
          (record.type === 'event_msg' &&
            (p.type === 'context_compacted' ||
              (p.type === 'item_completed' &&
                String(p.item?.type).toLowerCase() === 'contextcompaction')))
        ) {
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
  const context = {
    usedTokens: used,
    limitTokens: limit,
    percent: used !== null && limit !== null ? (used / limit) * 100 : null,
    updatedAt,
  };
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(file, { version, context });
  return context;
}
