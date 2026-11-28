import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthStore } from '../server/auth.js';
import { isAuthorizedDevice, type ControlAuthorization } from '../server/authorization.js';

test('device authorization requires a current administrator and a matching unexpired device', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'monitor-authorization-'));
  const auth = new AuthStore(directory);
  try {
    const owner = await auth.setup('owner', 'authorization-test-password');
    const identity = auth.issue(owner, 'device');
    assert.equal(await isAuthorizedDevice(auth.db, identity), true);
    assert.equal(
      await isAuthorizedDevice(auth.db, { ...identity, user: { ...owner, id: 'other-user' } }),
      false,
    );
    auth.db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(0, identity.sessionId);
    assert.equal(await isAuthorizedDevice(auth.db, identity), false);
    auth.db
      .prepare('UPDATE sessions SET expires_at=? WHERE id=?')
      .run(identity.expiresAt, identity.sessionId);
    auth.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(owner.id);
    assert.equal(await isAuthorizedDevice(auth.db, identity), false);
    auth.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(owner.id);
    auth.revoke(owner.id, identity.sessionId);
    let remoteChecks = 0;
    assert.equal(
      await isAuthorizedDevice(auth.db, identity, {
        device: async () => {
          remoteChecks++;
          return true;
        },
        user: async () => true,
      }),
      false,
    );
    assert.equal(remoteChecks, 0, 'a locally revoked device must not reach remote authorization');
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('remote authorization cannot override revocation, expiry, role changes, or shutdown', async (t) => {
  for (const change of ['revoke', 'expire', 'demote', 'close', 'deny', 'error'] as const) {
    await t.test(change, async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'monitor-authorization-'));
      const auth = new AuthStore(directory);
      let active = true;
      try {
        const owner = await auth.setup('owner', 'authorization-test-password');
        const identity = auth.issue(owner, 'device');
        const unavailable = new Error('server unavailable');
        const authorization: ControlAuthorization = {
          device: async () => {
            switch (change) {
              case 'revoke':
                auth.revoke(owner.id, identity.sessionId);
                break;
              case 'expire':
                auth.db.prepare('UPDATE sessions SET expires_at=0').run();
                break;
              case 'demote':
                auth.db.prepare("UPDATE users SET role='viewer'").run();
                break;
              case 'close':
                active = false;
                auth.close();
                break;
              case 'deny':
                return false;
              case 'error':
                throw unavailable;
            }
            return true;
          },
          user: async () => true,
        };
        const result = isAuthorizedDevice(auth.db, identity, authorization, () => active);
        if (change === 'error') await assert.rejects(result, unavailable);
        else assert.equal(await result, false);
      } finally {
        if (active) auth.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
