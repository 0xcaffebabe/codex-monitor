import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ManagedWorkspace } from '../../src/workspaces.js';
import { connectionProof } from '../transport/protocol.js';

const workspaceColumns = `id,name,created_at AS createdAt,last_seen AS lastSeen,hostname,platform,
  build_commit_at AS buildCommitAt`;
function workspaceFromRow(row: Record<string, SQLOutputValue>): ManagedWorkspace {
  return {
    id: String(row.id),
    name: String(row.name),
    createdAt: Number(row.createdAt),
    lastSeen: row.lastSeen == null ? null : Number(row.lastSeen),
    hostname: String(row.hostname || ''),
    platform: String(row.platform || ''),
    buildCommitAt: row.buildCommitAt == null ? null : Number(row.buildCommitAt),
    online: false,
  };
}

export class WorkspaceStore {
  private proofs = new Map<string, number>();
  constructor(private db: DatabaseSync) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS monitor_workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, aes_key TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_seen INTEGER, hostname TEXT, platform TEXT, build_commit_at INTEGER
      )`);
      const columns = db
        .prepare('PRAGMA table_info(monitor_workspaces)')
        .all()
        .map((row) => row.name);
      if (!columns.includes('aes_key') && columns.includes('token_hash')) {
        // Preserve existing registrations when upgrading the earlier token-only schema.
        db.exec('ALTER TABLE monitor_workspaces RENAME COLUMN token_hash TO aes_key');
        const update = db.prepare('UPDATE monitor_workspaces SET aes_key=? WHERE id=?');
        for (const row of db.prepare('SELECT id FROM monitor_workspaces').all())
          update.run(randomBytes(32).toString('base64url'), row.id!);
      }
      if (!columns.includes('build_commit_at'))
        db.exec('ALTER TABLE monitor_workspaces ADD COLUMN build_commit_at INTEGER');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  list(): ManagedWorkspace[] {
    return this.db
      .prepare(`SELECT ${workspaceColumns} FROM monitor_workspaces ORDER BY created_at,id`)
      .all()
      .map(workspaceFromRow);
  }
  get(id: string) {
    const row = this.db
      .prepare(`SELECT ${workspaceColumns} FROM monitor_workspaces WHERE id=?`)
      .get(id);
    return row ? workspaceFromRow(row) : undefined;
  }
  create(name: string, id: string = randomUUID(), key = randomBytes(32).toString('base64url')) {
    if (Number(this.db.prepare('SELECT count(*) AS n FROM monitor_workspaces').get()!.n) >= 50)
      throw new Error('最多可注册 50 个工作空间');
    this.db
      .prepare('INSERT INTO monitor_workspaces(id,name,aes_key,created_at) VALUES(?,?,?,?)')
      .run(id, name, key, Date.now());
    return { workspace: this.get(id)!, key };
  }
  key(id: string) {
    const row = this.db.prepare('SELECT aes_key FROM monitor_workspaces WHERE id=?').get(id);
    return row ? String(row.aes_key) : null;
  }
  authenticate(id: string, proof: string) {
    const key = this.key(id),
      match = /^Monitor-HMAC (\d{13})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(proof);
    if (!key || !match || Math.abs(Date.now() - Number(match[1])) > 60000) return null;
    const now = Date.now();
    for (const [nonce, expiry] of this.proofs) if (expiry < now) this.proofs.delete(nonce);
    const nonceId = `${id}:${match[2]}`;
    if (this.proofs.has(nonceId)) return null;
    const expected = connectionProof(key, id, Number(match[1]), match[2]);
    if (
      Buffer.byteLength(proof) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
    )
      return null;
    if (this.proofs.size >= 10000) return null;
    this.proofs.set(nonceId, now + 120000);
    return key;
  }
  rename(id: string, name: string) {
    return !!this.db.prepare('UPDATE monitor_workspaces SET name=? WHERE id=?').run(name, id)
      .changes;
  }
  rotate(id: string) {
    const key = randomBytes(32).toString('base64url');
    if (!this.db.prepare('UPDATE monitor_workspaces SET aes_key=? WHERE id=?').run(key, id).changes)
      return null;
    return key;
  }
  recordConnection(id: string, hostname: string, platform: string, buildCommitAt: number | null) {
    this.db
      .prepare(
        'UPDATE monitor_workspaces SET last_seen=?,hostname=?,platform=?,build_commit_at=? WHERE id=?',
      )
      .run(Date.now(), hostname, platform, buildCommitAt, id);
  }
  seen(id: string) {
    this.db.prepare('UPDATE monitor_workspaces SET last_seen=? WHERE id=?').run(Date.now(), id);
  }
  remove(id: string) {
    return !!this.db.prepare('DELETE FROM monitor_workspaces WHERE id=?').run(id).changes;
  }
}
