import type { DatabaseSync } from 'node:sqlite';
import type { User } from '../src/types.js';

export type Identity = { user: User; sessionId: string; expiresAt: number };

export type WorkspaceAuth = {
  db: DatabaseSync;
  authenticate: (token: string) => Identity | null;
  log: (action: string, username: string, ip: string) => void;
};

export type ControlAuthorization = {
  device: (identity: Identity) => Promise<boolean>;
  user: (userId: string) => Promise<boolean>;
};

/** A remote check may yield while a local device is revoked or the workspace closes. */
export async function isAuthorizedDevice(
  db: DatabaseSync,
  identity: Identity,
  authorization?: ControlAuthorization,
  active: () => boolean = () => true,
) {
  const valid = () =>
    active() &&
    !!db
      .prepare(
        `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.id=? AND s.user_id=? AND s.expires_at>? AND u.role='admin'`,
      )
      .get(identity.sessionId, identity.user.id, Date.now());
  return valid() && (!authorization || (await authorization.device(identity))) && valid();
}
