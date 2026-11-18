import type { DatabaseSync } from 'node:sqlite';
import type { CodexSource } from '../source.js';
import type { SessionCompletion } from '../source/completions.js';
import type { SessionInputRequest } from '../source/input-requests.js';
import {
  notificationKey,
  type CompletionEvent,
  type NotificationEvent,
  type NotificationPolicy,
  type NotificationReport,
} from './events.js';
import { NotificationReportStore } from './report-store.js';
import { CompletionOutbox } from './completions.js';

type EventSource = Pick<CodexSource, 'completions' | 'completionSummary' | 'inputRequests'>;

/** Collects Codex events without access to a webhook, signing secret or provider adapter. */
export class NotificationReporter {
  readonly store: NotificationReportStore;
  readonly completions: CompletionOutbox;
  private policy?: NotificationPolicy;
  private timer: ReturnType<typeof setInterval>;
  private busy?: Promise<void>;
  private applying = false;
  private configuration = Promise.resolve();
  private closed = false;
  constructor(
    db: DatabaseSync,
    private source: EventSource,
    pollMs: number,
    private upload: (report: NotificationReport) => Promise<boolean>,
  ) {
    this.store = new NotificationReportStore(db);
    this.completions = new CompletionOutbox(db);
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref();
  }
  private completion(event: SessionCompletion): CompletionEvent {
    let summary = '';
    try {
      summary = this.source.completionSummary(event).slice(0, 1000);
    } catch {
      /* Optional. */
    }
    return {
      kind: 'session.completed',
      sessionId: event.session.id,
      title: event.session.title.slice(0, 500),
      project: event.session.project.slice(0, 200),
      turnId: event.turnId,
      occurredAt: event.completedAt,
      summary,
    };
  }
  private input(
    event: SessionInputRequest,
  ): Extract<NotificationEvent, { kind: 'session.input_required' }> {
    return {
      kind: 'session.input_required',
      sessionId: event.session.id,
      title: event.session.title.slice(0, 500),
      project: event.session.project.slice(0, 200),
      requestId: event.requestId,
      occurredAt: event.createdAt,
      questions: event.questions.map(({ title, options }) => ({ title, options })),
    };
  }
  configure(policy: NotificationPolicy, baseline = false) {
    const task = this.configuration.then(() => this.applyPolicy(policy, baseline));
    this.configuration = task.catch(() => {});
    return task;
  }
  private async applyPolicy(policy: NotificationPolicy, baseline: boolean) {
    if (this.closed) return;
    if (
      this.policy?.revision === policy.revision &&
      (!policy.enabled || this.store.state()?.generation === policy.inputSince) &&
      (policy.completionSince === undefined ||
        this.completions.state()?.generation === policy.completionSince)
    )
      return;
    this.applying = true;
    this.policy = policy;
    try {
      await this.busy;
      if (this.closed) return;
      if (
        policy.completionSince !== undefined &&
        this.completions.state()?.generation !== policy.completionSince
      ) {
        const at = Date.now();
        const completions = await this.source.completions(
          Math.max(policy.completionSince, at - 5 * 60000),
        );
        if (this.closed || this.policy !== policy) return;
        this.store.transaction(() =>
          this.completions.reset(
            policy.completionSince!,
            at,
            completions.map((event) => this.completion(event)),
          ),
        );
      }
      if (!policy.enabled) return;
      if (baseline || this.store.state()?.generation !== policy.inputSince) {
        const at = Date.now();
        const since = Math.max(policy.enabledAt, at - 5 * 60000);
        const completions = await this.source.completions(since);
        const inputs = await this.source.inputRequests(Math.max(policy.inputSince, since));
        if (this.closed || this.policy !== policy) return;
        this.store.reset(policy.inputSince, at, [
          ...completions.map((event) => this.completion(event)),
          ...inputs.map((event) => this.input(event)),
        ]);
      }
    } finally {
      this.applying = false;
    }
  }
  poll() {
    if (
      this.closed ||
      this.applying ||
      !this.policy ||
      (!this.policy.enabled && this.policy.completionSince === undefined)
    )
      return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.tick()
      .catch(() => {
        /* Retry unacknowledged reports on the next tick. */
      })
      .finally(() => {
        this.busy = undefined;
      });
    return this.busy;
  }
  private async tick() {
    const policy = this.policy!;
    const state = this.store.state();
    const browser = this.completions.state();
    const webhookSince =
      policy.enabled && state?.generation === policy.inputSince
        ? Math.max(policy.enabledAt, state.scanAt - 5 * 60000)
        : Infinity;
    const browserSince =
      policy.completionSince !== undefined && browser?.generation === policy.completionSince
        ? Math.max(policy.completionSince, browser.scanAt - 5 * 60000)
        : Infinity;
    if (!Number.isFinite(Math.min(webhookSince, browserSince))) return;
    const scannedAt = Date.now();
    let monitorError: NotificationReport['monitorError'] = '';
    try {
      const completions = (await this.source.completions(Math.min(webhookSince, browserSince))).map(
        (event) => this.completion(event),
      );
      if (this.closed || this.policy !== policy) return;
      if (Number.isFinite(browserSince))
        this.store.transaction(() => {
          for (const event of completions)
            if (event.occurredAt >= browserSince) this.completions.enqueue(event);
          this.completions.checkpoint(scannedAt);
        });
      if (Number.isFinite(webhookSince)) {
        const active = this.store.activeInputs();
        // Keep old, unanswered questions in the read window until they are actually resolved.
        const inputSince = Math.max(
          policy.inputSince,
          active.reduce((at, input) => Math.min(at, input.createdAt), webhookSince),
        );
        const inputs = (await this.source.inputRequests(inputSince)).map((event) =>
          this.input(event),
        );
        if (this.closed || this.policy !== policy) return;
        const keys = new Set(inputs.map(notificationKey));
        this.store.transaction(() => {
          for (const previous of active)
            if (!keys.has(previous.key))
              this.store.resolveInput({
                kind: 'session.input_resolved',
                sessionId: previous.sessionId,
                requestId: previous.requestId,
              });
          for (const input of inputs) {
            this.store.enqueue(input);
            this.store.trackInput(input);
          }
          for (const event of completions)
            if (event.occurredAt >= webhookSince) this.store.enqueue(event);
          this.store.checkpoint(scannedAt);
        });
      }
    } catch {
      monitorError = '完成事件暂时不可读，后台正在重试';
    }
    if (this.closed || this.policy !== policy) return;
    const browserPending = this.completions.pending();
    const pending = policy.enabled
      ? this.store.pending().slice(0, browserPending.length ? 2 : 4)
      : [];
    browserPending.splice(4 - pending.length);
    // Bound UTF-8 bytes as well as item counts, including JSON escapes in source text.
    while (
      pending.length + browserPending.length > 1 &&
      Buffer.byteLength(JSON.stringify([...pending, ...browserPending].map((row) => row.event))) >
        48 * 1024
    ) {
      if (browserPending.length) browserPending.pop();
      else pending.pop();
    }
    const accepted = await this.upload({
      revision: policy.revision,
      events: pending.map((row) => row.event),
      ...(policy.completionSince === undefined
        ? {}
        : { completions: browserPending.map((row) => row.event) }),
      monitorError,
    });
    if (accepted && !this.closed && this.policy === policy) {
      this.store.acknowledge(pending.map((row) => row.seq));
      this.completions.acknowledge(browserPending.map((row) => row.seq));
    }
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    return Promise.allSettled([this.busy, this.configuration]).then(() => {});
  }
}
