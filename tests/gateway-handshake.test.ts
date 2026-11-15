import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createMonitorServer } from '../server/server-app.js';
import { PROTOCOL_VERSION } from '../server/transport/protocol.js';

test(
  'a rejected upgrade advertises the protocol and survives a raw socket reset',
  { timeout: 15000 },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-handshake-'));
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
    let upgradeSocket: Duplex | undefined;
    server.once('upgrade', (_req, socket) => {
      upgradeSocket = socket;
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    t.after(async () => {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const ws = new WebSocket(
      base.replace('http:', 'ws:') + '/api/clients/connect?workspace=missing',
    );
    ws.on('error', () => {});
    const response = await new Promise<{ status?: number; protocol?: string | string[] }>(
      (resolve) => {
        ws.on('unexpected-response', (_request, response) => {
          response.resume();
          ws.terminate();
          resolve({
            status: response.statusCode,
            protocol: response.headers['x-codex-monitor-protocol'],
          });
        });
      },
    );
    assert.equal(response.status, 401);
    assert.equal(response.protocol, String(PROTOCOL_VERSION));
    assert.ok(upgradeSocket);
    // Reproduce the raw TCP error seen when a client/proxy aborts a rejected upgrade.
    assert.doesNotThrow(() =>
      upgradeSocket!.emit(
        'error',
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      ),
    );
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) });
    assert.equal(health.status, 200, 'the HTTP server must remain available after the reset');
  },
);
