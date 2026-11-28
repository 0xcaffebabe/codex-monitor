import type { CompletionNotifications } from './completions.js';
import { LarkDeliveryError } from './lark.js';

const POLL_MS = 10_000;
const READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
type TrackedCard = { deliveryId: string; messageIds: Set<string>; expiresAt: number };
type ReadClient = { isRead(messageId: string): Promise<boolean> };

/** Reconciles Lark card reads with pending browser notices for the current delivery destination. */
export class LarkReadTracker {
  private timer?: ReturnType<typeof setInterval>;
  private scan?: Promise<void>;
  private cards = new Map<number, TrackedCard>();
  private statuses = new Map<string, string>();
  private destination = new AbortController();
  private closed = false;

  constructor(
    private completions: Pick<CompletionNotifications, 'pendingId' | 'snapshot' | 'dismiss'>,
    private reader: (signal: AbortSignal) => Promise<ReadClient>,
  ) {}

  status(deliveryId: string) {
    return this.statuses.get(deliveryId);
  }

  track(deliveryId: string, eventKey: string, messageId: string | undefined) {
    if (this.closed) return;
    const id = this.completions.pendingId(eventKey);
    if (id === undefined) return;
    if (!messageId) {
      if (!this.cards.has(id))
        this.setStatus(deliveryId, '无法查询已读，Lark 未返回有效的卡片消息 ID');
      return;
    }
    const tracked = this.cards.get(id);
    if (tracked) {
      tracked.messageIds.add(messageId);
      return;
    }
    this.cards.set(id, {
      deliveryId,
      messageIds: new Set([messageId]),
      expiresAt: Date.now() + READ_WINDOW_MS,
    });
    this.setStatus(deliveryId, 'Lark 已读查询等待首次检查');
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (this.scan) return;
        this.scan = this.scanReads()
          .catch(() => {
            // Retry provider failures on the next scan.
          })
          .finally(() => {
            this.scan = undefined;
            if (!this.cards.size) this.stopTimer();
          });
      }, POLL_MS);
      this.timer.unref();
    }
  }

  reset(reason: string) {
    if (this.closed) return;
    this.destination.abort();
    this.destination = new AbortController();
    for (const { deliveryId } of this.cards.values()) this.setStatus(deliveryId, reason);
    this.cards.clear();
    this.stopTimer();
  }

  close() {
    this.closed = true;
    this.stopTimer();
    this.destination.abort();
    return Promise.allSettled([this.scan]).then(() => {});
  }

  private setStatus(deliveryId: string, status: string) {
    this.statuses.delete(deliveryId);
    this.statuses.set(deliveryId, status);
    if (this.statuses.size > 100) this.statuses.delete(this.statuses.keys().next().value!);
  }

  private stopTimer() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async scanReads() {
    const { generation, notifications } = this.completions.snapshot();
    const now = Date.now();
    const pending = new Set(notifications.map(({ id }) => id));
    for (const [id, card] of this.cards) {
      if (pending.has(id) && card.expiresAt > now) continue;
      this.cards.delete(id);
      this.setStatus(
        card.deliveryId,
        pending.has(id)
          ? 'Lark 已读查询已停止，卡片已超过 7 天'
          : 'Lark 已读查询已停止，网页通知已移除',
      );
    }
    const cards = [...this.cards];
    if (!cards.length) return;

    const signal = this.destination.signal;
    const reader = this.reader(signal);
    await Promise.all(
      cards.map(async ([id, card]) => {
        let readError = '';
        for (const messageId of [...card.messageIds]) {
          try {
            const client = await reader;
            if (signal.aborted) return;
            if (!(await client.isRead(messageId))) continue;
            if (signal.aborted || this.cards.get(id) !== card) return;
            this.setStatus(card.deliveryId, 'Lark 已读，网页通知已关闭');
            this.completions.dismiss(generation, [id]);
            this.cards.delete(id);
            return;
          } catch (error) {
            readError = error instanceof LarkDeliveryError ? error.message : '请求失败';
            if (
              error instanceof LarkDeliveryError &&
              (error.code === 230033 || error.code === 230110)
            )
              card.messageIds.delete(messageId);
          }
        }
        if (signal.aborted || this.cards.get(id) !== card) return;
        this.setStatus(
          card.deliveryId,
          readError ? `Lark 已读查询失败：${readError}` : 'Lark 暂无已读记录',
        );
        if (!card.messageIds.size) this.cards.delete(id);
      }),
    );
  }
}
