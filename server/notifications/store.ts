import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LarkStartSettings, NotificationDelivery, NotificationSettings } from '../../src/types.js';
import { larkCardMarkdown } from './lark.js';

export type NotificationConfig = {
  completionMode: NotificationSettings['completionMode'];
  enabled: boolean;
  appRegion: NotificationSettings['appRegion'];
  appId: string;
  appSecret: string;
  replyOpenIds: string[];
  replyAdminId: string;
  larkStart: LarkStartSettings;
  larkDestination: string;
  publicUrl: string;
  enabledAt: number;
  scanAt: number;
  inputSince: number;
  revision: number;
};
export type NotificationInput = Partial<
  Pick<NotificationConfig, 'appRegion' | 'appId' | 'appSecret' | 'replyOpenIds' | 'larkStart'>
> & {
  completionMode?: NotificationSettings['completionMode'];
  enabled: boolean;
  publicUrl: string;
};
export type PendingDelivery = NotificationDelivery & {
  eventKey: string | null;
  message: string;
  revision: number;
  turnId: string | null;
  occurredAt: number | null;
  larkSentTo: string;
  larkCard: string | null;
};
export type StoredLarkCard = { markdown: string; embedded: number[] };

export function notificationConfigured(config: NotificationConfig) {
  return !!(config.appId && config.appSecret && config.replyOpenIds.length);
}

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
        revision INTEGER NOT NULL, lark_card TEXT
      );
      CREATE INDEX IF NOT EXISTS notification_queue ON notification_deliveries(status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS notification_watches (
        workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, since INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,session_id)
      );
      CREATE TABLE IF NOT EXISTS notification_lark_messages (
        destination TEXT NOT NULL, message_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
        completion_actions INTEGER NOT NULL DEFAULT 0,
        delivery_id TEXT, chat_id TEXT,
        PRIMARY KEY(destination,message_id)
      );
      CREATE TABLE IF NOT EXISTS notification_lark_replies (
        destination TEXT NOT NULL, message_id TEXT NOT NULL, receipt TEXT NOT NULL,
        PRIMARY KEY(destination,message_id)
      );
      CREATE TABLE IF NOT EXISTS notification_lark_starts (
        destination TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT NOT NULL,
        workspace_id TEXT, session_id TEXT, reply_to TEXT, chat_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        PRIMARY KEY(destination,message_id)
      );
      CREATE INDEX IF NOT EXISTS notification_lark_starts_pending
        ON notification_lark_starts(destination,next_at) WHERE next_at>0;
      UPDATE notification_deliveries SET status='failed', error='上次投递中断，结果未确认，请核对接收方的消息' WHERE status='sending';
    `);
    const columns = db.prepare('PRAGMA table_info(notification_settings)').all();
    for (const [name, value] of [
      ['mode', 'webhook'],
      ['app_region', 'lark'],
      ['app_id', ''],
      ['app_secret', ''],
      ['app_recipient_type', 'group'],
      ['chat_id', ''],
      ['reply_open_ids', '[]'],
      ['reply_admin_id', ''],
      ['lark_start', '{"defaultAlias":"","targets":[]}'],
      ['lark_destination', ''],
    ]) {
      if (!columns.some((column) => column.name === name))
        db.exec(
          `ALTER TABLE notification_settings ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${value}'`,
        );
    }
    db.prepare("UPDATE notification_settings SET lark_destination=? WHERE lark_destination=''").run(randomUUID());
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
    if (!deliveryColumns.some((column) => column.name === 'turn_id'))
      db.exec('ALTER TABLE notification_deliveries ADD COLUMN turn_id TEXT');
    if (!deliveryColumns.some((column) => column.name === 'occurred_at'))
      db.exec('ALTER TABLE notification_deliveries ADD COLUMN occurred_at INTEGER');
    if (!deliveryColumns.some((column) => column.name === 'lark_sent_to'))
      db.exec("ALTER TABLE notification_deliveries ADD COLUMN lark_sent_to TEXT NOT NULL DEFAULT '{}'");
    if (!deliveryColumns.some((column) => column.name === 'lark_card'))
      db.exec('ALTER TABLE notification_deliveries ADD COLUMN lark_card TEXT');
    if (!deliveryColumns.some((column) => column.name === 'workspace_id')) {
      db.exec(`ALTER TABLE notification_deliveries ADD COLUMN workspace_id TEXT;
        UPDATE notification_deliveries SET workspace_id='local',event_key='local:' || event_key
        WHERE event_key IS NOT NULL;`);
    }
    if (!deliveryColumns.some((column) => column.name === 'workspace_name')) {
      db.exec(`ALTER TABLE notification_deliveries ADD COLUMN workspace_name TEXT;
        UPDATE notification_deliveries SET workspace_name='本机工作空间' WHERE workspace_id='local';`);
    }
    const messageColumns = db.prepare('PRAGMA table_info(notification_lark_messages)').all();
    if (!messageColumns.some(({ name }) => name === 'completion_actions'))
      db.exec('ALTER TABLE notification_lark_messages ADD COLUMN completion_actions INTEGER NOT NULL DEFAULT 0');
    if (!messageColumns.some(({ name }) => name === 'delivery_id'))
      db.exec('ALTER TABLE notification_lark_messages ADD COLUMN delivery_id TEXT');
    if (!messageColumns.some(({ name }) => name === 'chat_id'))
      db.exec('ALTER TABLE notification_lark_messages ADD COLUMN chat_id TEXT');
    const startColumns = db.prepare('PRAGMA table_info(notification_lark_starts)').all();
    for (const column of ['reply_to', 'chat_id']) {
      if (!startColumns.some(({ name }) => name === column))
        db.exec(`ALTER TABLE notification_lark_starts ADD COLUMN ${column} TEXT`);
    }
    const replyColumns = db.prepare('PRAGMA table_info(notification_lark_replies)').all();
    for (const column of ['workspace_id', 'user_id', 'reaction_id', 'card_message_id', 'card_update_token', 'card_reply_text']) {
      if (!replyColumns.some(({ name }) => name === column))
        db.exec(`ALTER TABLE notification_lark_replies ADD COLUMN ${column} TEXT`);
    }
    if (!replyColumns.some(({ name }) => name === 'check_at'))
      db.exec('ALTER TABLE notification_lark_replies ADD COLUMN check_at INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE INDEX IF NOT EXISTS notification_lark_reply_checks
      ON notification_lark_replies(destination,check_at) WHERE workspace_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS notification_lark_card_replies
      ON notification_lark_replies(destination,card_message_id) WHERE card_message_id IS NOT NULL`);
    // Keep legacy columns for SQLite compatibility, but invalidate unsupported destinations atomically.
    db.exec('BEGIN IMMEDIATE');
    try {
      const migrated = db.prepare(`UPDATE notification_settings
        SET enabled=0, mode='app', app_recipient_type='private', lark_destination=?, revision=revision+1
        WHERE mode<>'app' OR app_recipient_type<>'private'`).run(randomUUID());
      if (migrated.changes)
        db.exec(`UPDATE notification_deliveries SET status='cancelled',error='旧通知方式已停用，请重新启用私聊推送'
          WHERE status='pending'`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  config(): NotificationConfig {
    const row = this.db.prepare('SELECT * FROM notification_settings WHERE id=1').get()!;
    return {
      completionMode: row.completion_mode === 'all' ? 'all' : 'watched',
      enabled: !!row.enabled,
      appRegion: row.app_region === 'feishu' ? 'feishu' : 'lark',
      appId: String(row.app_id),
      appSecret: String(row.app_secret),
      replyOpenIds: JSON.parse(String(row.reply_open_ids)) as string[],
      replyAdminId: String(row.reply_admin_id),
      larkStart: JSON.parse(String(row.lark_start)) as LarkStartSettings,
      larkDestination: String(row.lark_destination),
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
      appRegion: config.appRegion,
      appId: config.appId,
      appSecretConfigured: !!config.appSecret,
      replyOpenIds: config.replyOpenIds,
      larkStart: config.larkStart,
      publicUrl: config.publicUrl,
      monitorError,
    };
  }
  save(input: NotificationInput, enabledAt: number, reset: boolean, destinationChanged = false, adminId?: string) {
    const old = this.config();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE notification_settings SET enabled=?,public_url=?,
        enabled_at=?,scan_at=?,input_since=?,completion_mode=?,app_region=?,app_id=?,
        app_secret=?,reply_open_ids=?,reply_admin_id=?,lark_destination=?,lark_start=?,
        revision=revision+1 WHERE id=1`,
        )
        .run(
          Number(input.enabled),
          input.publicUrl,
          reset ? enabledAt : old.enabledAt,
          reset ? enabledAt : old.scanAt,
          reset ? Math.max(Date.now(), old.inputSince + 1) : old.inputSince,
          input.completionMode ?? old.completionMode,
          input.appRegion ?? old.appRegion,
          input.appId ?? old.appId,
          input.appSecret ?? old.appSecret,
          JSON.stringify(input.replyOpenIds ?? old.replyOpenIds),
          input.replyOpenIds?.length === 0 ? '' : adminId ?? old.replyAdminId,
          destinationChanged ? randomUUID() : old.larkDestination,
          JSON.stringify(input.larkStart ?? (destinationChanged ? { defaultAlias: '', targets: [] } : old.larkStart)),
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
  recordLarkMessage(destination: string, messageId: string, workspaceId: string, sessionId: string,
    completionActions = false, deliveryId?: string, chatId?: string) {
    this.db.prepare(`INSERT OR IGNORE INTO notification_lark_messages
      (destination,message_id,workspace_id,session_id,completion_actions,delivery_id,chat_id) VALUES(?,?,?,?,?,?,?)`)
      .run(destination, messageId, workspaceId, sessionId, Number(completionActions), deliveryId ?? null, chatId ?? null);
  }
  larkTarget(destination: string, messageId: string, requireCompletionActions = false) {
    return this.db.prepare(`SELECT workspace_id AS workspaceId, session_id AS sessionId, chat_id AS chatId
      FROM notification_lark_messages WHERE destination=? AND message_id=? AND completion_actions>=?`)
      .get(destination, messageId, Number(requireCompletionActions)) as {
        workspaceId: string; sessionId: string; chatId: string | null;
      } | undefined;
  }
  larkCardMarkdown(destination: string, messageId: string) {
    const row = this.db.prepare(`SELECT delivery.message, delivery.lark_card AS larkCard FROM notification_lark_messages AS card
      JOIN notification_deliveries AS delivery ON delivery.id=card.delivery_id
      WHERE card.destination=? AND card.message_id=? AND card.completion_actions=1`)
      .get(destination, messageId) as { message: string; larkCard: string | null } | undefined;
    if (row) return row.larkCard
      ? (JSON.parse(row.larkCard) as StoredLarkCard).markdown
      : larkCardMarkdown(row.message);
  }
  claimLarkStart(destination: string, messageId: string, text: string, chatId: string, replyTo?: string) {
    return !!this.db.prepare(`INSERT OR IGNORE INTO notification_lark_starts
      (destination,message_id,text,next_at,chat_id,reply_to) VALUES(?,?,?,?,?,?)`)
      .run(destination, messageId, text, Date.now(), chatId, replyTo ?? null).changes;
  }
  hasLarkStart(destination: string, messageId: string) {
    return !!this.db.prepare('SELECT 1 FROM notification_lark_starts WHERE destination=? AND message_id=?')
      .get(destination, messageId);
  }
  finishLarkStart(destination: string, messageId: string, text: string, target?: { workspaceId: string; sessionId: string }) {
    this.db.prepare(`UPDATE notification_lark_starts SET text=?,workspace_id=?,session_id=?
      WHERE destination=? AND message_id=?`)
      .run(text, target?.workspaceId ?? null, target?.sessionId ?? null, destination, messageId);
  }
  pendingLarkStarts(destination: string, now: number) {
    return this.db.prepare(`SELECT message_id AS messageId,text,workspace_id AS workspaceId,session_id AS sessionId,attempts,
      reply_to AS replyTo,chat_id AS chatId
      FROM notification_lark_starts WHERE destination=? AND next_at>0 AND next_at<=? ORDER BY next_at LIMIT 32`)
      .all(destination, now) as {
        messageId: string; text: string; workspaceId: string | null; sessionId: string | null;
        attempts: number; replyTo: string | null; chatId: string | null;
      }[];
  }
  updateLarkStartDelivery(destination: string, messageId: string, nextAt: number) {
    this.db.prepare(`UPDATE notification_lark_starts SET next_at=?,attempts=attempts+1
      WHERE destination=? AND message_id=?`).run(nextAt, destination, messageId);
  }
  larkReceipt(destination: string, messageId: string) {
    return this.db.prepare('SELECT receipt FROM notification_lark_replies WHERE destination=? AND message_id=?')
      .get(destination, messageId)?.receipt as string | undefined;
  }
  recordLarkReceipt(destination: string, messageId: string, receipt: string, pending?: {
    workspaceId: string; userId: string; cardMessageId?: string; cardUpdateToken?: string; cardReplyText?: string;
  }) {
    // The legacy update endpoint requires the click callback to be acknowledged first.
    const checkAt = pending?.cardUpdateToken ? Date.now() + 1000 : 0;
    this.db.prepare(`INSERT OR IGNORE INTO notification_lark_replies
      (destination,message_id,receipt,workspace_id,user_id,card_message_id,card_update_token,card_reply_text,check_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(destination, messageId, receipt, pending?.workspaceId ?? null, pending?.userId ?? null,
        pending?.cardMessageId ?? null, pending?.cardUpdateToken ?? null, pending?.cardReplyText ?? null, checkAt);
  }
  pendingLarkReplies(destination: string, now: number) {
    return this.db.prepare(`SELECT rowid, message_id AS messageId, workspace_id AS workspaceId,
      user_id AS userId, receipt, reaction_id AS reactionId, card_message_id AS cardMessageId,
      card_update_token AS cardUpdateToken, card_reply_text AS cardReplyText FROM notification_lark_replies
      WHERE destination=? AND workspace_id IS NOT NULL AND check_at<=? ORDER BY check_at LIMIT 8`)
      .all(destination, now) as {
        rowid: number; messageId: string; workspaceId: string; userId: string; receipt: string; reactionId: string | null;
        cardMessageId: string | null; cardUpdateToken: string | null; cardReplyText: string | null;
      }[];
  }
  hasNewerLarkCardReply(destination: string, cardMessageId: string, rowid: number, receipt: string) {
    return !!this.db.prepare(`SELECT 1 FROM notification_lark_replies
      WHERE destination=? AND card_message_id=? AND rowid>? AND receipt=? LIMIT 1`)
      .get(destination, cardMessageId, rowid, receipt);
  }
  delayLarkReplyCheck(destination: string, messageId: string, until: number) {
    this.db.prepare('UPDATE notification_lark_replies SET check_at=? WHERE destination=? AND message_id=?')
      .run(until, destination, messageId);
  }
  recordLarkWaitReaction(destination: string, messageId: string, reactionId: string) {
    this.db.prepare('UPDATE notification_lark_replies SET reaction_id=? WHERE destination=? AND message_id=?')
      .run(reactionId, destination, messageId);
  }
  updateLarkReceipt(destination: string, messageId: string, receipt: string) {
    this.db.prepare('UPDATE notification_lark_replies SET receipt=? WHERE destination=? AND message_id=?')
      .run(receipt, destination, messageId);
  }
  finishLarkReplyCheck(destination: string, messageId: string) {
    this.db.prepare(`UPDATE notification_lark_replies SET workspace_id=NULL,user_id=NULL,reaction_id=NULL,
      card_update_token=NULL,card_reply_text=NULL
      WHERE destination=? AND message_id=?`).run(destination, messageId);
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
  watch(workspaceId: string, sessionId: string, watched: boolean, since = Date.now()) {
    if (watched) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_watches SELECT ?,?,?
        WHERE (SELECT COUNT(*) FROM notification_watches)<500`,
        )
        .run(workspaceId, sessionId, since);
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
      turnId?: string;
      occurredAt?: number;
    },
    revision: number,
  ) {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_deliveries
      (id,event_key,kind,session_id,title,message,status,created_at,revision,workspace_id,workspace_name,turn_id,occurred_at)
      VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?)`,
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
        input.turnId ?? null,
        input.occurredAt ?? null,
      );
    return result.changes ? id : undefined;
  }
  private select = `SELECT id,kind,event_key AS eventKey,session_id AS sessionId,title,status,attempts,error,
    created_at AS createdAt,sent_at AS sentAt,message,revision,workspace_id AS workspaceId,
    workspace_name AS workspaceName,turn_id AS turnId,occurred_at AS occurredAt,lark_sent_to AS larkSentTo,
    lark_card AS larkCard FROM notification_deliveries`;
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
    this.db.prepare('UPDATE notification_lark_starts SET next_at=0 WHERE workspace_id=?').run(workspaceId);
    this.db.prepare('DELETE FROM notification_lark_messages WHERE workspace_id=?').run(workspaceId);
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
  sent(id: string, warning = '') {
    this.db
      .prepare("UPDATE notification_deliveries SET status='sent',sent_at=?,error=? WHERE id=?")
      .run(Date.now(), warning, id);
  }
  larkDeliveryProgress(id: string, sentTo: Record<string, string>) {
    this.db.prepare('UPDATE notification_deliveries SET lark_sent_to=? WHERE id=?').run(JSON.stringify(sentTo), id);
  }
  saveLarkCard(id: string, card: StoredLarkCard) {
    this.db.prepare('UPDATE notification_deliveries SET lark_card=? WHERE id=?').run(JSON.stringify(card), id);
  }
  failed(id: string, error: string, retryAt?: number) {
    this.db
      .prepare('UPDATE notification_deliveries SET status=?,error=?,next_attempt_at=? WHERE id=?')
      .run(retryAt ? 'pending' : 'failed', error, retryAt ?? 0, id);
  }
}
