import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CompletionNotifications } from '../server/notifications/completions.js';
import type { CompletionEvent } from '../server/notifications/events.js';
import { createApp } from '../server/app.js';
import { createMonitorServer } from '../server/server-app.js';
import { MonitorClient } from '../server/client/connection.js';
import { requestGuard } from '../server/http/security.js';
import { fixture, ids } from './fixture.js';

function event(turnId = randomUUID()): CompletionEvent {
  return {
    kind: 'session.completed',
    sessionId: ids.modern,
    turnId,
    title: '已完成的会话',
    project: '测试项目',
    occurredAt: Date.now(),
    summary: 'PRIVATE_COMPLETION_SUMMARY',
  };
}
function complete(f: ReturnType<typeof fixture>, sessionId = ids.modern, status = 'completed') {
  const id = randomUUID(),
    now = Math.floor(Date.now() / 1000);
  f.hist
    .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
    .run(sessionId, id, 100, status, now - 1, now);
  return id;
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Completion notification timed out');
    await delay(20);
  }
}

test('completion feed baselines old events, pages equal timestamps without gaps and scopes deduplication by workspace', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const feed = new CompletionNotifications(db),
      workspace = { id: 'a', name: '电脑 A' };
    const old = event();
    feed.receive(workspace, { ...old, occurredAt: feed.since - 1 });
    assert.deepEqual(feed.page(), { cursor: 0, notifications: [], hasMore: false });
    const shared = event();
    feed.receive(workspace, shared);
    feed.receive(workspace, shared);
    feed.receive({ id: 'b', name: '电脑 B' }, shared);
    const baseline = feed.page();
    assert.equal(baseline.notifications.length, 0);
    const timestamp = Date.now();
    for (let i = 0; i < 60; i++) feed.receive(workspace, { ...event(), occurredAt: timestamp });
    const first = feed.page(baseline.cursor),
      second = feed.page(first.cursor);
    assert.equal(first.notifications.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(second.notifications.length, 10);
    assert.equal(second.hasMore, false);
    assert.equal(
      new Set([...first.notifications, ...second.notifications].map((row) => row.id)).size,
      60,
    );
    assert.equal(feed.page(0).notifications.filter((row) => row.workspaceId === 'b').length, 1);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_COMPLETION_SUMMARY|turnId|event_key/);
    assert.deepEqual(feed.page(second.cursor).notifications, []);
    assert.equal(feed.page(Number.MAX_SAFE_INTEGER).cursor, second.cursor);
    feed.forgetWorkspace('b');
    assert.ok(feed.page(0).notifications.every((row) => row.workspaceId !== 'b'));
  } finally {
    db.close();
  }
});

test('authenticated viewers poll completions with webhook disabled; old, failed, interrupted and internal turns are excluded', async () => {
  const f = fixture();
  f.config.pollMs = 60000;
  let sends = 0;
  const service = createApp(f.config, {
    webhookTransport: async () => {
      sends++;
      return Response.json({ code: 0 });
    },
  });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await service.auth.setup('owner', 'completion-notification-password');
    const viewerId = randomUUID();
    service.auth.db
      .prepare('INSERT INTO users VALUES(?,?,?,?,?)')
      .run(viewerId, 'reader', 'unused', 'viewer', Date.now());
    const headers = {
      Authorization: `Bearer ${service.auth.issue({ id: viewerId, username: 'reader', role: 'viewer' }, 'test').token}`,
    };
    await service.pollNotifications();
    const url = base + '/api/notifications/completions';
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(base + '/api/notifications', { headers })).status, 403);
    const start = await (await fetch(url, { headers })).json();
    assert.equal(start.notifications.length, 0);
    assert.equal(service.notifications.policy().enabled, false);
    assert.ok(service.notifications.policy().completionSince);
    complete(f);
    complete(f, ids.modern, 'failed');
    complete(f, ids.modern, 'interrupted');
    complete(f, ids.child);
    complete(f, ids.archived);
    await service.pollNotifications();
    await service.pollNotifications();
    const result = await fetch(url + `?after=${start.cursor}`, { headers });
    assert.match(result.headers.get('Cache-Control')!, /no-store/);
    const page = await result.json();
    assert.equal(page.notifications.length, 1);
    assert.equal(page.notifications[0].sessionId, ids.modern);
    assert.equal(page.notifications[0].workspaceId, 'local');
    assert.equal(sends, 0);
    assert.equal(service.notifications.state().deliveries.length, 0);
    for (const invalid of ['-1', '1.5', 'abc', '9007199254740992', '1&after=2'])
      assert.equal((await fetch(url + '?after=' + invalid, { headers })).status, 400, invalid);
    assert.equal((await fetch(url + `?after=${page.cursor}`, { headers })).status, 200);
    service.auth.db.prepare('DELETE FROM sessions WHERE user_id=?').run(viewerId);
    assert.equal((await fetch(url, { headers })).status, 401);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('browser-only completions traverse the encrypted client tunnel and lost acknowledgements survive both restarts', async () => {
  const f = fixture();
  f.config.pollMs = 60000;
  const config = { ...f.config, dataDir: path.join(f.root, 'central') };
  let service = createMonitorServer(config);
  let server = createServer(service.app);
  service.gateway.attach(server, requestGuard(config));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const workspace = service.gateway.store.create('远端电脑');
  let client: MonitorClient | undefined;
  let releasePolicy: (() => void) | undefined;
  const connect = async () => {
    const next = await MonitorClient.start({
      config: f.config,
      serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      workspaceId: workspace.workspace.id,
      key: workspace.key,
    });
    await until(() => next.connected && !!next.notifications.completions.state());
    return next;
  };
  const stop = async () => {
    await client?.close();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    client = await connect();
    const start = service.notifications.completions.page().cursor;
    const receive = service.notifications.receive.bind(service.notifications);
    service.notifications.receive = (origin, report) => {
      receive(origin, report);
      return false;
    };
    complete(f);
    await until(async () => {
      await client!.notifications.poll();
      return client!.notifications.completions.pending().length === 1;
    });
    assert.equal(client.notifications.completions.pending().length, 1);
    assert.equal(service.notifications.completions.page(start).notifications.length, 1);
    await stop();
    service = createMonitorServer(config);
    server = createServer(service.app);
    service.gateway.attach(server, requestGuard(config));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    client = await connect();
    await until(async () => {
      await client!.notifications.poll();
      return client!.notifications.completions.pending().length === 0;
    });
    assert.equal(client.notifications.completions.pending().length, 0);
    assert.equal(service.notifications.completions.page(start).notifications.length, 1);
    assert.equal(service.notifications.state().deliveries.length, 0);
    // A webhook generation change does not reset or lose browser-only completions.
    complete(f);
    const configure = client.notifications.configure.bind(client.notifications);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    client.notifications.configure = async (policy, baseline) => {
      entered();
      await gate;
      return configure(policy, baseline);
    };
    let configured = false;
    const configuration = service.notifications
      .configure({ enabled: false, publicUrl: '' })
      .then(() => {
        configured = true;
      });
    await started;
    // A stale report can request the same policy while its first baseline is still being applied.
    const duplicate = service.gateway.configureNotifications(service.notifications.policy(), false);
    await delay(30);
    assert.equal(
      configured,
      false,
      'a repeated policy request must wait for the actual client acknowledgement',
    );
    assert.ok(releasePolicy);
    assert.ok(releasePolicy);
    releasePolicy();
    await Promise.all([configuration, duplicate]);
    await client.notifications.poll();
    assert.equal(service.notifications.completions.page(start).notifications.length, 2);
  } finally {
    releasePolicy?.();
    await stop();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
