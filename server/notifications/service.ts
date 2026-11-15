import type { DatabaseSync } from 'node:sqlite';
import { LarkDeliveryError, sendLark, type WebhookTransport } from './lark.js';
import { NotificationStore, type NotificationInput, type PendingDelivery } from './store.js';
import { notificationKey, type NotificationPolicy, type NotificationReport } from './events.js';
import { notificationMessage } from './messages.js';
import { CompletionNotifications } from './completions.js';

/** Server-owned configuration and durable delivery queue, independent of clients and browsers. */
export class NotificationService {
  readonly store: NotificationStore;
  readonly completions: CompletionNotifications;
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private busy?: Promise<void>;
  private testTask?: Promise<PendingDelivery>;
  private lastTestAt = 0;
  private abort = new AbortController();
  private monitorErrors = new Map<string, string>();
  onConfigure?: (policy: NotificationPolicy, reset: boolean) => Promise<void>;
  constructor(
    private db: DatabaseSync,
    pollMs: number,
    private transport?: WebhookTransport,
  ) {
    this.store = new NotificationStore(db);
    this.completions = new CompletionNotifications(db);
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref();
    void this.poll();
  }
  state() {
    return {
      settings: this.store.publicConfig([...this.monitorErrors.values()].join('；')),
      deliveries: this.store.history(),
    };
  }
  policy(): NotificationPolicy {
    const { enabled, enabledAt, inputSince, revision } = this.store.config();
    return { enabled, enabledAt, inputSince, revision, completionSince: this.completions.since };
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
    if (!(await authorized())) throw new Error('登录或操作权限已失效，请重新登录');
    if (this.store.config().revision !== old.revision)
      throw new Error('通知配置已被其他请求更新，请刷新后重试');
    if (this.closed) throw new Error('服务正在停止');
    this.store.save(input, Math.floor(Date.now() / 1000) * 1000, reset);
    this.monitorErrors.clear();
    await this.onConfigure?.(this.policy(), reset);
    return this.state();
  }
  receive(workspace: { id: string; name: string }, report: NotificationReport) {
    const config = this.store.config();
    if (this.closed || report.revision !== config.revision) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of report.completions ?? []) this.completions.receive(workspace, event);
      for (const event of report.events) {
        if (event.kind === 'session.completed') this.completions.receive(workspace, event);
        if (!config.enabled) continue;
        const key = `${workspace.id}:${notificationKey(event)}`;
        if (event.kind === 'session.input_resolved') {
          this.store.cancelInput(key);
          continue;
        }
        if (
          event.occurredAt <
          (event.kind === 'session.completed' ? config.enabledAt : config.inputSince)
        )
          continue;
        this.store.enqueue(
          {
            key,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            kind: event.kind,
            sessionId: event.sessionId,
            title: event.title,
            message: notificationMessage(event, workspace, config.publicUrl),
          },
          config.revision,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (report.monitorError)
      this.monitorErrors.set(workspace.id, `${workspace.name}：${report.monitorError}`);
    else this.monitorErrors.delete(workspace.id);
    return true;
  }
  forgetWorkspace(workspaceId: string) {
    this.store.cancelWorkspace(workspaceId);
    this.completions.forgetWorkspace(workspaceId);
    this.monitorErrors.delete(workspaceId);
  }
  poll() {
    if (this.closed) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.tick()
      .catch(() => {
        /* Persisted work is retried on the next tick. */
      })
      .finally(() => {
        this.busy = undefined;
      });
    return this.busy;
  }
  private async tick() {
    if (!this.store.config().enabled) return;
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
