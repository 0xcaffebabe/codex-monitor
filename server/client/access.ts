import { randomBytes } from 'node:crypto';
import type { User } from '../../src/types.js';
import type { AuthStore } from '../auth.js';
import type { Identity, WorkspaceAuth } from '../http/access.js';

/** Client-local leases contain identities only, never passwords or server bearer tokens. */
export class ClientAccess implements WorkspaceAuth {
  readonly db;
  private leases = new Map<string, Identity>();
  constructor(
    private store: AuthStore,
    private shared: boolean,
  ) {
    this.db = store.db;
    if (!shared) {
      this.db.exec("DELETE FROM sessions; UPDATE users SET role='viewer'");
    }
  }
  syncUser(user: User) {
    if (!this.shared) {
      // A deleted central account can be recreated with the same display name and a new ID.
      this.db
        .prepare('DELETE FROM users WHERE username=? AND id<>?')
        .run(user.username, user.id);
      this.db
        .prepare(
          `INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,'remote',?,?)
        ON CONFLICT(id) DO UPDATE SET username=excluded.username,role=excluded.role`,
        )
        .run(user.id, user.username, user.role, Date.now());
    }
  }
  open(identity: Identity) {
    this.syncUser(identity.user);
    if (!this.shared) {
      this.db
        .prepare(
          `INSERT INTO sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id)
        DO UPDATE SET user_id=excluded.user_id,expires_at=excluded.expires_at`,
        )
        .run(
          identity.sessionId,
          `remote-${identity.sessionId}`,
          identity.user.id,
          'server',
          Date.now(),
          Date.now(),
          identity.expiresAt,
        );
    }
    const token = randomBytes(32).toString('base64url');
    this.leases.set(token, identity);
    return { token, close: () => this.leases.delete(token) };
  }
  authenticate(token: string) {
    const identity = this.leases.get(token);
    return identity && identity.expiresAt > Date.now() ? identity : null;
  }
  log(action: string, username: string, ip: string) {
    this.store.log(action, username, ip);
  }
  clear() {
    this.leases.clear();
  }
}
