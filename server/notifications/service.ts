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
import { LarkApp, LarkReplyAttachmentsTooLarge, LarkReplyDocumentError } from './lark-app.js';
import {
  larkRepliesEnabled,
  larkReply,
  larkReplyHistory,
  larkReplyReaction,
  larkRequestId,
  listenForLarkReplies,
  LARK_REPLY_MAX_ATTACHMENTS,
  replyReceipts,
  type LarkReplyListener,
  type LarkReplyReceipt,
  type LarkReplySubmission,
} from './lark-replies.js';
import {
  NOTIFICATION_ATTACHMENT_LIMIT,
  type NotificationAttachmentRef,
  type NotificationAttachmentResult,
} from './attachments.js';

const LARK_READ_POLL_MS = 10_000;
const LARK_READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  private replyAuthorization = new AbortController();
  private app: LarkApp;
  private larkReadTimer?: ReturnType<typeof setInterval>;
  private larkReadScan?: Promise<void>;
  private larkReadCards = new Map<number, { deliveryId: string; messageId: string; expiresAt: number }>();
  private larkReadStatus = new Map<string, string>();
  private replyConnection?: ReturnType<LarkReplyListener>;
  private replyDestination?: string;
  private replies = new Map<string, { accepted: Promise<string | undefined>; feedback: Promise<void> }>();
  private replyDownloads = 0;
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
    private listenForReplies: LarkReplyListener = listenForLarkReplies,
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
      settings: {
        ...this.store.publicConfig([...this.monitorErrors.values()].join('；')),
        replyConnection: this.replyConnection?.getConnectionStatus().state,
      },
      deliveries: this.store.history().map((delivery) => ({
        ...delivery,
        larkReadStatus: this.larkReadStatus.get(delivery.id),
      })),
    };
  }
  policy(): NotificationPolicy {
    const { enabled, enabledAt, inputSince, revision } = this.store.config();
    return { enabled, enabledAt, inputSince, revision, completionSince: this.completions.since };
  }
  async configure(
    input: NotificationInput,
    authorized: () => boolean | Promise<boolean> = () => true,
    adminId?: string,
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
    this.store.save(
      input,
      Math.floor(Date.now() / 1000) * 1000,
      reset,
      changed,
      input.replyOpenIds?.length ? adminId : undefined,
    );
    if (input.replyOpenIds && (
      (adminId && input.replyOpenIds.length > 0 && adminId !== old.replyAdminId) ||
      input.replyOpenIds.length !== old.replyOpenIds.length ||
      input.replyOpenIds.some((id) => !old.replyOpenIds.includes(id))
    )) {
      this.replyAuthorization.abort();
      this.replyAuthorization = new AbortController();
    }
    if (changed || (old.enabled && !input.enabled)) {
      this.destination.abort();
      this.destination = new AbortController();
      for (const { deliveryId } of this.larkReadCards.values())
        this.setLarkReadStatus(deliveryId, 'Lark 已读查询已停止，通知接收配置已变更或关闭');
      this.larkReadCards.clear();
      this.stopLarkReadTimer();
    }
    this.monitorErrors.clear();
    this.syncReplyListener();
    await this.onConfigure?.(this.policy(), reset);
    return this.state();
  }
  submitReply?: (input: LarkReplySubmission, signal: AbortSignal) => Promise<LarkReplyReceipt>;
  startReplies(submit: NonNullable<NotificationService['submitReply']>) {
    this.submitReply = submit;
    this.syncReplyListener();
  }
  private syncReplyListener() {
    const config = this.store.config();
    const destination = !this.closed && this.submitReply && larkRepliesEnabled(config)
      ? config.larkDestination
      : undefined;
    if (destination === this.replyDestination) return;
    this.replyConnection?.close({ force: true });
    this.replyDestination = destination;
    this.replyConnection = destination
      ? this.listenForReplies(config, (event) => this.receiveReply(destination, event))
      : undefined;
  }
  private async receiveReply(destination: string, event: unknown) {
    if (this.closed || destination !== this.replyDestination || !this.submitReply)
      return;
    const config = this.store.config();
    const reply = larkReply(config, event);
    if (!reply) return;
    const target = reply.parents.map((id) => this.store.larkTarget(destination, id)).find((item) => item !== undefined);
    if (!target) return;
    const key = `${destination}:${reply.messageId}`;
    const active = this.replies.get(key);
    const background = !!(reply.createdAt || reply.resources.length);
    if (active) {
      if (!background) await active.accepted;
      return;
    }
    if (this.replies.size >= 32) throw new Error('Monitor reply capacity reached');
    const signal = AbortSignal.any([
      this.abort.signal,
      this.destination.signal,
      this.replyAuthorization.signal,
    ]);
    const accepted = (async () => {
      let receipt = this.store.larkReceipt(destination, reply.messageId);
      if (!receipt) {
        const result = await this.dispatchReply(config, target, reply, signal);
        if (signal.aborted) return;
        receipt = replyReceipts[result].text;
        this.store.recordLarkReceipt(destination, reply.messageId, receipt);
      }
      return receipt;
    })();
    const feedback = accepted.then(async (receipt) => {
      if (signal.aborted || !receipt) return;
      const reaction = larkReplyReaction(receipt);
      if (!reaction) return;
      const sender = await this.app.sender(config, signal);
      await sender.react(reply.messageId, reaction);
    }).catch(() => {
      // An unavailable Lark API does not affect the Monitor queue or notification delivery.
    }).finally(() => {
      this.replies.delete(key);
    });
    this.replies.set(key, { accepted, feedback });
    // Image downloads and uploads can outlast the provider's event acknowledgement deadline.
    if (!background) await accepted;
  }
  private async dispatchReply(
    config: NotificationConfig,
    target: Pick<LarkReplySubmission, 'workspaceId' | 'sessionId'>,
    reply: NonNullable<ReturnType<typeof larkReply>>,
    signal: AbortSignal,
  ): Promise<LarkReplyReceipt> {
    const destination = config.larkDestination;
    const needsDownload = !!(reply.createdAt || reply.resources.length);
    if (needsDownload && this.replyDownloads >= 4) return 'busy';
    if (needsDownload) this.replyDownloads++;
    try {
      const sender = needsDownload ? await this.app.sender(config, signal) : undefined;
      let history: Awaited<ReturnType<typeof larkReplyHistory>> = [];
      if (reply.createdAt && sender) {
        try {
          history = await larkReplyHistory(reply, config.chatId, sender.history, (id) =>
            this.replies.has(`${destination}:${id}`) || !!this.store.larkReceipt(destination, id),
          );
        } catch (error) {
          // Applications with only group-mention access can still submit the explicit reply.
          if (!(error instanceof LarkDeliveryError) || error.code !== 230027) return 'historyFailed';
        }
      }
      const messages = [...history, reply];
      if (messages.some((message) => message.invalidResource)) return 'attachmentFailed';
      const prompt = messages.map((message) => message.prompt).filter(Boolean).join('\n\n');
      const seenDocuments = new Set<string>();
      const resources = messages.flatMap((message) => message.resources).filter((resource) => {
        if (!('document' in resource)) return true;
        const key = `${resource.document.type}:${resource.document.token}`;
        if (seenDocuments.has(key)) return false;
        seenDocuments.add(key);
        return true;
      });
      if ((!prompt && !resources.length) || prompt.length > 12000) return 'unsupported';
      if (resources.length > LARK_REPLY_MAX_ATTACHMENTS) return 'attachmentsTooLarge';
      let attachments: LarkReplySubmission['attachments'] = [];
      if (resources.length) {
        try {
          attachments = await sender!.readReplyAttachments(resources);
        } catch (error) {
          if (error instanceof LarkReplyAttachmentsTooLarge) return 'attachmentsTooLarge';
          return error instanceof LarkReplyDocumentError ? 'documentFailed' : 'attachmentFailed';
        }
      }
      if (signal.aborted) return 'failed';
      return await this.submitReply!({
        ...target,
        userId: config.replyAdminId,
        requestId: larkRequestId(destination, reply.messageId),
        prompt,
        attachments,
        nextTurn: !!reply.createdAt,
      }, signal);
    } finally {
      if (needsDownload) this.replyDownloads--;
    }
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
    const messageId = await sender.card(delivery.id, delivery.message);
    if (delivery.kind === 'test') {
      await sender.attachment(`${delivery.id}-test`, {
        name: 'codex-monitor-test.txt',
        mime: 'text/plain',
        data: Buffer.from('Codex Monitor attachment test\n'),
      });
      return;
    }
    const { workspaceId, sessionId, turnId, occurredAt } = delivery;
    if (messageId && workspaceId && sessionId && !signal.aborted)
      this.store.recordLarkMessage(config.larkDestination, messageId, workspaceId, sessionId);
    if (delivery.kind === 'session.completed' && delivery.eventKey && !signal.aborted)
      this.trackLarkRead(delivery.id, delivery.eventKey, messageId);
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
  private setLarkReadStatus(deliveryId: string, status: string) {
    this.larkReadStatus.delete(deliveryId);
    this.larkReadStatus.set(deliveryId, status);
    if (this.larkReadStatus.size > 100)
      this.larkReadStatus.delete(this.larkReadStatus.keys().next().value!);
  }
  private trackLarkRead(deliveryId: string, eventKey: string, messageId: string | undefined) {
    const id = this.completions.pendingId(eventKey);
    if (id === undefined) return;
    if (!messageId) {
      if (!this.larkReadCards.has(id))
        this.setLarkReadStatus(deliveryId, '无法查询已读，Lark 未返回有效的卡片消息 ID');
      return;
    }
    if (this.larkReadCards.get(id)?.messageId === messageId) return;
    this.larkReadCards.set(id, { deliveryId, messageId, expiresAt: Date.now() + LARK_READ_WINDOW_MS });
    this.setLarkReadStatus(deliveryId, 'Lark 已读查询等待首次检查');
    if (!this.larkReadTimer) {
      this.larkReadTimer = setInterval(() => {
        if (this.larkReadScan) return;
        this.larkReadScan = this.scanLarkReads()
          .catch(() => {
            // Retry provider failures on the next scan.
          })
          .finally(() => {
            this.larkReadScan = undefined;
            if (!this.larkReadCards.size) this.stopLarkReadTimer();
          });
      }, LARK_READ_POLL_MS);
      this.larkReadTimer.unref();
    }
  }
  private stopLarkReadTimer() {
    clearInterval(this.larkReadTimer);
    this.larkReadTimer = undefined;
  }
  private async scanLarkReads() {
    const { generation, notifications } = this.completions.snapshot();
    const now = Date.now();
    const pending = new Set(notifications.map(({ id }) => id));
    for (const [id, card] of this.larkReadCards) {
      if (pending.has(id) && card.expiresAt > now) continue;
      this.larkReadCards.delete(id);
      this.setLarkReadStatus(card.deliveryId, pending.has(id)
        ? 'Lark 已读查询已停止，卡片已超过 7 天'
        : 'Lark 已读查询已停止，网页通知已移除');
    }
    const cards = [...this.larkReadCards];
    if (!cards.length) return;

    const signal = AbortSignal.any([this.abort.signal, this.destination.signal]);
    const sender = this.app.sender(this.store.config(), signal);
    await Promise.all(cards.map(async ([id, card]) => {
      try {
        const app = await sender;
        if (signal.aborted) return;
        const isRead = await app.isRead(card.messageId);
        if (signal.aborted || this.larkReadCards.get(id) !== card) return;
        this.setLarkReadStatus(card.deliveryId, isRead ? 'Lark 已读，网页通知已关闭' : 'Lark 暂无已读记录');
        if (isRead) {
          this.completions.dismiss(generation, [id]);
          this.larkReadCards.delete(id);
        }
      } catch (error) {
        if (signal.aborted || this.larkReadCards.get(id) !== card) return;
        const detail = error instanceof LarkDeliveryError ? error.message : '请求失败';
        this.setLarkReadStatus(card.deliveryId, `Lark 已读查询失败：${detail}`);
        if (error instanceof LarkDeliveryError && (error.code === 230033 || error.code === 230110))
          this.larkReadCards.delete(id);
      }
    }));
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
    this.replyConnection?.close({ force: true });
    clearInterval(this.timer);
    this.stopLarkReadTimer();
    this.abort.abort();
    return Promise.allSettled([this.busy, this.testTask, this.larkReadScan, ...[...this.replies.values()].map(({ feedback }) => feedback)]).then(() => {});
  }
}
