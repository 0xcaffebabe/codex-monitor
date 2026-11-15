import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fixture, ids } from './fixture.js';
import { createMonitorServer } from '../server/server-app.js';
import { MonitorClient } from '../server/client/connection.js';
import { AuthStore } from '../server/auth.js';
import { NotificationStore } from '../server/notifications/store.js';
import type { WebhookTransport } from '../server/notifications/lark.js';
import { frameSchema, workspacePath } from '../server/transport/protocol.js';

const webhook =
  'https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const settings = {
  enabled: true,
  provider: 'lark',
  webhookUrl: webhook,
  signingSecret: 'server-only-signing-secret',
  publicUrl: 'https://monitor.example.com/',
} as const;

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Notification integration timed out');
    await delay(20);
  }
}
function complete(f: ReturnType<typeof fixture>, turnId: string, text: string) {
  const now = Math.floor(Date.now() / 1000);
  f.hist
    .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
    .run(ids.modern, turnId, 100, 'completed', now - 1, now);
  f.hist
    .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
    .run(
      ids.modern,
      turnId,
      randomUUID(),
      100,
      Date.now(),
      JSON.stringify({ type: 'agentMessage', phase: 'final_answer', text }),
      null,
      null,
    );
}
async function central(f: ReturnType<typeof fixture>, transport: WebhookTransport, port = 0) {
  const service = createMonitorServer(
    {
      ...f.config,
      dataDir: path.join(f.root, 'central'),
      codexHome: path.join(f.root, 'server-has-no-codex'),
      pollMs: 60000,
    },
    { webhookTransport: transport },
  );
  const server = createServer(service.app);
  service.gateway.attach(server, () => true);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const actualPort = (server.address() as { port: number }).port;
  return {
    service,
    port: actualPort,
    base: `http://127.0.0.1:${actualPort}`,
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('Server owns one configuration and delivers events from two encrypted clients with workspace-scoped identities', async () => {
  const a = fixture(),
    b = fixture();
  a.config.pollMs = b.config.pollMs = 40;
  const received: any[] = [];
  const receiver = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    received.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"code":0}');
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const server = await central(a, (url, init) => {
    assert.equal(url, webhook);
    return fetch(`http://127.0.0.1:${(receiver.address() as { port: number }).port}`, init);
  });
  const clients: MonitorClient[] = [];
  try {
    const owner = await server.service.auth.setup('owner', 'central-notification-password');
    const headers = {
      Authorization: `Bearer ${server.service.auth.issue(owner, 'test').token}`,
      'Content-Type': 'application/json',
    };
    // Settings and test delivery are available before any workspace has connected.
    assert.equal((await fetch(server.base + '/api/notifications')).status, 401);
    const saved = await fetch(server.base + '/api/notifications', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...settings, enabled: false }),
    });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), /server-only-signing-secret|aaaaaaaa-bbbb/);
    assert.equal(
      (await fetch(server.base + '/api/notifications/test', { method: 'POST', headers })).status,
      200,
    );
    assert.equal(received.length, 1);

    // Upgrade retires a previous remote client's sender and clears its provider credentials.
    const legacy = new AuthStore(a.config.dataDir);
    const oldNotifications = new NotificationStore(legacy.db);
    oldNotifications.save(
      { ...settings, webhookUrl: webhook.replace('aaaaaaaa', 'bbbbbbbb') },
      Date.now(),
      true,
    );
    oldNotifications.enqueue(
      { key: 'old', kind: 'session.completed', title: 'old', message: 'old' },
      1,
    );
    legacy.close();
    const wa = server.service.gateway.store.create('电脑 A'),
      wb = server.service.gateway.store.create('电脑 B');
    for (const [f, workspace] of [
      [a, wa],
      [b, wb],
    ] as const)
      clients.push(
        await MonitorClient.start({
          config: f.config,
          serverUrl: server.base,
          workspaceId: workspace.workspace.id,
          key: workspace.key,
        }),
      );
    await until(() => clients.every((client) => client.connected));
    await server.service.notifications.configure(settings);
    const clientDb = new DatabaseSync(path.join(a.config.dataDir, 'monitor.sqlite'), {
      readOnly: true,
    });
    try {
      const retired = clientDb
        .prepare('SELECT enabled,webhook_url,signing_secret FROM notification_settings')
        .get()!;
      assert.equal(retired.enabled, 0);
      assert.equal(retired.webhook_url, '');
      assert.equal(retired.signing_secret, '');
      assert.equal(
        clientDb.prepare('SELECT status FROM notification_deliveries WHERE event_key=?').get('old')!
          .status,
        'cancelled',
      );
    } finally {
      clientDb.close();
    }
    assert.equal(
      (await fetch(`${server.base}/api/workspaces/${wa.workspace.id}/notifications`, { headers }))
        .status,
      404,
    );

    const turnId = randomUUID();
    complete(a, turnId, 'A 的完成结果');
    complete(b, turnId, 'B 的完成结果');
    await until(
      () =>
        server.service.notifications
          .state()
          .deliveries.filter((d) => d.kind === 'session.completed').length === 2,
    );
    await server.service.notifications.poll();
    await server.service.notifications.poll();
    assert.equal(received.length, 3, 'both clients use the server transport');
    const deliveries = server.service.notifications
      .state()
      .deliveries.filter((d) => d.kind === 'session.completed');
    assert.deepEqual(
      new Set(deliveries.map((d) => d.workspaceId)),
      new Set([wa.workspace.id, wb.workspace.id]),
    );
    assert.ok(deliveries.every((d) => d.status === 'sent'));
    assert.ok(
      received.some(
        (message) =>
          message.content.text.includes('电脑 A') &&
          message.content.text.includes('A 的完成结果') &&
          message.content.text.includes(`workspace=${wa.workspace.id}`),
      ),
    );
    assert.ok(
      received.some(
        (message) =>
          message.content.text.includes('电脑 B') &&
          message.content.text.includes('B 的完成结果') &&
          message.content.text.includes(`workspace=${wb.workspace.id}`),
      ),
    );
  } finally {
    for (const client of clients) await client.close();
    await server.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    for (const f of [a, b]) {
      f.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('lost report acknowledgements replay safely after both sides restart and Server retries with Client stopped', async () => {
  const f = fixture();
  f.config.pollMs = 60000;
  let calls = 0;
  const transport: WebhookTransport = async () =>
    Response.json({ code: 0 }, { status: ++calls === 1 ? 503 : 200 });
  let server = await central(f, transport);
  let client: MonitorClient | undefined;
  try {
    const workspace = server.service.gateway.store.create('持久上报测试');
    client = await MonitorClient.start({
      config: f.config,
      serverUrl: server.base,
      workspaceId: workspace.workspace.id,
      key: workspace.key,
      reconnectMs: 5000,
    });
    await until(() => client!.connected);
    await server.service.notifications.configure(settings);
    const receive = server.service.notifications.receive.bind(server.service.notifications);
    let dropped = false;
    server.service.notifications.receive = (origin, report) => {
      const accepted = receive(origin, report);
      if (!dropped && report.events.some((event) => event.kind === 'session.completed')) {
        dropped = true;
        server.service.gateway.disconnect(origin.id); // Durable insert succeeded; its acknowledgement is lost.
      }
      return accepted;
    };
    complete(f, randomUUID(), '确认丢失后也只推送一次');
    await until(async () => {
      await client!.notifications.poll();
      return dropped && !client!.connected;
    });
    assert.equal(client.notifications.store.pending().length, 1);
    await client.close();
    client = undefined;
    await server.service.notifications.poll();
    assert.equal(server.service.notifications.state().deliveries[0].status, 'pending');
    assert.equal(calls, 1);
    const port = server.port;
    await server.close();
    server = await central(f, transport, port);
    client = await MonitorClient.start({
      config: f.config,
      serverUrl: server.base,
      workspaceId: workspace.workspace.id,
      key: workspace.key,
    });
    await until(() => client!.connected && client!.notifications.store.pending().length === 0);
    assert.equal(
      server.service.notifications.state().deliveries.length,
      1,
      'replayed event is deduplicated durably',
    );
    await client.close();
    client = undefined;
    server.service.auth.db.prepare('UPDATE notification_deliveries SET next_attempt_at=0').run();
    await server.service.notifications.poll();
    assert.equal(calls, 2);
    assert.equal(server.service.notifications.state().deliveries[0].status, 'sent');
    assert.equal(server.service.notifications.state().deliveries[0].attempts, 2);
  } finally {
    await client?.close();
    await server.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('notification frames carry bounded events only and cannot override the authenticated workspace or destination', () => {
  const frame = {
    type: 'notification-report',
    id: randomUUID(),
    report: {
      revision: 1,
      monitorError: '',
      events: [
        {
          kind: 'session.completed',
          sessionId: ids.modern,
          title: '完成',
          project: '测试',
          turnId: 'turn-1',
          occurredAt: Date.now(),
          summary: '结果',
        },
      ],
    },
  };
  assert.ok(frameSchema.safeParse(frame).success);
  assert.equal(
    frameSchema.safeParse({ ...frame, report: { ...frame.report, webhookUrl: webhook } }).success,
    false,
  );
  assert.equal(
    frameSchema.safeParse({
      ...frame,
      report: {
        ...frame.report,
        events: [{ ...frame.report.events[0], workspaceId: randomUUID() }],
      },
    }).success,
    false,
  );
  assert.equal(
    frameSchema.safeParse({
      ...frame,
      report: { ...frame.report, events: Array(5).fill(frame.report.events[0]) },
    }).success,
    false,
  );
  assert.equal(workspacePath('GET', '/api/notifications'), false);
  assert.equal(workspacePath('POST', '/api/notifications/test'), false);
});

test('upgrading an existing standalone database preserves its configuration, pending deliveries and deduplication keys', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE notification_settings (
      id INTEGER PRIMARY KEY, enabled INTEGER, webhook_url TEXT, signing_secret TEXT, public_url TEXT,
      enabled_at INTEGER, scan_at INTEGER, revision INTEGER, input_since INTEGER
    );
    CREATE TABLE notification_deliveries (
      id TEXT PRIMARY KEY, event_key TEXT UNIQUE, kind TEXT, session_id TEXT, title TEXT, message TEXT,
      status TEXT, attempts INTEGER, error TEXT, created_at INTEGER, sent_at INTEGER, next_attempt_at INTEGER, revision INTEGER
    );`);
    db.prepare('INSERT INTO notification_settings VALUES(1,1,?,?,?,1000,2000,7,1001)').run(
      webhook,
      settings.signingSecret,
      settings.publicUrl,
    );
    db.prepare(
      "INSERT INTO notification_deliveries VALUES('old','session:turn','session.completed','session','title','body','pending',1,'',1000,NULL,5000,7)",
    ).run();
    let store = new NotificationStore(db);
    assert.equal(store.config().webhookUrl, webhook);
    assert.equal(store.config().signingSecret, settings.signingSecret);
    assert.equal(store.config().revision, 7);
    assert.equal(store.has('local:session:turn'), true);
    assert.equal(store.history()[0].status, 'pending');
    assert.equal(store.history()[0].workspaceId, 'local');
    assert.equal(store.history()[0].attempts, 1);
    store = new NotificationStore(db);
    assert.equal(store.has('local:session:turn'), true, 'migration does not namespace a key twice');
    assert.equal(store.has('local:local:session:turn'), false);
  } finally {
    db.close();
  }
});
