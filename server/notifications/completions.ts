import type { DatabaseSync } from 'node:sqlite';
import type { CompletionNotificationPage } from '../../src/types.js';
import { notificationKey, type CompletionEvent } from './events.js';

/** Server-owned feed. Its sequence is independent of delivery attempts and wall-clock precision. */
export class CompletionNotifications {
  readonly since: number;
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS browser_notification_state (
      id INTEGER PRIMARY KEY CHECK(id=1), since INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_notifications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL,
      workspace_id TEXT NOT NULL, workspace_name TEXT NOT NULL,
      session_id TEXT NOT NULL, title TEXT NOT NULL, completed_at INTEGER NOT NULL
    );`);
    db.prepare('INSERT OR IGNORE INTO browser_notification_state VALUES(1,?)').run(
      Math.floor(Date.now() / 1000) * 1000,
    );
    this.since = Number(db.prepare('SELECT since FROM browser_notification_state').get()!.since);
  }
  receive(workspace: { id: string; name: string }, event: CompletionEvent) {
    if (event.occurredAt < this.since) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO browser_notifications
      (event_key,workspace_id,workspace_name,session_id,title,completed_at) VALUES(?,?,?,?,?,?)`,
      )
      .run(
        `${workspace.id}:${notificationKey(event)}`,
        workspace.id,
        workspace.name,
        event.sessionId,
        event.title,
        event.occurredAt,
      );
  }
  forgetWorkspace(id: string) {
    this.db.prepare('DELETE FROM browser_notifications WHERE workspace_id=?').run(id);
  }
  page(after?: number): CompletionNotificationPage {
    const latest = Number(
      this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM browser_notifications').get()!.n,
    );
    // The first request establishes a baseline; it never floods a new viewer with old completions.
    if (after === undefined || after > latest)
      return { cursor: latest, notifications: [], hasMore: false };
    const rows = this.db
      .prepare(
        `SELECT seq AS id,workspace_id AS workspaceId,
      workspace_name AS workspaceName,session_id AS sessionId,title,completed_at AS completedAt
      FROM browser_notifications WHERE seq>? ORDER BY seq LIMIT 51`,
      )
      .all(after);
    const hasMore = rows.length > 50;
    const notifications = rows.slice(
      0,
      50,
    ) as unknown as CompletionNotificationPage['notifications'];
    return { cursor: hasMore ? notifications.at(-1)!.id : latest, notifications, hasMore };
  }
}

/** Client journal retained across webhook configuration changes and lost acknowledgements. */
export class CompletionOutbox {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS browser_completion_scan (
      id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, scan_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_completion_reports (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS browser_completion_pending ON browser_completion_reports(seq)
      WHERE payload<>'';`);
  }
  state() {
    return this.db
      .prepare('SELECT generation,scan_at AS scanAt FROM browser_completion_scan')
      .get() as { generation: number; scanAt: number } | undefined;
  }
  reset(generation: number, at: number, baseline: CompletionEvent[]) {
    this.db.exec('DELETE FROM browser_completion_reports');
    this.db
      .prepare('INSERT OR REPLACE INTO browser_completion_scan VALUES(1,?,?)')
      .run(generation, at);
    for (const event of baseline) this.enqueue(event, true);
  }
  enqueue(event: CompletionEvent, ignored = false) {
    this.db
      .prepare('INSERT OR IGNORE INTO browser_completion_reports(event_key,payload) VALUES(?,?)')
      .run(notificationKey(event), ignored ? '' : JSON.stringify(event));
  }
  checkpoint(at: number) {
    this.db.prepare('UPDATE browser_completion_scan SET scan_at=? WHERE id=1').run(at);
  }
  pending() {
    return this.db
      .prepare(
        "SELECT seq,payload FROM browser_completion_reports WHERE payload<>'' ORDER BY seq LIMIT 4",
      )
      .all()
      .map((row) => ({
        seq: Number(row.seq),
        event: JSON.parse(String(row.payload)) as CompletionEvent,
      }));
  }
  acknowledge(sequences: number[]) {
    const update = this.db.prepare("UPDATE browser_completion_reports SET payload='' WHERE seq=?");
    for (const seq of sequences) update.run(seq);
  }
}
