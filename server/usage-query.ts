import type { UsageData, UsageRequest, UsageSummary } from '../src/types.js';
import type { PricingCatalog } from './pricing.js';
import type { CodexSource } from './source.js';
import type { UsageRecord } from './usage-parser.js';

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

type UsageSession = Awaited<ReturnType<CodexSource['usageSessions']>>[number];
/** Aggregate a bounded row iterator; storage and caching belong to UsageStore. */
export function aggregateUsage(
  rows: Iterable<Record<string, unknown>>,
  sessions: UsageSession[],
  query: UsageQuery,
  pricing: Pick<PricingCatalog, 'cost'>,
  availableModels: string[],
  scan: UsageData['scan'],
  warnings: string[],
): UsageData {
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const summary: UsageSummary = {
    requests: 0,
    sessions: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedRequests: 0,
    cacheHitRate: null,
    firstTokenMs: null,
    firstTokenSamples: 0,
    tps: null,
    tpsSamples: 0,
  };
  const models = new Map<string, UsageData['models'][number]>(),
    days = new Map<string, UsageData['days'][number]>(),
    hours = new Map<number, UsageData['hours'][number]>(),
    usedSessions = new Set<string>();
  const requests: UsageRequest[] = [];
  let ttft = 0,
    timedOutput = 0,
    generationMs = 0;
  const offset = query.offset ?? 0,
    limit = query.limit ?? 50,
    shift = -(query.timezoneOffset ?? -480) * 60000;
  for (const row of rows) {
    const r = JSON.parse(String(row.data)) as UsageRecord,
      s = sessionMap.get(r.sessionId);
    if (query.subagents === 'false' && s?.subagent) continue;
    if (query.project && s?.cwd !== query.project) continue;
    const costUsd = pricing.cost(r.model, r),
      uncached = Math.max(0, r.input - r.cached - r.cacheWrite),
      total = r.input + r.output;
    const ms = r.durationMs === null ? null : r.durationMs - (r.firstTokenMs ?? 0);
    const tps = ms !== null && ms >= 250 && r.output > 0 ? (r.output * 1000) / ms : null;
    if (summary.requests >= offset && requests.length < limit)
      requests.push({
        id: r.id,
        sessionId: r.sessionId,
        sessionTitle: s?.title ?? r.sessionId,
        project: s?.project ?? '',
        model: r.model,
        timestamp: r.timestamp,
        inputTokens: r.input,
        uncachedInputTokens: uncached,
        cachedInputTokens: r.cached,
        cacheWriteTokens: r.cacheWrite,
        outputTokens: r.output,
        reasoningTokens: r.reasoning,
        totalTokens: total,
        costUsd,
        durationMs: r.durationMs,
        firstTokenMs: r.firstTokenMs,
        tps,
      });
    summary.requests++;
    usedSessions.add(r.sessionId);
    summary.inputTokens += r.input;
    summary.uncachedInputTokens += uncached;
    summary.cachedInputTokens += r.cached;
    summary.cacheWriteTokens += r.cacheWrite;
    summary.outputTokens += r.output;
    summary.reasoningTokens += r.reasoning;
    summary.totalTokens += total;
    summary.costUsd += costUsd ?? 0;
    summary.unpricedRequests += Number(costUsd === null);
    if (r.firstTokenMs !== null) {
      ttft += r.firstTokenMs;
      summary.firstTokenSamples++;
    }
    if (tps !== null) {
      timedOutput += r.output;
      generationMs += ms!;
      summary.tpsSamples++;
    }
    const model = models.get(r.model) ?? {
      model: r.model,
      requests: 0,
      tokens: 0,
      costUsd: 0,
      unpricedRequests: 0,
    };
    model.requests++;
    model.tokens += total;
    model.costUsd += costUsd ?? 0;
    model.unpricedRequests += Number(costUsd === null);
    models.set(r.model, model);
    const date = new Date(r.timestamp + shift).toISOString().slice(0, 10),
      day = days.get(date) ?? { date, tokens: 0, requests: 0, costUsd: 0 };
    day.tokens += total;
    day.requests++;
    day.costUsd += costUsd ?? 0;
    days.set(date, day);
    const hourKey = Math.floor((r.timestamp + shift) / 3600000) * 3600000 - shift,
      hour = hours.get(hourKey) ?? { timestamp: hourKey, tokens: 0, requests: 0 };
    hour.tokens += total;
    hour.requests++;
    hours.set(hourKey, hour);
  }
  summary.sessions = usedSessions.size;
  summary.cacheHitRate = summary.inputTokens
    ? summary.cachedInputTokens / summary.inputTokens
    : null;
  summary.firstTokenMs = summary.firstTokenSamples ? ttft / summary.firstTokenSamples : null;
  summary.tps = generationMs ? (timedOutput * 1000) / generationMs : null;
  const result: UsageData = {
    summary,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    hours: [...hours.values()].sort((a, b) => a.timestamp - b.timestamp),
    requests,
    total: summary.requests,
    offset,
    availableModels,
    scan: { ...scan },
    warnings,
  };

  return result;
}
