import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CompletionNotification, CompletionNotificationSnapshot } from '../../src/types.js';
import { notificationKey, type CompletionEvent } from './events.js';

/** Pending notices live only in this process; SQLite retains receipts solely for deduplication. */
export class CompletionNotifications {
  readonly since: number;
  private readonly generation = randomUUID();
  private revision = 0;
  private pending = new Map<number, CompletionNotification>();
  private listeners = new Set<(snapshot?: CompletionNotificationSnapshot) => void>();
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
  /** Call inside the report transaction; publish only after that transaction commits. */
  record(workspace: { id: string; name: string }, event: CompletionEvent) {
    if (event.occurredAt < this.since) return;
    const result = this.db
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
    if (!result.changes) return;
    return {
      id: Number(result.lastInsertRowid),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      sessionId: event.sessionId,
      title: event.title,
      completedAt: event.occurredAt,
    };
  }
  publish(notifications: CompletionNotification[]) {
    if (!notifications.length) return;
    for (const notification of notifications) this.pending.set(notification.id, notification);
    while (this.pending.size > 50) this.pending.delete(this.pending.keys().next().value!);
    this.changed();
  }
  pendingId(eventKey: string) {
    const row = this.db.prepare('SELECT seq FROM browser_notifications WHERE event_key=?').get(eventKey);
    const id = Number(row?.seq);
    if (this.pending.has(id)) return id;
  }
  forgetWorkspace(id: string) {
    const ids = [...this.pending.values()]
      .filter((item) => item.workspaceId === id)
      .map((item) => item.id);
    this.dismiss(this.generation, ids);
  }
  snapshot(): CompletionNotificationSnapshot {
    return {
      generation: this.generation,
      revision: this.revision,
      notifications: [...this.pending.values()],
    };
  }
  subscribe(listener: (snapshot?: CompletionNotificationSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }
  close() {
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  private changed() {
    this.revision++;
    if (!this.listeners.size) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
  dismiss(generation: string, ids: number[]) {
    // An old page cannot clear notices belonging to a restarted Server.
    if (generation !== this.generation) return undefined;
    let changed = false;
    for (const id of ids) if (this.pending.delete(id)) changed = true;
    if (changed) this.changed();
    return this.snapshot();
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
