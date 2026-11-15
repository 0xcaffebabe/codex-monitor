import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { createMonitorServer } from '../server/server-app.js';
import {
  connectionProof,
  PROTOCOL_VERSION,
  MAX_BODY,
  readFrame,
  sendFrame,
  startClientChannel,
  type Frame,
} from '../server/transport/protocol.js';

async function gatewayFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-gateway-'));
  const service = createMonitorServer({
    dataDir: root,
    codexHome: path.join(root, 'absent'),
    host: '127.0.0.1',
    port: 0,
    origins: [],
    sessionDays: 1,
    pollMs: 500,
    secure: false,
  });
  const server = createServer(service.app);
  service.gateway.attach(server, () => true);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'gateway-test-password!');
  const headers = { Authorization: `Bearer ${service.auth.issue(owner, 'test').token}` };
  const workspace = service.gateway.store.create('test');
  const proof = connectionProof(workspace.key, workspace.workspace.id);
  const socket = new WebSocket(
    base.replace('http:', 'ws:') + '/api/clients/connect?workspace=' + workspace.workspace.id,
    { headers: { Authorization: proof } },
  );
  const requests: Extract<Frame, { type: 'request' }>[] = [];
  let encrypted = false;
  let ready!: () => void;
  const connected = new Promise<void>((resolve) => {
    ready = resolve;
  });
  socket.on('error', () => {});
  socket.on('message', (raw) => {
    if (!encrypted) {
      startClientChannel(socket, workspace.key, raw.toString(), proof);
      encrypted = true;
      void sendFrame(socket, {
        type: 'hello',
        version: PROTOCOL_VERSION,
        hostname: 'test',
        platform: 'test',
      });
      return;
    }
    const frame = readFrame(socket, raw);
    if (frame.type === 'welcome') ready();
    if (frame.type === 'request') requests.push(frame);
  });
  await connected;
  return {
    url: base + '/api/workspaces/' + workspace.workspace.id,
    headers,
    requests,
    socket,
    async untilRequests(count: number) {
      const deadline = Date.now() + 3000;
      while (requests.length < count) {
        if (Date.now() > deadline) throw new Error('Missing tunneled request');
        await delay(10);
      }
    },
    async close() {
      socket.terminate();
      await once(socket, 'close');
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('gateway rejects binary bodies outside uploads before forwarding or buffering them', async () => {
  const f = await gatewayFixture();
  try {
    for (const route of ['/sessions/example/messages', '/overview', '/uploads/example']) {
      const response = await fetch(f.url + route, {
        method: 'POST',
        headers: { ...f.headers, 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('binary'),
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(response.status, 415, route);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test('gateway holds upload capacity until the client response finishes and releases it on cancel', async () => {
  const f = await gatewayFixture();
  const abort = new AbortController();
  const post = (name: string) =>
    fetch(f.url + '/uploads?name=' + name, {
      method: 'POST',
      headers: { ...f.headers, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('upload'),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
  const pending: Promise<unknown>[] = [];
  try {
    pending.push(
      post('one').catch(() => {}),
      post('two').catch(() => {}),
    );
    await f.untilRequests(2);
    const third = await post('three');
    assert.equal(third.status, 429);
    await third.arrayBuffer();
    const id = f.requests[0].id;
    await sendFrame(f.socket, { type: 'response', id, status: 201, headers: {} });
    await sendFrame(f.socket, { type: 'end', id });
    await pending[0];
    pending.push(post('replacement').catch(() => {}));
    await f.untilRequests(3);
  } finally {
    abort.abort();
    await Promise.all(pending);
    await f.close();
  }
});

test('oversized chunked uploads receive a JSON 413 instead of a connection reset', async () => {
  const f = await gatewayFixture();
  try {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        f.url + '/uploads?name=large',
        {
          method: 'POST',
          headers: { ...f.headers, 'Content-Type': 'application/octet-stream' },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        },
      );
      request.on('error', reject);
      request.end(Buffer.alloc(MAX_BODY + 1));
    });
    assert.equal(response.status, 413);
    assert.match(JSON.parse(response.body).error, /20 MB/);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});
