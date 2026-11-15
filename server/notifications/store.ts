import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NotificationDelivery, NotificationSettings } from '../../src/types.js';

export type NotificationConfig = {
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
      UPDATE notification_deliveries SET status='failed', error='上次投递中断，结果未确认，请核对群消息' WHERE status='sending';
    `);
    const columns = db.prepare('PRAGMA table_info(notification_settings)').all();
    if (!columns.some((column) => column.name === 'input_since')) {
      db.exec(
        'ALTER TABLE notification_settings ADD COLUMN input_since INTEGER NOT NULL DEFAULT 0',
      );
      db.prepare('UPDATE notification_settings SET input_since=?').run(Date.now());
    }
  }
  config(): NotificationConfig {
    const row = this.db.prepare('SELECT * FROM notification_settings WHERE id=1').get()!;
    return {
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
  save(input: NotificationInput, baseline: string[], enabledAt: number, reset: boolean) {
    const old = this.config();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE notification_settings SET enabled=?,webhook_url=?,signing_secret=?,public_url=?,
        enabled_at=?,scan_at=?,input_since=?,revision=revision+1 WHERE id=1`,
        )
        .run(
          Number(input.enabled),
          input.webhookUrl ?? old.webhookUrl,
          input.signingSecret ?? old.signingSecret,
          input.publicUrl,
          reset ? enabledAt : old.enabledAt,
          reset ? enabledAt : old.scanAt,
          reset ? Date.now() : old.inputSince,
        );
      // Changing credentials or disabling must never send an old queued message to a new recipient.
      if (reset || !input.enabled)
        this.db
          .prepare(
            "UPDATE notification_deliveries SET status='cancelled',error='通知已关闭或接收配置已变更' WHERE status='pending'",
          )
          .run();
      else
        this.db
          .prepare("UPDATE notification_deliveries SET revision=? WHERE status='pending'")
          .run(old.revision + 1);
      const ignore = this.db.prepare(`INSERT OR IGNORE INTO notification_deliveries
        (id,event_key,kind,title,message,status,created_at,revision) VALUES(?,?,'session.completed','','','ignored',?,?)`);
      for (const key of baseline) ignore.run(randomUUID(), key, Date.now(), old.revision + 1);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  checkpoint(at: number, revision: number) {
    this.db
      .prepare('UPDATE notification_settings SET scan_at=? WHERE id=1 AND revision=?')
      .run(at, revision);
  }
  has(key: string) {
    return !!this.db.prepare('SELECT 1 FROM notification_deliveries WHERE event_key=?').get(key);
  }
  enqueue(
    input: {
      key?: string;
      kind: NotificationDelivery['kind'];
      sessionId?: string;
      title: string;
      message: string;
    },
    revision: number,
  ) {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_deliveries
      (id,event_key,kind,session_id,title,message,status,created_at,revision) VALUES(?,?,?,?,?,?,'pending',?,?)`,
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
      );
    return result.changes ? id : undefined;
  }
  private select = `SELECT id,kind,session_id AS sessionId,title,status,attempts,error,
    created_at AS createdAt,sent_at AS sentAt,message,revision FROM notification_deliveries`;
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
  cancelAnsweredInputs(pendingKeys: Set<string>) {
    const rows = this.db
      .prepare(
        "SELECT id,event_key FROM notification_deliveries WHERE kind='session.input_required' AND status='pending'",
      )
      .all();
    const cancel = this.db.prepare(
      "UPDATE notification_deliveries SET status='cancelled',error='问题已回答或不再需要处理' WHERE id=?",
    );
    for (const row of rows) if (!pendingKeys.has(String(row.event_key))) cancel.run(row.id!);
  }
  history(): NotificationDelivery[] {
    return this.db
      .prepare(
        `SELECT id,kind,session_id AS sessionId,title,status,attempts,error,
      created_at AS createdAt,sent_at AS sentAt FROM notification_deliveries WHERE status<>'ignored' ORDER BY created_at DESC,rowid DESC LIMIT 20`,
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
