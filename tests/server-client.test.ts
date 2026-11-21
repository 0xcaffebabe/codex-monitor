import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop } from './control-fixture.js';
import { createMonitorServer } from '../server/server-app.js';
import { MonitorClient } from '../server/client/connection.js';
import { requestGuard } from '../server/http/security.js';
import { passwordHash } from '../server/auth.js';
import { MAX_BODY } from '../server/transport/protocol.js';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out');
    await delay(30);
  }
}

test('two clients over encrypted ws isolate reads, writes, uploads and receipts, survive reconnect and enforce central permissions', async () => {
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning);
  };
  process.on('warning', onWarning);
  const a = fixture(),
    b = fixture();
  a.config.pollMs = b.config.pollMs = 40;
  a.state.prepare('UPDATE threads SET title=? WHERE id=?').run('client-A-only', ids.modern);
  b.state.prepare('UPDATE threads SET title=? WHERE id=?').run('client-B-only', ids.modern);
  const controlA = new FixtureDesktop(a),
    controlB = new FixtureDesktop(b);
  const service = createMonitorServer({
    ...a.config,
    dataDir: path.join(a.root, 'central'),
    codexHome: path.join(a.root, 'no-codex-needed'),
  });
  const server = createServer(service.app);
  service.gateway.attach(server, requestGuard(a.config));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'a-long-password'),
    login = service.auth.issue(owner, 'integration');
  const headers = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
  const wa = service.gateway.store.create('Client A'),
    wb = service.gateway.store.create('Client B');
  const clientA = await MonitorClient.start({
    config: a.config,
    serverUrl: base,
    workspaceId: wa.workspace.id,
    key: wa.key,
    services: { control: controlA },
    reconnectMs: 100,
  });
  let clientB = await MonitorClient.start({
    config: b.config,
    serverUrl: base,
    workspaceId: wb.workspace.id,
    key: wb.key,
    services: { control: controlB },
    reconnectMs: 100,
  });
  const get = (workspace: string, route: string, token = login.token) =>
    fetch(`${base}/api/workspaces/${workspace}${route}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  const post = (workspace: string, route: string, body: object) =>
    fetch(`${base}/api/workspaces/${workspace}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  let streamAbort: AbortController | undefined;
  try {
    await until(() => clientA.connected && clientB.connected);
    const navigationStatus = (route: string) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          base + route,
          { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        request.on('error', reject);
        request.end();
      });
    assert.equal(await navigationStatus('/'), 200);
    assert.equal(
      (
        await fetch(`${base}/api/workspaces`, {
          headers: { ...headers, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' },
        })
      ).status,
      403,
    );
    assert.equal((await get(wa.workspace.id, `/sessions/${ids.modern}`)).status, 200);
    assert.equal(
      (await (await get(wa.workspace.id, `/sessions/${ids.modern}`)).json()).session.title,
      'client-A-only',
    );
    assert.equal(
      (await (await get(wb.workspace.id, `/sessions/${ids.modern}`)).json()).session.title,
      'client-B-only',
    );
    assert.equal((await fetch(`${base}/api/workspaces`)).status, 401);
    assert.equal((await get(wa.workspace.id, '/auth/me')).status, 404);
    const connectionKey = await get(wa.workspace.id, '/connection-key');
    assert.equal(connectionKey.status, 200);
    assert.equal(connectionKey.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await connectionKey.json(), { key: wa.key });
    assert.equal(
      service.gateway.list().find((workspace) => workspace.id === wa.workspace.id)?.online,
      true,
    );
    assert.equal((await get(wa.workspace.id, '/connection-key', '')).status, 401);
    assert.equal((await get('missing', '/connection-key')).status, 404);
    assert.equal((await get('local', '/connection-key')).status, 409);
    const uploadBytes = randomBytes(MAX_BODY);
    const upload = await fetch(`${base}/api/workspaces/${wa.workspace.id}/uploads?name=test.bin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${login.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: uploadBytes,
    });
    assert.equal(upload.status, 201);
    const attachment = await upload.json();
    const downloaded = await get(wa.workspace.id, `/uploads/${attachment.id}`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), uploadBytes);
    assert.equal(
      warnings.length,
      0,
      'large compressed responses must not retain a listener per chunk',
    );
    assert.equal((await get(wb.workspace.id, `/uploads/${attachment.id}`)).status, 400);
    const requestId = randomUUID(),
      payload = { requestId, prompt: 'ws-only-A', attachments: [attachment.id] };
    await post(wa.workspace.id, `/sessions/${ids.modern}/messages`, payload);
    await until(() => controlA.sends === 1);
    await until(
      async () =>
        (await (await get(wa.workspace.id, `/control/requests/${requestId}`)).json()).state ===
        'succeeded',
    );
    assert.equal(controlB.sends, 0);
    assert.equal((await get(wb.workspace.id, `/control/requests/${requestId}`)).status, 404);
    assert.match(
      JSON.stringify(await (await get(wa.workspace.id, `/sessions/${ids.modern}`)).json()),
      /ws-only-A/,
    );
    assert.doesNotMatch(
      JSON.stringify(await (await get(wb.workspace.id, `/sessions/${ids.modern}`)).json()),
      /ws-only-A/,
    );

    clientA.reconnect();
    await until(() => !clientA.connected);
    await until(() => clientA.connected);
    await post(wa.workspace.id, `/sessions/${ids.modern}/messages`, payload);
    assert.equal(controlA.sends, 1, 'reconnecting cannot replay an acknowledged mutation');

    const viewerId = randomUUID();
    service.auth.db
      .prepare('INSERT INTO users VALUES(?,?,?,?,?)')
      .run(viewerId, 'reader', await passwordHash('viewer-password!'), 'viewer', Date.now());
    const viewer = service.auth.issue(
      { id: viewerId, username: 'reader', role: 'viewer' },
      'viewer',
    );
    assert.equal((await get(wa.workspace.id, `/sessions/${ids.modern}`, viewer.token)).status, 200);
    assert.equal((await get(wa.workspace.id, '/connection-key', viewer.token)).status, 403);
    const listedWorkspaces = await fetch(`${base}/api/workspaces`, {
      headers: { Authorization: `Bearer ${viewer.token}` },
    });
    assert.equal((await listedWorkspaces.text()).includes(wa.key), false);
    assert.equal(
      (
        await fetch(`${base}/api/workspaces/${wa.workspace.id}/sessions/${ids.modern}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${viewer.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: randomUUID(), prompt: 'denied' }),
        })
      ).status,
      403,
    );

    service.auth.db.prepare('DELETE FROM users WHERE id=?').run(viewerId);
    const recreatedId = randomUUID();
    service.auth.db
      .prepare('INSERT INTO users VALUES(?,?,?,?,?)')
      .run(recreatedId, 'reader', await passwordHash('viewer-password!'), 'viewer', Date.now());
    const recreated = service.auth.issue(
      { id: recreatedId, username: 'reader', role: 'viewer' },
      'recreated',
    );
    assert.equal(
      (await get(wa.workspace.id, `/sessions/${ids.modern}`, recreated.token)).status,
      200,
      'recreated account names cannot collide with stale client identity rows',
    );

    let reached!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalState = controlA.state.bind(controlA);
    controlA.state = async (...args) => {
      reached();
      await gate;
      return originalState(...args);
    };
    const temporary = service.auth.issue(owner, 'revoked during client RPC');
    const mutation = fetch(
      `${base}/api/workspaces/${wa.workspace.id}/sessions/${ids.modern}/commands`,
      {
        method: 'POST',
        headers: { ...headers, Authorization: `Bearer ${temporary.token}` },
        body: JSON.stringify({
          requestId: randomUUID(),
          command: 'goal.set',
          prompt: 'must-not-dispatch',
        }),
      },
    );
    await started;
    service.auth.revoke(owner.id, temporary.sessionId);
    release();
    assert.equal((await mutation).status, 401);
    controlA.state = originalState;
    assert.equal(
      controlA.goals.size,
      0,
      'client rechecks the central device after a slow state probe',
    );

    streamAbort = new AbortController();
    const stream = await fetch(
      `${base}/api/workspaces/${wa.workspace.id}/stream?session=${ids.modern}`,
      { headers, signal: streamAbort.signal },
    );
    const reader = stream.body!.getReader();
    let events = '';
    while (!events.includes('event: update'))
      events += new TextDecoder().decode((await reader.read()).value);
    a.state
      .prepare('UPDATE threads SET updated_at_ms=? WHERE id=?')
      .run(Date.now() + 1000, ids.modern);
    events = '';
    while (!events.includes('event: update'))
      events += new TextDecoder().decode((await reader.read()).value);
    service.auth.revoke(owner.id, login.sessionId);
    events = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      events += new TextDecoder().decode(chunk.value);
    }
    assert.match(events, /unauthorized/);
    reader.releaseLock();
    streamAbort.abort();
    assert.equal((await get(wa.workspace.id, '/overview')).status, 401);

    await clientB.close();
    await until(() => !service.gateway.list().find((item) => item.id === wb.workspace.id)!.online);
    const fresh = service.auth.issue(owner, 'fresh');
    assert.equal((await get(wb.workspace.id, '/overview', fresh.token)).status, 503);
    const replacementKey = service.gateway.store.rotate(wb.workspace.id)!;
    assert.notEqual(replacementKey, wb.key);
    const offlineConnectionKey = await get(wb.workspace.id, '/connection-key', fresh.token);
    assert.equal(offlineConnectionKey.status, 200);
    assert.deepEqual(await offlineConnectionKey.json(), { key: replacementKey });
    const wrong = await MonitorClient.start({
      config: b.config,
      serverUrl: base,
      workspaceId: wb.workspace.id,
      key: wb.key,
      reconnectMs: 100,
    });
    await delay(200);
    assert.equal(wrong.connected, false);
    await wrong.close();
    clientB = await MonitorClient.start({
      config: b.config,
      serverUrl: base,
      workspaceId: wb.workspace.id,
      key: replacementKey,
      services: { control: new FixtureDesktop(b) },
    });
    await until(() => clientB.connected);
    assert.equal((await get(wb.workspace.id, '/overview', fresh.token)).status, 200);
  } finally {
    process.off('warning', onWarning);
    streamAbort?.abort();
    await clientA.close();
    await clientB.close();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    a.close();
    b.close();
    rmSync(a.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(b.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
