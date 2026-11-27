import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { setImmediate as flush, setTimeout as delay } from 'node:timers/promises';
import { CompletionNotifications } from '../server/notifications/completions.js';
import { NotificationService } from '../server/notifications/service.js';
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

function publish(
  feed: CompletionNotifications,
  workspace: { id: string; name: string },
  completion = event(),
) {
  const notification = feed.record(workspace, completion);
  if (notification) feed.publish([notification]);
  return notification;
}

test('shared pending snapshots close observed IDs without deleting concurrent completions or requeuing retries', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const feed = new CompletionNotifications(db),
      workspace = { id: 'a', name: '电脑 A' };
    publish(feed, workspace, { ...event(), occurredAt: feed.since - 1 });
    assert.equal(feed.snapshot().notifications.length, 0);
    const shared = event();
    publish(feed, workspace, shared);
    publish(feed, workspace, shared);
    publish(feed, { id: 'b', name: '电脑 B' }, shared);
    const observed = feed.snapshot();
    assert.equal(observed.notifications.length, 2, 'first open receives all pending notices');
    const nextTurn = publish(feed, workspace)!;
    const afterClose = feed.dismiss(
      observed.generation,
      observed.notifications.map((item) => item.id),
    )!;
    assert.deepEqual(
      afterClose.notifications,
      [nextTurn],
      'close all cannot remove a concurrent new turn',
    );
    assert.ok(afterClose.revision > observed.revision);
    publish(feed, workspace, shared);
    publish(feed, { id: 'b', name: '电脑 B' }, shared);
    assert.deepEqual(feed.snapshot(), afterClose, 'closed events remain deduplicated');
    assert.deepEqual(
      feed.dismiss(
        observed.generation,
        observed.notifications.map((item) => item.id),
      ),
      afterClose,
      'retrying an acknowledged deletion is idempotent',
    );
    assert.doesNotMatch(JSON.stringify(afterClose), /PRIVATE_COMPLETION_SUMMARY|turnId|event_key/);
    publish(feed, { id: 'b', name: '电脑 B' });
    feed.forgetWorkspace('b');
    assert.ok(feed.snapshot().notifications.every((row) => row.workspaceId !== 'b'));
    for (let i = 0; i < 60; i++) publish(feed, workspace);
    assert.equal(feed.snapshot().notifications.length, 50, 'pending memory is bounded');
  } finally {
    db.close();
  }
});

test('Server restart empties pending memory, retains deduplication receipts and rejects old-page deletions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const workspace = { id: 'local', name: '本机' },
      previous = new CompletionNotifications(db);
    const old = event();
    publish(previous, workspace, old);
    const oldPage = previous.snapshot();
    const restarted = new CompletionNotifications(db);
    assert.notEqual(restarted.snapshot().generation, oldPage.generation);
    assert.equal(
      restarted.snapshot().notifications.length,
      0,
      'persistent event rows never restore pending notices',
    );
    publish(restarted, workspace, old);
    assert.equal(
      restarted.snapshot().notifications.length,
      0,
      'a replay cannot restore an old event',
    );
    const fresh = publish(restarted, workspace)!;
    assert.ok(fresh.id > oldPage.notifications[0].id);
    assert.equal(restarted.dismiss(oldPage.generation, [fresh.id]), undefined);
    assert.deepEqual(restarted.snapshot().notifications, [fresh]);
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
    assert.equal((await (await fetch(url, { headers })).json()).notifications.length, 0);
    assert.equal(service.notifications.policy().enabled, false);
    assert.ok(service.notifications.policy().completionSince);
    complete(f);
    complete(f, ids.modern, 'failed');
    complete(f, ids.modern, 'interrupted');
    complete(f, ids.child);
    complete(f, ids.archived);
    await service.pollNotifications();
    await service.pollNotifications();
    const result = await fetch(url, { headers });
    assert.match(result.headers.get('Cache-Control')!, /no-store/);
    const page = await result.json();
    assert.equal(page.notifications.length, 1);
    assert.equal(page.notifications[0].sessionId, ids.modern);
    assert.equal(page.notifications[0].workspaceId, 'local');
    assert.equal(sends, 0);
    assert.equal(service.notifications.state().deliveries.length, 0);
    const dismissal = { generation: page.generation, ids: [page.notifications[0].id] };
    const close = (
      body: unknown,
      extraHeaders: Record<string, string> = {},
      authenticated = true,
    ) =>
      fetch(url + '/dismiss', {
        method: 'POST',
        headers: {
          ...(authenticated ? headers : {}),
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await close(dismissal, {}, false)).status, 401);
    assert.equal(
      (
        await close(dismissal, {
          Origin: 'http://untrusted.example',
          'Sec-Fetch-Site': 'cross-site',
        })
      ).status,
      403,
    );
    for (const invalid of [
      {},
      { ...dismissal, generation: 'invalid' },
      { ...dismissal, ids: [] },
      { ...dismissal, ids: [0] },
      { ...dismissal, ids: [-1] },
      { ...dismissal, ids: [1.5] },
      { ...dismissal, ids: [Number.MAX_SAFE_INTEGER + 1] },
      { ...dismissal, ids: Array(51).fill(1) },
      { ...dismissal, all: true },
    ])
      assert.equal((await close(invalid)).status, 400, JSON.stringify(invalid));
    assert.equal((await close({ ...dismissal, generation: randomUUID() })).status, 409);
    assert.equal((await (await fetch(url, { headers })).json()).notifications.length, 1);
    const closed = await close(dismissal);
    assert.equal(closed.status, 200, 'authenticated viewers can dismiss shared notices');
    assert.equal((await closed.json()).notifications.length, 0);
    assert.equal((await close(dismissal)).status, 200);
    service.auth.db.prepare('DELETE FROM sessions WHERE user_id=?').run(viewerId);
    assert.equal((await fetch(url, { headers })).status, 401);
    assert.equal((await close(dismissal)).status, 401);
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
    const generation = service.notifications.completions.snapshot().generation;
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
    const first = service.notifications.completions.snapshot();
    assert.equal(first.notifications.length, 1);
    service.notifications.completions.dismiss(
      first.generation,
      first.notifications.map((item) => item.id),
    );
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
    assert.notEqual(service.notifications.completions.snapshot().generation, generation);
    assert.equal(
      service.notifications.completions.snapshot().notifications.length,
      0,
      'an unacknowledged report must not resurrect a notice closed before restart',
    );
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
    releasePolicy();
    await Promise.all([configuration, duplicate]);
    await client.notifications.poll();
    assert.equal(service.notifications.completions.snapshot().notifications.length, 1);
  } finally {
    releasePolicy?.();
    await stop();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a rolled-back report never publishes notices or consumes their deduplication receipts', async () => {
  const db = new DatabaseSync(':memory:');
  const service = new NotificationService(db, 60000, async () => Response.json({ code: 0 }));
  try {
    await service.configure({
      enabled: true,
      completionMode: 'all',
      publicUrl: '',
      webhookUrl:
        'https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const completion = event();
    const report = {
      revision: service.policy().revision,
      events: [completion],
      monitorError: '' as const,
    };
    const enqueue = service.store.enqueue.bind(service.store);
    service.store.enqueue = () => {
      throw new Error('simulated transaction failure');
    };
    assert.throws(() => service.receive({ id: 'local', name: '本机' }, report), /simulated/);
    assert.equal(service.completions.snapshot().notifications.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_notifications').get()!.n, 0);
    service.store.enqueue = enqueue;
    assert.equal(service.receive({ id: 'local', name: '本机' }, report), true);
    assert.equal(service.completions.snapshot().notifications.length, 1);
    assert.equal(service.state().deliveries.length, 1);
  } finally {
    await service.close();
    db.close();
  }
});

test('watched completion delivery is workspace-scoped and does not replay pre-watch results', async () => {
  const db = new DatabaseSync(':memory:');
  const service = new NotificationService(db, 60000, async () => Response.json({ code: 0 }));
  try {
    await service.configure({
      enabled: true,
      publicUrl: '',
      webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const workspace = { id: 'local', name: '本机' };
    const completion = { ...event(), occurredAt: Date.now() };
    const report = (turn: typeof completion) => ({ revision: service.policy().revision, events: [turn], monitorError: '' as const });
    service.receive(workspace, report(completion));
    assert.equal(service.state().deliveries.length, 0);
    service.store.watch(workspace.id, completion.sessionId, true);
    const next = { ...completion, turnId: 'next-turn', occurredAt: Date.now() + 1 };
    service.receive({ id: 'remote', name: '远端' }, report(next));
    assert.equal(service.state().deliveries.length, 0);
    service.receive(workspace, report(next));
    assert.equal(service.state().deliveries[0].status, 'pending');
    service.store.watch(workspace.id, completion.sessionId, false);
    assert.equal(service.state().deliveries[0].status, 'cancelled');
  } finally {
    await service.close();
    db.close();
  }
});

test('Lark read scans dismiss only the matching browser notice and stop querying dismissed cards', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const db = new DatabaseSync(':memory:');
  let sent = 0;
  const queried: string[] = [];
  const read = new Set<string>();
  let failNextRead = '';
  const service = new NotificationService(db, 60000, async (url, init) => {
    const endpoint = new URL(String(url));
    if (endpoint.pathname.endsWith('/tenant_access_token/internal'))
      return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer token');
    if (endpoint.pathname === '/open-apis/im/v1/messages')
      return Response.json({ code: 0, data: { message_id: `om_card_${++sent}` } });
    const match = endpoint.pathname.match(/\/messages\/(om_card_\d+)\/read_users$/);
    assert.ok(match);
    assert.equal(init?.method, 'GET');
    assert.equal(endpoint.searchParams.get('user_id_type'), 'open_id');
    assert.equal(endpoint.searchParams.get('page_size'), '1');
    const [, messageId] = match;
    queried.push(messageId);
    if (failNextRead === messageId) {
      failNextRead = '';
      return new Response(null, { status: 503 });
    }
    return Response.json({
      code: 0,
      data: { items: read.has(messageId) ? [{ user_id: 'ou_reader' }] : [] },
    });
  });
  try {
    await service.configure({
      enabled: true,
      mode: 'app',
      appId: 'cli_monitor',
      appSecret: 'test',
      chatId: 'oc_monitor',
      completionMode: 'all',
      publicUrl: '',
    });
    const first = event();
    for (const [workspaceId, completion] of [
      ['local', first],
      ['local', event()],
      ['remote', first],
    ] as const) {
      service.receive({ id: workspaceId, name: workspaceId }, {
        revision: service.policy().revision,
        events: [completion],
        monitorError: '',
      });
      await service.poll();
    }
    assert.equal(sent, 3);
    const initial = service.completions.snapshot();
    assert.equal(initial.notifications.length, 3);
    const [firstNotice, secondNotice, remoteNotice] = initial.notifications;

    t.mock.timers.tick(9999);
    assert.deepEqual(queried, []);
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(queried.splice(0), ['om_card_1', 'om_card_2', 'om_card_3']);
    assert.deepEqual(service.completions.snapshot(), initial);

    service.completions.dismiss(initial.generation, [remoteNotice.id]);
    read.add('om_card_1');
    failNextRead = 'om_card_2';
    t.mock.timers.tick(10000);
    await flush();
    assert.deepEqual(queried.splice(0), ['om_card_1', 'om_card_2']);
    assert.deepEqual(service.completions.snapshot().notifications, [secondNotice]);
    assert.ok(service.completions.snapshot().revision > initial.revision);

    read.add('om_card_2');
    t.mock.timers.tick(10000);
    await flush();
    assert.deepEqual(queried.splice(0), ['om_card_2']);
    assert.deepEqual(service.completions.snapshot().notifications, []);

    t.mock.timers.tick(20000);
    await flush();
    assert.deepEqual(queried, []);
    assert.notEqual(firstNotice.id, secondNotice.id);
  } finally {
    await service.close();
    db.close();
  }
});
