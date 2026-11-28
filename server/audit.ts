import type { DatabaseSync } from 'node:sqlite';

/** Append to the caller's database and transaction; event meaning stays with the operation. */
export function appendAudit(db: DatabaseSync, action: string, username: string, ip: string) {
  db.prepare('INSERT INTO audit(at,action,username,ip) VALUES(?,?,?,?)').run(
    Date.now(),
    action,
    username,
    ip,
  );
}
