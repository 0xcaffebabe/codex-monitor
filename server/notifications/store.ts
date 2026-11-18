import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NotificationDelivery, NotificationSettings } from '../../src/types.js';

export type NotificationConfig = {
  completionMode: NotificationSettings['completionMode'];
  enabled: boolean;
  webhookUrl: string;
  signingSecret: string;
  publicUrl: string;
  enabledAt: number;
  scanAt: number;
  inputSince: number;
  revision: number;
};
export type NotificationInput = {
  completionMode?: NotificationSettings['completionMode'];
  enabled: boolean;
  webhookUrl?: string;
  signingSecret?: string;
  publicUrl: string;
};
export type PendingDelivery = NotificationDelivery & { message: string; revision: number };

export class NotificationStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
        webhook_url TEXT NOT NULL DEFAULT '', signing_secret TEXT NOT NULL DEFAULT '',
        public_url TEXT NOT NULL DEFAULT '', enabled_at INTEGER NOT NULL DEFAULT 0,
        scan_at INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO notification_settings(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY, event_key TEXT UNIQUE, kind TEXT NOT NULL,
        session_id TEXT, title TEXT NOT NULL, message TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        sent_at INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notification_queue ON notification_deliveries(status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS notification_watches (
        workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, since INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,session_id)
      );
      UPDATE notification_deliveries SET status='failed', error='上次投递中断，结果未确认，请核对群消息' WHERE status='sending';
    `);
    const columns = db.prepare('PRAGMA table_info(notification_settings)').all();
    if (!columns.some((column) => column.name === 'completion_mode')) {
      db.exec(`ALTER TABLE notification_settings ADD COLUMN completion_mode TEXT NOT NULL DEFAULT 'watched';
        UPDATE notification_settings SET completion_mode='all' WHERE enabled_at>0;`);
    }
    if (!columns.some((column) => column.name === 'input_since')) {
      db.exec(
        'ALTER TABLE notification_settings ADD COLUMN input_since INTEGER NOT NULL DEFAULT 0',
      );
      db.prepare('UPDATE notification_settings SET input_since=?').run(Date.now());
    }
    const deliveryColumns = db.prepare('PRAGMA table_info(notification_deliveries)').all();
    if (!deliveryColumns.some((column) => column.name === 'workspace_id')) {
      db.exec(`ALTER TABLE notification_deliveries ADD COLUMN workspace_id TEXT;
        UPDATE notification_deliveries SET workspace_id='local',event_key='local:' || event_key
        WHERE event_key IS NOT NULL;`);
    }
    if (!deliveryColumns.some((column) => column.name === 'workspace_name')) {
      db.exec(`ALTER TABLE notification_deliveries ADD COLUMN workspace_name TEXT;
        UPDATE notification_deliveries SET workspace_name='本机工作空间' WHERE workspace_id='local';`);
    }
  }
  config(): NotificationConfig {
    const row = this.db.prepare('SELECT * FROM notification_settings WHERE id=1').get()!;
    return {
      completionMode: row.completion_mode === 'all' ? 'all' : 'watched',
      enabled: !!row.enabled,
      webhookUrl: String(row.webhook_url),
      signingSecret: String(row.signing_secret),
      publicUrl: String(row.public_url),
      enabledAt: Number(row.enabled_at),
      scanAt: Number(row.scan_at),
      inputSince: Number(row.input_since),
      revision: Number(row.revision),
    };
  }
  publicConfig(monitorError = ''): NotificationSettings {
    const config = this.config();
    return {
      completionMode: config.completionMode,
      enabled: config.enabled,
      provider: 'lark',
      webhookConfigured: !!config.webhookUrl,
      webhookHint: config.webhookUrl
        ? `${new URL(config.webhookUrl).origin}/…/${config.webhookUrl.slice(-4)}`
        : '',
      signingSecretConfigured: !!config.signingSecret,
      publicUrl: config.publicUrl,
      monitorError,
    };
  }
  save(input: NotificationInput, enabledAt: number, reset: boolean) {
    const old = this.config();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE notification_settings SET enabled=?,webhook_url=?,signing_secret=?,public_url=?,
        enabled_at=?,scan_at=?,input_since=?,completion_mode=?,revision=revision+1 WHERE id=1`,
        )
        .run(
          Number(input.enabled),
          input.webhookUrl ?? old.webhookUrl,
          input.signingSecret ?? old.signingSecret,
          input.publicUrl,
          reset ? enabledAt : old.enabledAt,
          reset ? enabledAt : old.scanAt,
          reset ? Math.max(Date.now(), old.inputSince + 1) : old.inputSince,
          input.completionMode ?? old.completionMode,
        );
      // Changing credentials or disabling must never send an old queued message to a new recipient.
      if (reset || !input.enabled)
        this.db
          .prepare(
            "UPDATE notification_deliveries SET status='cancelled',error='通知已关闭或接收配置已变更' WHERE status='pending'",
          )
          .run();
      else {
        if (
          (input.completionMode ?? old.completionMode) === 'watched' &&
          old.completionMode === 'all'
        )
          this.db
            .exec(`UPDATE notification_deliveries AS delivery SET status='cancelled',error='已改为仅提醒关注会话'
            WHERE status='pending' AND kind='session.completed' AND NOT EXISTS (
              SELECT 1 FROM notification_watches AS watch WHERE watch.workspace_id=delivery.workspace_id AND watch.session_id=delivery.session_id
            );`);
        this.db
          .prepare("UPDATE notification_deliveries SET revision=? WHERE status='pending'")
          .run(old.revision + 1);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  watches() {
    return this.db
      .prepare(
        'SELECT workspace_id AS workspaceId,session_id AS sessionId FROM notification_watches',
      )
      .all() as { workspaceId: string; sessionId: string }[];
  }
  watched(workspaceId: string, sessionId: string, at: number) {
    return !!this.db
      .prepare(
        'SELECT 1 FROM notification_watches WHERE workspace_id=? AND session_id=? AND since<=?',
      )
      .get(workspaceId, sessionId, at);
  }
  watch(workspaceId: string, sessionId: string, watched: boolean) {
    if (watched) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_watches SELECT ?,?,?
        WHERE (SELECT COUNT(*) FROM notification_watches)<500`,
        )
        .run(workspaceId, sessionId, Date.now());
    } else {
      this.db
        .prepare('DELETE FROM notification_watches WHERE workspace_id=? AND session_id=?')
        .run(workspaceId, sessionId);
      if (this.config().completionMode === 'watched')
        this.db
          .prepare(
            `UPDATE notification_deliveries SET status='cancelled',error='已取消关注'
        WHERE workspace_id=? AND session_id=? AND kind='session.completed' AND status='pending'`,
          )
          .run(workspaceId, sessionId);
    }
    return !watched || this.watched(workspaceId, sessionId, Date.now());
  }
  has(key: string) {
    return !!this.db.prepare('SELECT 1 FROM notification_deliveries WHERE event_key=?').get(key);
  }
  enqueue(
    input: {
      key?: string;
      kind: NotificationDelivery['kind'];
      sessionId?: string;
      workspaceId?: string;
      workspaceName?: string;
      title: string;
      message: string;
    },
    revision: number,
  ) {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_deliveries
      (id,event_key,kind,session_id,title,message,status,created_at,revision,workspace_id,workspace_name) VALUES(?,?,?,?,?,?,'pending',?,?,?,?)`,
      )
      .run(
        id,
        input.key ?? null,
        input.kind,
        input.sessionId ?? null,
        input.title,
        input.message,
        Date.now(),
        revision,
        input.workspaceId ?? null,
        input.workspaceName ?? null,
      );
    return result.changes ? id : undefined;
  }
  private select = `SELECT id,kind,session_id AS sessionId,title,status,attempts,error,
    created_at AS createdAt,sent_at AS sentAt,message,revision,workspace_id AS workspaceId,workspace_name AS workspaceName FROM notification_deliveries`;
  delivery(id: string) {
    return this.db.prepare(`${this.select} WHERE id=?`).get(id) as PendingDelivery | undefined;
  }
  pending() {
    return this.db
      .prepare(
        `${this.select} WHERE status='pending' AND next_attempt_at<=? ORDER BY CASE WHEN kind='session.input_required' THEN 0 ELSE 1 END,created_at LIMIT 1`,
      )
      .get(Date.now()) as PendingDelivery | undefined;
  }
  cancelInput(key: string) {
    this.db
      .prepare(
        `UPDATE notification_deliveries SET status='cancelled',error='问题已回答或不再需要处理'
      WHERE event_key=? AND kind='session.input_required' AND status='pending'`,
      )
      .run(key);
  }
  cancelWorkspace(workspaceId: string) {
    this.db.prepare('DELETE FROM notification_watches WHERE workspace_id=?').run(workspaceId);
    this.db
      .prepare(
        `UPDATE notification_deliveries SET status='cancelled',error='工作空间已移除'
      WHERE workspace_id=? AND status='pending'`,
      )
      .run(workspaceId);
  }
  history(): NotificationDelivery[] {
    return this.db
      .prepare(
        `SELECT id,kind,session_id AS sessionId,title,status,attempts,error,
      created_at AS createdAt,sent_at AS sentAt,workspace_id AS workspaceId,workspace_name AS workspaceName FROM notification_deliveries WHERE status<>'ignored' ORDER BY created_at DESC,rowid DESC LIMIT 20`,
      )
      .all() as unknown as NotificationDelivery[];
  }
  start(id: string) {
    return !!this.db
      .prepare(
        "UPDATE notification_deliveries SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'",
      )
      .run(id).changes;
  }
  sent(id: string) {
    this.db
      .prepare("UPDATE notification_deliveries SET status='sent',sent_at=?,error='' WHERE id=?")
      .run(Date.now(), id);
  }
  failed(id: string, error: string, retryAt?: number) {
    this.db
      .prepare('UPDATE notification_deliveries SET status=?,error=?,next_attempt_at=? WHERE id=?')
      .run(retryAt ? 'pending' : 'failed', error, retryAt ?? 0, id);
  }
}
