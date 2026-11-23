import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { uptime } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { fixture } from './fixture.js';
import { MonitorClient } from '../server/client/connection.js';
import { createMonitorServer } from '../server/server-app.js';
import {
  connectionProof,
  PROTOCOL_VERSION,
  readFrame,
  sendFrame,
  startClientChannel,
  startServerChannel,
  type Frame,
} from '../server/transport/protocol.js';
import { HOST_RESOURCE_INTERVAL_MS, HOST_RESOURCE_STALE_MS } from '../src/workspaces.js';

async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Resource report timed out');
    await delay(20);
  }
}

test('a real client reports host resources periodically and starts a fresh CPU baseline on reconnect', async () => {
  const f = fixture();
  const service = createMonitorServer(f.config);
  const server = createServer(service.app);
  service.gateway.attach(server, () => true);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const workspace = service.gateway.store.create('real sampler');
  const client = await MonitorClient.start({
    config: f.config,
    serverUrl: base,
    workspaceId: workspace.workspace.id,
    key: workspace.key,
    reconnectMs: 100,
  });
  const current = () => service.gateway.list()[0];
  try {
    await until(() => !!current().resources);
    const initial = current().resources!;
    assert.equal(initial.cpuPercent, null);
    assert.ok(initial.memory && initial.memory.totalBytes > 0);
    if (process.platform === 'win32') {
      assert.ok(
        initial.uptimeSeconds !== undefined && Math.abs(initial.uptimeSeconds - uptime()) < 5,
      );
    } else {
      assert.equal(initial.uptimeSeconds, undefined);
    }
    await until(() => current().resources?.cpuPercent != null);
    const periodic = current().resources!;
    assert.ok(periodic.sampledAt > initial.sampledAt);
    assert.ok(periodic.cpuPercent! >= 0 && periodic.cpuPercent! <= 100);
    client.reconnect();
    await until(() => !current().online);
    assert.equal(current().resources, null);
    await until(() => !!current().resources);
    assert.equal(current().resources!.cpuPercent, null);
    assert.ok(current().resources!.sampledAt > periodic.sampledAt);
  } finally {
    await client.close();
    try {
      // Local socket close precedes delivery of EOF to the remote gateway.
      await until(() => !current().online);
      assert.equal(current().resources, null);
    } finally {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.close();
      rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test('Server attributes samples to the authenticated workspace and ages them using its own clock', async (t) => {
  const f = fixture();
  const service = createMonitorServer(f.config);
  const server = createServer(service.app);
  service.gateway.attach(server, () => true);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const user = await service.auth.setup('owner', 'resource-test-password!');
  const headers = { Authorization: `Bearer ${service.auth.issue(user, 'test').token}` };
  const workspace = service.gateway.store.create('legacy client');
  const other = service.gateway.store.create('other');
  const proof = connectionProof(workspace.key, workspace.workspace.id);
  const socket = new WebSocket(
    base.replace('http:', 'ws:') + '/api/clients/connect?workspace=' + workspace.workspace.id,
    {
      headers: { Authorization: proof },
    },
  );
  let encrypted = false;
  let welcomed = false;
  socket.on('message', (raw) => {
    if (!encrypted) {
      startClientChannel(socket, workspace.key, raw.toString(), proof);
      encrypted = true;
      void sendFrame(socket, {
        type: 'hello',
        version: PROTOCOL_VERSION,
        hostname: 'legacy',
        platform: 'test',
      });
    } else if (readFrame(socket, raw).type === 'welcome') welcomed = true;
  });
  const list = async () =>
    (await (await fetch(base + '/api/workspaces', { headers })).json()).workspaces;
  try {
    await until(() => welcomed);
    assert.equal(
      service.gateway.list().find((item) => item.id === workspace.workspace.id)!.resources,
      null,
    );
    const sample = {
      sampledAt: Date.now() + 3600000,
      cpuPercent: 30,
      memory: { totalBytes: 1000, usedBytes: 750, usedPercent: 75 },
    };
    await sendFrame(socket, { type: 'host-resources', sample });
    await until(
      () => !!service.gateway.list().find((item) => item.id === workspace.workspace.id)?.resources,
    );
    const result = await list();
    const reported = result.find(
      (item: { id: string }) => item.id === workspace.workspace.id,
    ).resources;
    assert.equal(reported.cpuPercent, 30);
    assert.deepEqual(reported.memory, sample.memory);
    assert.ok(reported.ageMs >= 0 && reported.ageMs < 2000);
    assert.equal(
      result.find((item: { id: string }) => item.id === other.workspace.id).resources,
      null,
    );
    const now = Date.now();
    const clock = t.mock.method(Date, 'now', () => now + HOST_RESOURCE_STALE_MS + 1);
    const aged = await list();
    assert.ok(
      aged.find((item: { id: string }) => item.id === workspace.workspace.id).resources.ageMs >
        HOST_RESOURCE_STALE_MS,
    );
    clock.mock.restore();
    const closed = once(socket, 'close');
    socket.terminate();
    await closed;
    await until(
      () => !service.gateway.list().find((item) => item.id === workspace.workspace.id)?.online,
    );
    assert.equal(
      (await list()).find((item: { id: string }) => item.id === workspace.workspace.id).resources,
      null,
    );
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close');
      socket.terminate();
      await closed;
    }
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const hostResources of [false, true]) {
  test(`new clients keep working with a v3 Server that ${hostResources ? 'only supports CPU and memory' : 'does not support resource reports'}`, async () => {
    const f = fixture();
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const key = 'A'.repeat(43),
      workspaceId = 'local';
    const frames: Frame[] = [];
    wss.on('connection', (socket, request) => {
      socket.on('message', (raw) => {
        const frame = readFrame(socket, raw);
        frames.push(frame);
        if (frame.type === 'hello')
          void sendFrame(socket, {
            type: 'welcome',
            version: PROTOCOL_VERSION,
            workspaceId,
            ...(hostResources && { capabilities: { hostResources: true } }),
          });
      });
      startServerChannel(socket, key, request.headers.authorization!);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let client: MonitorClient | undefined;
    try {
      client = await MonitorClient.start({
        config: f.config,
        serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        workspaceId,
        key,
      });
      await until(() => client!.connected);
      if (hostResources) {
        await until(() => frames.some((frame) => frame.type === 'host-resources'));
        const first = frames.find((frame) => frame.type === 'host-resources')!;
        assert.equal('uptimeSeconds' in first.sample, false);
      } else {
        await delay(HOST_RESOURCE_INTERVAL_MS + 100);
        assert.deepEqual(
          frames.map((frame) => frame.type),
          ['hello'],
        );
      }
      assert.equal(client.connected, true);
    } finally {
      await client?.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.close();
      rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
