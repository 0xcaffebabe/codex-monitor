import type { CompletionNotifications } from './completions.js';

const READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
type TrackedNotice = { deliveryId: string; expiresAt: number; recipients: Map<string, string> };

export class LarkReadTracker {
  private notices = new Map<number, TrackedNotice>();
  private inFlight = new Map<Set<string>, string>();
  private statuses = new Map<string, string>();

  constructor(private completions: Pick<CompletionNotifications, 'pendingId' | 'snapshot' | 'dismiss'>) {}

  status(deliveryId: string) {
    return this.statuses.get(deliveryId);
  }

  async track<T extends { messageId?: string }>(
    deliveryId: string,
    eventKey: string,
    openId: string,
    send: () => Promise<T>,
  ) {
    if (this.completions.pendingId(eventKey) === undefined) return send();
    // A receipt can reach the event connection before the send response reaches this process.
    const early = new Set<string>();
    this.inFlight.set(early, openId);
    try {
      const result = await send();
      const id = this.inFlight.has(early) ? this.completions.pendingId(eventKey) : undefined;
      if (id === undefined) return result;
      const { generation } = this.prune();
      const { messageId } = result;
      if (!messageId) {
        if (!this.notices.has(id)) this.setStatus(deliveryId, 'Lark 未返回卡片消息 ID');
        return result;
      }
      if (early.has(messageId)) {
        this.dismiss(generation, id, deliveryId);
      } else {
        const notice = this.notices.get(id) ?? {
          deliveryId, expiresAt: Date.now() + READ_WINDOW_MS, recipients: new Map(),
        };
        notice.recipients.set(messageId, openId);
        this.notices.set(id, notice);
        this.setStatus(deliveryId, '等待 Lark 已读事件');
      }
      return result;
    } finally {
      this.inFlight.delete(early);
    }
  }

  read(openId: string, messageIds: string[]) {
    const { generation } = this.prune();
    const dismissed: number[] = [];
    for (const [id, notice] of this.notices) {
      if (!messageIds.some((messageId) => notice.recipients.get(messageId) === openId)) continue;
      this.recordRead(id, notice.deliveryId);
      dismissed.push(id);
    }
    if (dismissed.length) this.completions.dismiss(generation, dismissed);
    for (const [early, recipient] of this.inFlight) {
      if (recipient !== openId) continue;
      for (const id of messageIds) {
        early.add(id);
        if (early.size > 256) early.delete(early.values().next().value!);
      }
    }
  }

  reset() {
    for (const { deliveryId } of this.notices.values())
      this.setStatus(deliveryId, '已停止等待 Lark 已读事件');
    this.notices.clear();
    this.inFlight.clear();
  }

  private prune() {
    const snapshot = this.completions.snapshot();
    const pending = new Set(snapshot.notifications.map(({ id }) => id));
    const now = Date.now();
    for (const [id, notice] of this.notices) {
      if (pending.has(id) && notice.expiresAt > now) continue;
      this.notices.delete(id);
      this.setStatus(notice.deliveryId, pending.has(id) ? 'Lark 已读事件等待超时' : '网页通知已关闭');
    }
    return snapshot;
  }

  private dismiss(generation: string, id: number, deliveryId: string) {
    this.recordRead(id, deliveryId);
    this.completions.dismiss(generation, [id]);
  }

  private recordRead(id: number, deliveryId: string) {
    this.notices.delete(id);
    this.setStatus(deliveryId, 'Lark 已读，网页通知已关闭');
  }

  private setStatus(deliveryId: string, status: string) {
    this.statuses.delete(deliveryId);
    this.statuses.set(deliveryId, status);
    if (this.statuses.size > 100) this.statuses.delete(this.statuses.keys().next().value!);
  }
}
