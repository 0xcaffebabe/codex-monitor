import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  SecureChannel,
  PROTOCOL_VERSION,
  connectionProof,
  workspacePath,
  type Frame,
} from '../server/transport/protocol.js';
import { WorkspaceStore } from '../server/workspaces/store.js';
import { AuthStore } from '../server/auth.js';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('fixed AES-256-GCM keys encrypt both directions and reject tampering, replay and cross-connection frames', () => {
  const key = randomBytes(32).toString('base64url'),
    connectionId = randomBytes(32).toString('base64url');
  const proof = connectionProof(key, randomUUID());
  const server = new SecureChannel(key, connectionId, 'server', proof),
    client = new SecureChannel(key, connectionId, 'client', proof);
  const frame: Frame = { type: 'error', id: randomUUID(), message: 'private-prompt-不能明文出现' };
  const encrypted = server.encode(frame);
  assert.ok(!encrypted.includes(frame.message));
  assert.deepEqual(client.decode(encrypted), frame);
  assert.throws(() => client.decode(encrypted), /sequence/);
  const response = client.encode(frame);
  assert.deepEqual(server.decode(response), frame);
  assert.notEqual(JSON.parse(encrypted).iv, JSON.parse(response).iv);
  const next = server.encode(frame),
    tampered = JSON.parse(next);
  tampered.c = (tampered.c[0] === 'A' ? 'B' : 'A') + tampered.c.slice(1);
  assert.throws(() => client.decode(JSON.stringify(tampered)));
  assert.deepEqual(client.decode(next), frame, 'a failed tag cannot advance the receive sequence');
  assert.throws(() =>
    new SecureChannel(randomBytes(32).toString('base64url'), connectionId, 'client', proof).decode(
      encrypted,
    ),
  );
  assert.throws(() =>
    new SecureChannel(key, randomBytes(32).toString('base64url'), 'client', proof).decode(
      encrypted,
    ),
  );
  assert.throws(
    () => new SecureChannel(key, connectionId, 'server', proof).decode(encrypted),
    'direction reflection rejected',
  );
  const reconnected = new SecureChannel(
    key,
    randomBytes(32).toString('base64url'),
    'client',
    proof,
  );
  assert.throws(
    () => reconnected.decode(response),
    'the key remains fixed but connection-bound authentication changes',
  );
});

test('a recorded server channel cannot be replayed against a fresh client handshake', () => {
  const key = randomBytes(32).toString('base64url');
  const connectionId = randomBytes(32).toString('base64url');
  const workspace = randomUUID();
  const originalProof = connectionProof(key, workspace);
  const recorded = new SecureChannel(key, connectionId, 'server', originalProof).encode({
    type: 'welcome',
    version: PROTOCOL_VERSION,
    workspaceId: workspace,
  });
  // A fake server can repeat the cleartext connection ID, but not the fresh client's nonce.
  const replayed = new SecureChannel(key, connectionId, 'client', connectionProof(key, workspace));
  assert.throws(() => replayed.decode(recorded));
});

test('handshake authenticates without disclosing the local AES key and rejects expired or replayed proofs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-crypto-')),
    auth = new AuthStore(root),
    store = new WorkspaceStore(auth.db);
  try {
    const { workspace, key } = store.create('client');
    const proof = connectionProof(key, workspace.id);
    assert.ok(!proof.includes(key));
    assert.equal(store.authenticate(workspace.id, proof), key);
    assert.equal(store.authenticate(workspace.id, proof), null);
    assert.equal(
      store.authenticate(workspace.id, connectionProof(key, workspace.id, Date.now() - 120000)),
      null,
    );
    assert.equal(
      store.authenticate(
        workspace.id,
        connectionProof(randomBytes(32).toString('base64url'), workspace.id),
      ),
      null,
    );
    const replacement = store.rotate(workspace.id)!;
    assert.notEqual(replacement, key);
    assert.equal(store.authenticate(workspace.id, connectionProof(key, workspace.id)), null);
    assert.equal(
      store.authenticate(workspace.id, connectionProof(replacement, workspace.id)),
      replacement,
    );
    assert.ok(!JSON.stringify(store.list()).includes(replacement));
    assert.ok(workspacePath('GET', '/api/sessions/1111/images/image?index=0'));
    for (const value of [
      '/api/auth/me',
      '/api/users',
      'http://localhost/api/sessions',
      '/api/sessions/../auth',
      '/api/sessions/%2e%2e/auth',
      '/api/sessions\\auth',
    ])
      assert.equal(workspacePath('GET', value), false, value);
  } finally {
    auth.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing token registrations migrate once to locally stored fixed AES keys', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-upgrade-')),
    auth = new AuthStore(root);
  try {
    auth.db
      .exec(`CREATE TABLE monitor_workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,last_seen INTEGER,hostname TEXT,platform TEXT);
      INSERT INTO monitor_workspaces(id,name,token_hash,created_at) VALUES('local','原有本机工作空间','old-hash',1)`);
    const store = new WorkspaceStore(auth.db),
      key = store.key('local')!;
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(store.get('local')!.name, '原有本机工作空间');
    assert.equal(store.get('local')!.buildCommitAt, null);
    assert.equal(
      new WorkspaceStore(auth.db).key('local'),
      key,
      'restarting keeps the same AES key',
    );
    assert.equal(store.authenticate('local', connectionProof(key, 'local')), key);
    assert.ok(store.create('new client').key);
  } finally {
    auth.close();
    rmSync(root, { recursive: true, force: true });
  }
});
