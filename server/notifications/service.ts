import type { DatabaseSync } from 'node:sqlite';
import type { CompletionNotification } from '../../src/types.js';
import { LarkDeliveryError, sendLark, type WebhookTransport } from './lark.js';
import {
  NotificationStore,
  notificationConfigured,
  type NotificationConfig,
  type NotificationInput,
  type PendingDelivery,
} from './store.js';
import { notificationKey, type NotificationPolicy, type NotificationReport } from './events.js';
import { notificationMessage } from './messages.js';
import { CompletionNotifications } from './completions.js';
import { LarkApp } from './lark-app.js';
import {
  NOTIFICATION_ATTACHMENT_LIMIT,
  type NotificationAttachmentRef,
  type NotificationAttachmentResult,
} from './attachments.js';

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
  private destination = new AbortController();
  private app: LarkApp;
  private monitorErrors = new Map<string, string>();
  onConfigure?: (policy: NotificationPolicy, reset: boolean) => Promise<void>;
  readAttachment?: (
    workspaceId: string,
    ref: NotificationAttachmentRef,
    signal: AbortSignal,
  ) => Promise<NotificationAttachmentResult>;
  constructor(
    private db: DatabaseSync,
    pollMs: number,
    private transport?: WebhookTransport,
  ) {
    this.store = new NotificationStore(db);
    this.app = new LarkApp(transport);
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
    const next = { ...old, ...input };
    const changed =
      next.mode !== old.mode ||
      (next.mode === 'app'
        ? next.appRegion !== old.appRegion ||
          next.appId !== old.appId ||
          next.appSecret !== old.appSecret ||
          next.chatId !== old.chatId
        : next.webhookUrl !== old.webhookUrl || next.signingSecret !== old.signingSecret);
    const reset = input.enabled && (!old.enabled || changed);
    if (!(await authorized())) throw new Error('登录或操作权限已失效，请重新登录');
    if (this.store.config().revision !== old.revision)
      throw new Error('通知配置已被其他请求更新，请刷新后重试');
    if (this.closed) throw new Error('服务正在停止');
    this.store.save(input, Math.floor(Date.now() / 1000) * 1000, reset);
    if (changed || (old.enabled && !input.enabled)) {
      this.destination.abort();
      this.destination = new AbortController();
    }
    this.monitorErrors.clear();
    await this.onConfigure?.(this.policy(), reset);
    return this.state();
  }
  receive(workspace: { id: string; name: string }, report: NotificationReport) {
    const config = this.store.config();
    if (this.closed || report.revision !== config.revision) return false;
    const pending: CompletionNotification[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of [
        ...(report.completions ?? []),
        ...report.events.filter((event) => event.kind === 'session.completed'),
      ]) {
        const notification = this.completions.record(workspace, event);
        if (notification) pending.push(notification);
      }
      for (const event of report.events) {
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
        if (
          event.kind === 'session.completed' &&
          config.completionMode === 'watched' &&
          !this.store.watched(workspace.id, event.sessionId, event.occurredAt)
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
            ...(event.kind === 'session.completed'
              ? { turnId: event.turnId, occurredAt: event.occurredAt }
              : {}),
          },
          config.revision,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.completions.publish(pending);
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
    const signal = AbortSignal.any([this.abort.signal, this.destination.signal]);
    try {
      const warning =
        config.mode === 'app'
          ? await this.deliverApp(config, delivery, signal)
          : await sendLark(config, delivery.message, signal, this.transport);
      if (!this.closed) this.store.sent(delivery.id, warning || '');
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
  private async deliverApp(
    config: NotificationConfig,
    delivery: PendingDelivery,
    signal: AbortSignal,
  ) {
    const sender = await this.app.sender(config, signal);
    await sender.card(delivery.id, delivery.message);
    if (delivery.kind === 'test') {
      await sender.attachment(`${delivery.id}-test`, {
        name: 'codex-monitor-test.txt',
        mime: 'text/plain',
        data: Buffer.from('Codex Monitor attachment test\n'),
      });
      return;
    }
    const { workspaceId, sessionId, turnId, occurredAt } = delivery;
    if (!this.readAttachment || !workspaceId || !sessionId || !turnId || occurredAt === null)
      return;
    const warnings = new Set<string>();
    for (let index = 0; index < NOTIFICATION_ATTACHMENT_LIMIT; index++) {
      signal.throwIfAborted();
      try {
        const file = await this.readAttachment(
          workspaceId,
          { sessionId, turnId, occurredAt, index },
          signal,
        );
        if (file === null) break;
        if (file === 'unavailable') {
          warnings.add('部分附件无法读取、格式不可用或超过大小限制');
          continue;
        }
        await sender.attachment(`${delivery.id}-${index}`, file);
      } catch (error) {
        if (signal.aborted || !(error instanceof LarkDeliveryError)) throw error;
        if (error.retryable && delivery.attempts < 2) throw error;
        warnings.add(error.message);
      }
    }
    return [...warnings].join('；');
  }
  test() {
    if (this.testTask || Date.now() - this.lastTestAt < 5000) return undefined;
    const config = this.store.config();
    if (!notificationConfigured(config)) throw new Error('请先保存所选方式的通知配置');
    this.lastTestAt = Date.now();
    const id = this.store.enqueue(
      {
        kind: 'test',
        title: config.mode === 'app' ? '应用机器人测试通知' : 'Webhook 测试通知',
        message:
          config.mode === 'app'
            ? '✅ **Codex Monitor 测试通知**\n本次测试还会发送一个文本附件。'
            : '✅ **Codex Monitor 测试通知**\n飞书/Lark Webhook 连接测试成功。',
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
