import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { MonitorClient } from '../server/client/connection.js';
import {
  PROTOCOL_VERSION,
  readFrame,
  sendFrame,
  startServerChannel,
} from '../server/transport/protocol.js';

async function probe(
  t: TestContext,
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-connection-'));
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', upgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let disconnected!: (reason: string) => void;
  let connected!: () => void;
  const failure = new Promise<string>((resolve) => {
    disconnected = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const key = randomBytes(32).toString('base64url');
  const workspaceId = randomUUID();
  const client = await MonitorClient.start({
    config: {
      dataDir: path.join(root, 'data'),
      codexHome: path.join(root, 'absent'),
      host: '127.0.0.1',
      port: 0,
      origins: [],
      sessionDays: 1,
      pollMs: 500,
      secure: false,
      desktopAutoStart: false,
    },
    serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    workspaceId,
    key,
    reconnectMs: 50,
    onStatus: (status, reason) => {
      if (status === 'disconnected') disconnected(reason || '');
      else connected();
    },
  });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { client, server, key, workspaceId, failure, ready };
}

test(
  'client reports HTTP handshake rejections instead of only WebSocket 1006',
  { timeout: 20000 },
  async (t) => {
    for (const [status, hint] of [
      [401, /工作空间.*协议版本.*系统时间/],
      [403, /MONITOR_ORIGINS/],
      [404, /连接接口/],
      [409, /已有 Client 在线/],
      [502, /Upgrade/],
    ] as const) {
      await t.test(`HTTP ${status}`, async (t) => {
        const f = await probe(t, (_req, socket) => {
          socket.end(
            `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
        });
        const reason = await f.failure;
        assert.match(reason, new RegExp(`WebSocket 1006: HTTP ${status}`));
        assert.match(reason, hint);
        assert.ok(!reason.includes(f.key));
      });
    }
  },
);

test(
  'client reconnects after an HTTP rejection and completes the encrypted handshake',
  { timeout: 15000 },
  async (t) => {
    const wss = new WebSocketServer({ noServer: true });
    t.after(() => wss.close());
    let reject = true;
    const f = await probe(t, (req, socket, head) => {
      if (reject) {
        socket.end('HTTP/1.1 401 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => {});
        startServerChannel(ws, f.key, req.headers.authorization!);
        ws.on('message', (raw) => {
          assert.equal(readFrame(ws, raw).type, 'hello');
          void sendFrame(ws, {
            type: 'welcome',
            version: PROTOCOL_VERSION,
            workspaceId: f.workspaceId,
          });
        });
      });
    });
    assert.match(await f.failure, /HTTP 401/);
    reject = false;
    await f.ready;
    assert.equal(f.client.connected, true);
  },
);

test(
  'client identifies a protocol mismatch from a rejected HTTP handshake',
  { timeout: 15000 },
  async (t) => {
    const f = await probe(t, (_req, socket) => {
      socket.end(
        `HTTP/1.1 401 Rejected\r\nConnection: close\r\nContent-Length: 0\r\nX-Codex-Monitor-Protocol: ${PROTOCOL_VERSION + 1}\r\n\r\n`,
      );
    });
    const reason = await f.failure;
    assert.match(reason, /HTTP 401：协议版本不一致/);
    assert.match(reason, new RegExp(`Server ${PROTOCOL_VERSION + 1}，Client ${PROTOCOL_VERSION}`));
  },
);

test(
  'client preserves the network error code when the connection is reset',
  { timeout: 15000 },
  async (t) => {
    const f = await probe(t, (_req, socket) => socket.destroy());
    assert.match(await f.failure, /WebSocket 1006: ECONNRESET: socket hang up/);
  },
);

test('client explains a server channel protocol mismatch', { timeout: 15000 }, async (t) => {
  const wss = new WebSocketServer({ noServer: true });
  t.after(() => wss.close());
  const f = await probe(t, (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'channel', version: PROTOCOL_VERSION - 1 }));
    });
  });
  const reason = await f.failure;
  assert.match(reason, /WebSocket 1008: 协议版本不一致/);
  assert.match(reason, new RegExp(`Server ${PROTOCOL_VERSION - 1}，Client ${PROTOCOL_VERSION}`));
});

test(
  'client preserves the server close reason while redacting keys and control characters',
  { timeout: 15000 },
  async (t) => {
    const wss = new WebSocketServer({ noServer: true });
    t.after(() => wss.close());
    const f = await probe(t, (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => {});
        ws.close(1012, `Server restarting\n${f.key}`);
      });
    });
    const reason = await f.failure;
    assert.match(reason, /WebSocket 1012: Server restarting \[redacted\]/);
    assert.ok(!reason.includes(f.key));
    assert.ok(!reason.includes('\n'));
  },
);
