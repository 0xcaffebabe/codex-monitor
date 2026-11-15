import { createHash } from 'node:crypto';

export interface Tokens {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}
export interface UsageRecord extends Tokens {
  id: string;
  sessionId: string;
  turnId: string;
  model: string;
  timestamp: number;
  durationMs: number | null;
  firstTokenMs: number | null;
}
interface Timer {
  boundary?: number;
  start?: number;
  first?: number;
  lastOutput?: number;
  toolAfter?: number;
  lastCount?: number;
}
export interface ParserState {
  version: number;
  sessionId: string;
  model: string;
  turnId: string;
  cutoff: number;
  inherited: boolean;
  total?: Tokens;
  signatures: string[];
  covered?: { usage: Tokens; total?: Tokens };
  timer: Timer;
  invalid: number;
  uncertain: number;
  skipping?: boolean;
}
export const USAGE_PARSER_VERSION = 3;
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const count = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0);
const at = (n: unknown): number | undefined => {
  const value = typeof n === 'string' ? Date.parse(n) : typeof n === 'number' ? n : NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
};
export function tokens(raw: any): Tokens | undefined {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !['input_tokens', 'output_tokens', 'cached_input_tokens'].some(
      (k) => typeof raw[k] === 'number',
    )
  )
    return;
  const input = count(raw.input_tokens),
    cached = Math.min(input, count(raw.cached_input_tokens));
  return {
    input,
    cached,
    cacheWrite: Math.min(input - cached, count(raw.cache_write_input_tokens)),
    output: count(raw.output_tokens),
    reasoning: Math.min(count(raw.output_tokens), count(raw.reasoning_output_tokens)),
  };
}
const nonzero = (t?: Tokens): t is Tokens => !!t && t.input + t.output > 0;
const same = (a: Tokens | undefined, b: Tokens | undefined) =>
  !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

// These are log-derived timings, not measurements of an HTTP connection. Lock the
// boundary at the first model output so later tool execution cannot move it forward.
export class UsageParser {
  state: ParserState;
  constructor(
    sessionId: string,
    state?: ParserState,
    private baseline?: Tokens,
    private createdAt?: number,
  ) {
    this.state = state ?? {
      version: USAGE_PARSER_VERSION,
      sessionId,
      model: 'unknown',
      turnId: '',
      cutoff: 0,
      inherited: false,
      signatures: [],
      timer: {},
      invalid: 0,
      uncertain: 0,
    };
  }
  private boundary(timestamp?: number) {
    if (timestamp) this.state.timer.boundary = Math.max(this.state.timer.boundary ?? 0, timestamp);
  }
  private output(timestamp?: number) {
    if (!timestamp) return;
    const t = this.state.timer;
    // Older versions flush the previous response's items after its usage snapshot.
    if (!t.start && t.lastCount && timestamp - t.lastCount <= 100) return;
    t.start ??= t.boundary;
    t.lastOutput = timestamp;
    t.toolAfter = undefined;
  }
  private timing(end?: number, legacy = false) {
    const t = this.state.timer,
      start = t.start ?? t.boundary;
    if (legacy && t.toolAfter && end && end - t.toolAfter <= 100) end = t.lastOutput;
    const durationMs =
      start && end && end - start >= 250 && end - start <= 86400000 ? end - start : null;
    const firstTokenMs =
      durationMs !== null &&
      start &&
      t.first !== undefined &&
      t.first >= start &&
      t.first - start < durationMs
        ? t.first - start
        : null;
    this.state.timer = {
      boundary: Math.max(t.boundary ?? 0, end ?? 0) || undefined,
      lastCount: end,
    };
    return { durationMs, firstTokenMs };
  }
  parse(line: string): UsageRecord[] {
    // Skip large tool bodies and messages that cannot affect usage or request timing.
    const head = line.slice(0, 300);
    if (
      !/"type"\s*:\s*"(?:session_meta|turn_context|event_msg|response_item|token_usage_record)"/.test(
        head,
      )
    )
      return [];
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      this.state.invalid++;
      return [];
    }
    const p = r.payload ?? {},
      s = this.state,
      timestamp = at(r.timestamp);
    if (r.type === 'session_meta') {
      const copiedMeta = typeof p.id === 'string' && !!s.sessionId && p.id !== s.sessionId;
      if (!s.sessionId && typeof p.id === 'string') s.sessionId = p.id;
      s.inherited = !!(
        copiedMeta ||
        p.forked_from_id ||
        p.history_base_thread_id ||
        p.source?.subagent?.thread_spawn?.parent_thread_id
      );
      // A fork can contain copied parent history. Only count its own later requests.
      if (copiedMeta || p.forked_from_id || p.source?.subagent?.thread_spawn?.parent_thread_id) {
        s.cutoff = Math.max(
          s.cutoff,
          this.createdAt ?? 0,
          copiedMeta ? 0 : (at(p.timestamp) ?? timestamp ?? 0),
        );
      }
      s.total ??= this.baseline;
      if (p.model) s.model = String(p.model);
      return [];
    }
    if (r.type === 'turn_context') {
      if (p.model) s.model = String(p.model);
      if (p.turn_id) s.turnId = String(p.turn_id);
      this.boundary(timestamp);
    }
    if (r.type === 'event_msg') {
      if (p.type === 'thread_settings_applied' && p.settings?.model)
        s.model = String(p.settings.model);
      if (
        p.type === 'task_started' ||
        p.type === 'turn_started' ||
        p.type === 'turn_aborted' ||
        p.type === 'task_complete'
      ) {
        s.timer = { boundary: timestamp, lastCount: s.timer.lastCount };
        s.turnId = String(p.turn_id ?? s.turnId);
      }
      if (p.type === 'user_message') this.boundary(timestamp);
      if (p.type === 'item_completed') {
        const kind = String(p.item?.type ?? '').toLowerCase();
        if (kind === 'usermessage') this.boundary(timestamp);
        if (kind === 'agentmessage' || kind === 'reasoning') {
          this.output(timestamp);
          const first = at(p.started_at_ms);
          if (first && timestamp && first <= timestamp)
            s.timer.first = Math.min(s.timer.first ?? first, first);
        }
      }
    }
    if (r.type === 'response_item') {
      if (p.type === 'message' && (p.role === 'user' || p.role === 'developer'))
        this.boundary(timestamp);
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        this.boundary(timestamp);
        if (s.timer.lastOutput) s.timer.toolAfter = timestamp;
      }
      if (
        (p.type === 'message' && p.role === 'assistant') ||
        ['reasoning', 'function_call', 'custom_tool_call'].includes(p.type)
      )
        this.output(timestamp);
    }
    if (r.type === 'token_usage_record') {
      const usage = tokens(p.usage);
      if (!nonzero(usage)) return [];
      const total = tokens(p.thread_token_usage);
      s.covered = { usage, total };
      if (total) s.total = total;
      if (p.turn_id) s.turnId = String(p.turn_id);
      if (p.model) s.model = String(p.model);
      const timing = this.timing(timestamp);
      if (!timestamp || timestamp < s.cutoff || (p.thread_id && p.thread_id !== s.sessionId))
        return [];
      const key = p.response_id
        ? 'response:' + p.response_id
        : `record:${r.ordinal ?? timestamp}:${hash(JSON.stringify(usage))}`;
      return [
        {
          ...usage,
          ...timing,
          id: s.sessionId + ':' + key,
          sessionId: s.sessionId,
          turnId: s.turnId,
          model: s.model,
          timestamp,
        },
      ];
    }
    if (r.type !== 'event_msg' || p.type !== 'token_count' || !p.info) return [];
    const info = p.info,
      total = tokens(info.total_token_usage),
      last = tokens(info.last_token_usage);
    if (info.model || info.model_name || p.model)
      s.model = String(info.model || info.model_name || p.model);
    const signature = total ? JSON.stringify([total, last]) : undefined;
    const duplicate = signature && s.signatures.includes(signature);
    if (signature && !duplicate) s.signatures = [...s.signatures.slice(-127), signature];
    const covered = s.covered;
    s.covered = undefined;
    if (
      covered &&
      (same(last, covered.usage) || same(total, covered.total) || (last && !nonzero(last)))
    ) {
      if (total) s.total = total;
      this.boundary(timestamp);
      return [];
    }
    if (duplicate) return [];
    let usage = last;
    if (!usage && total) {
      if (!s.total && s.inherited) {
        s.total = total;
        s.uncertain++;
        return [];
      }
      // A counter reset starts a new baseline; exact per-request values take priority.
      const previous =
        s.total && total.input >= s.total.input && total.output >= s.total.output
          ? s.total
          : undefined;
      usage = Object.fromEntries(
        Object.keys(total).map((k) => [
          k,
          Math.max(0, total[k as keyof Tokens] - (previous?.[k as keyof Tokens] ?? 0)),
        ]),
      ) as unknown as Tokens;
      usage.cached = Math.min(usage.input, usage.cached);
      usage.cacheWrite = Math.min(usage.input - usage.cached, usage.cacheWrite);
      usage.reasoning = Math.min(usage.output, usage.reasoning);
    }
    if (total) s.total = total;
    if (!nonzero(usage)) return [];
    const timing = this.timing(timestamp, true);
    if (!timestamp || timestamp < s.cutoff) return [];
    const key = total
      ? hash(JSON.stringify([total, last]))
      : `${r.ordinal ?? timestamp}:${hash(JSON.stringify(usage))}`;
    return [
      {
        ...usage,
        ...timing,
        id: `${s.sessionId}:count:${key}`,
        sessionId: s.sessionId,
        turnId: s.turnId,
        model: s.model,
        timestamp,
      },
    ];
  }
}
