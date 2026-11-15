import type { DatabaseSync } from 'node:sqlite';
import { notificationKey, reportKey, type NotificationEvent } from './events.js';

/** Client-local journal: payloads are released only after the server persists a report. */
export class NotificationReportStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_scan (
        id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, scan_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_reports (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_active_inputs (
        event_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notification_reports_pending ON notification_reports(
        CASE kind WHEN 'session.input_resolved' THEN 0 WHEN 'session.input_required' THEN 1 ELSE 2 END,seq
      ) WHERE payload<>'';
    `);
  }
  state() {
    return this.db
      .prepare('SELECT generation,scan_at AS scanAt FROM notification_scan WHERE id=1')
      .get() as { generation: number; scanAt: number } | undefined;
  }
  reset(generation: number, at: number, baseline: NotificationEvent[]) {
    this.transaction(() => {
      this.db.exec('DELETE FROM notification_reports; DELETE FROM notification_active_inputs');
      this.db.prepare('INSERT OR REPLACE INTO notification_scan VALUES(1,?,?)').run(generation, at);
      for (const event of baseline) this.enqueue(event, true);
    });
  }
  transaction(write: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      write();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  enqueue(event: NotificationEvent, ignored = false) {
    this.db
      .prepare('INSERT OR IGNORE INTO notification_reports(event_key,kind,payload) VALUES(?,?,?)')
      .run(reportKey(event), event.kind, ignored ? '' : JSON.stringify(event));
  }
  activeInputs() {
    return this.db
      .prepare(
        `SELECT event_key AS key,session_id AS sessionId,request_id AS requestId,
      created_at AS createdAt FROM notification_active_inputs`,
      )
      .all() as unknown as {
      key: string;
      sessionId: string;
      requestId: string;
      createdAt: number;
    }[];
  }
  trackInput(event: Extract<NotificationEvent, { kind: 'session.input_required' }>) {
    this.db
      .prepare('INSERT OR IGNORE INTO notification_active_inputs VALUES(?,?,?,?)')
      .run(notificationKey(event), event.sessionId, event.requestId, event.occurredAt);
  }
  resolveInput(event: Extract<NotificationEvent, { kind: 'session.input_resolved' }>) {
    this.db
      .prepare('DELETE FROM notification_active_inputs WHERE event_key=?')
      .run(notificationKey(event));
    // A question answered before upload must not briefly alert on reconnect.
    this.db
      .prepare('UPDATE notification_reports SET payload=? WHERE event_key=?')
      .run('', `session.input_required:${notificationKey(event)}`);
    this.enqueue(event);
  }
  checkpoint(at: number) {
    this.db.prepare('UPDATE notification_scan SET scan_at=? WHERE id=1').run(at);
  }
  pending() {
    return this.db
      .prepare(
        `SELECT seq,payload FROM notification_reports WHERE payload<>''
      ORDER BY CASE kind WHEN 'session.input_resolved' THEN 0 WHEN 'session.input_required' THEN 1 ELSE 2 END,seq LIMIT 4`,
      )
      .all()
      .map((row) => ({
        seq: Number(row.seq),
        event: JSON.parse(String(row.payload)) as NotificationEvent,
      }));
  }
  acknowledge(sequences: number[]) {
    this.transaction(() => {
      const update = this.db.prepare("UPDATE notification_reports SET payload='' WHERE seq=?");
      for (const seq of sequences) update.run(seq);
    });
  }
}
