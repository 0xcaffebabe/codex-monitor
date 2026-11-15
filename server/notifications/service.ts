import type { DatabaseSync } from 'node:sqlite';
import type { CodexSource } from '../source.js';
import type { SessionCompletion } from '../source/completions.js';
import type { SessionInputRequest } from '../source/input-requests.js';
import { LarkDeliveryError, sendLark, type WebhookTransport } from './lark.js';
import { NotificationStore, type NotificationInput, type PendingDelivery } from './store.js';

type CompletionSource = Pick<CodexSource, 'completions' | 'completionSummary' | 'inputRequests'>;

function inputMessage(event: SessionInputRequest, publicUrl: string, workspaceId?: string) {
  const lines = [
    '🙋 Codex 需要你选择或回答',
    `会话：${event.session.title.slice(0, 500)}`,
    `项目：${event.session.project.slice(0, 200)}`,
    `会话 ID：${event.session.id}`,
  ];
  event.questions.forEach((question, index) => {
    lines.push('', `${index + 1}. ${question.title}`);
    question.options.forEach((option, i) => lines.push(`  ${i + 1}) ${option}`));
  });
  lines.push('', '请在 Codex 中选择或回复。');
  if (publicUrl) {
    const url = new URL(publicUrl);
    url.searchParams.set('session', event.session.id);
    if (workspaceId) url.searchParams.set('workspace', workspaceId);
    lines.push(`查看会话：${url.href}`);
  }
  return lines.join('\n');
}

function completionMessage(
  event: SessionCompletion,
  summary: string,
  publicUrl: string,
  workspaceId?: string,
) {
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(event.completedAt);
  const lines = [
    '✅ Codex 会话完成',
    `会话：${event.session.title.slice(0, 500)}`,
    `项目：${event.session.project.slice(0, 200)}`,
    `完成时间：${date} (UTC+8)`,
    `会话 ID：${event.session.id}`,
    `轮次 ID：${event.turnId}`,
  ];
  if (summary.trim())
    lines.push('', `回复摘要：\n${summary.slice(0, 1000)}${summary.length > 1000 ? '…' : ''}`);
  if (publicUrl) {
    const url = new URL(publicUrl);
    url.searchParams.set('session', event.session.id);
    if (workspaceId) url.searchParams.set('workspace', workspaceId);
    lines.push('', `查看会话：${url.href}`);
  }
  return lines.join('\n');
}

/** A durable background outbox. Its lifecycle is independent of browser/SSE clients. */
export class NotificationService {
  readonly store: NotificationStore;
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private busy?: Promise<void>;
  private testTask?: Promise<PendingDelivery>;
  private lastTestAt = 0;
  private abort = new AbortController();
  private monitorError = '';
  constructor(
    db: DatabaseSync,
    private source: CompletionSource,
    pollMs: number,
    private transport?: WebhookTransport,
    private workspaceId?: string,
  ) {
    this.store = new NotificationStore(db);
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref();
    void this.poll();
  }
  state() {
    return {
      settings: this.store.publicConfig(this.monitorError),
      deliveries: this.store.history(),
    };
  }
  async configure(
    input: NotificationInput,
    authorized: () => boolean | Promise<boolean> = () => true,
  ) {
    const old = this.store.config();
    const reset =
      input.enabled &&
      (!old.enabled ||
        (input.webhookUrl ?? old.webhookUrl) !== old.webhookUrl ||
        (input.signingSecret ?? old.signingSecret) !== old.signingSecret);
    const enabledAt = Math.floor(Date.now() / 1000) * 1000;
    // Seed existing completions in the same second, since Codex timestamps have second precision.
    const baseline = reset
      ? [
          ...(await this.source.completions(enabledAt)).map((event) => event.key),
          ...(await this.source.inputRequests(enabledAt)).map((event) => event.key),
        ]
      : [];
    if (!(await authorized())) throw new Error('登录或操作权限已失效，请重新登录');
    if (this.store.config().revision !== old.revision)
      throw new Error('通知配置已被其他请求更新，请刷新后重试');
    if (this.closed) throw new Error('服务正在停止');
    this.store.save(input, baseline, enabledAt, reset);
    this.monitorError = '';
    return this.state();
  }
  poll() {
    if (this.closed) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.tick()
      .catch(() => {
        if (!this.closed) this.monitorError = '完成事件暂时不可读，后台正在重试';
      })
      .finally(() => {
        this.busy = undefined;
      });
    return this.busy;
  }
  private async tick() {
    const config = this.store.config();
    if (!config.enabled) return;
    const scannedAt = Date.now();
    const since = Math.max(config.enabledAt, config.scanAt - 5 * 60000);
    try {
      const events = await this.source.completions(since);
      if (this.closed || this.store.config().revision !== config.revision) return;
      const inputs = await this.source.inputRequests(Math.max(config.inputSince, since));
      if (this.closed || this.store.config().revision !== config.revision) return;
      this.store.cancelAnsweredInputs(new Set(inputs.map((input) => input.key)));
      for (const input of inputs) {
        if (this.store.has(input.key)) continue;
        this.store.enqueue(
          {
            key: input.key,
            kind: 'session.input_required',
            sessionId: input.session.id,
            title: input.session.title,
            message: inputMessage(input, config.publicUrl, this.workspaceId),
          },
          config.revision,
        );
      }
      for (const event of events) {
        if (this.store.has(event.key)) continue;
        let summary = '';
        try {
          summary = this.source.completionSummary(event);
        } catch {
          /* A missing or malformed summary must not block the completion notice. */
        }
        this.store.enqueue(
          {
            key: event.key,
            kind: 'session.completed',
            sessionId: event.session.id,
            title: event.session.title,
            message: completionMessage(event, summary, config.publicUrl, this.workspaceId),
          },
          config.revision,
        );
      }
      this.store.checkpoint(scannedAt, config.revision);
      this.monitorError = '';
    } catch {
      if (!this.closed) this.monitorError = '完成事件暂时不可读，后台正在重试';
    }
    if (this.closed || this.store.config().revision !== config.revision) return;
    // A temporary Codex read failure must not stall an already durable delivery.
    const next = this.store.pending();
    if (next) await this.deliver(next);
  }
  private async deliver(delivery: PendingDelivery) {
    if (this.closed) return;
    const config = this.store.config();
    if (delivery.revision !== config.revision || !this.store.start(delivery.id)) return;
    try {
      await sendLark(config, delivery.message, this.abort.signal, this.transport);
      if (!this.closed) this.store.sent(delivery.id);
    } catch (error) {
      if (this.closed) return;
      const retryable = error instanceof LarkDeliveryError && error.retryable;
      const current = this.store.config();
      const retry =
        delivery.kind !== 'test' &&
        retryable &&
        delivery.attempts < 2 &&
        current.enabled &&
        current.revision === config.revision;
      this.store.failed(
        delivery.id,
        (error as Error).message,
        retry ? Date.now() + (delivery.attempts ? 30000 : 5000) : undefined,
      );
    }
  }
  test() {
    if (this.testTask || Date.now() - this.lastTestAt < 5000) return undefined;
    const config = this.store.config();
    if (!config.webhookUrl) throw new Error('请先保存 Webhook 配置');
    this.lastTestAt = Date.now();
    const id = this.store.enqueue(
      {
        kind: 'test',
        title: 'Webhook 测试通知',
        message: '✅ Codex Monitor 测试通知\n飞书/Lark Webhook 连接测试成功。',
      },
      config.revision,
    )!;
    this.testTask = (async () => {
      await this.deliver(this.store.delivery(id)!);
      return this.store.delivery(id)!;
    })().finally(() => {
      this.testTask = undefined;
    });
    return this.testTask;
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.abort.abort();
    return Promise.allSettled([this.busy, this.testTask]).then(() => {});
  }
}
