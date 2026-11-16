import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeApprovals } from '../server/native-approvals.js';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop, projectId } from './control-fixture.js';
import { createMonitorServer } from '../server/server-app.js';
import { MonitorClient } from '../server/client/connection.js';
import { requestGuard } from '../server/http/security.js';
import type { SessionCreationSettings } from '../src/types.js';

const params = (threadId = ids.modern) => ({
  threadId,
  turnId: 'turn',
  itemId: 'item',
  cwd: '/project',
  reason: '需要权限才能完成任务',
});

test('permissions wait for a human, grant only the requested profile for this turn, and replay one decision', async () => {
  const approvals = new NativeApprovals();
  const controller = new AbortController();
  const permissions = {
    fileSystem: {
      write: ['/project/output.txt'],
      read: null,
      entries: [{ access: 'write', path: { type: 'path', path: '/project/nested' } }],
    },
    network: { enabled: true },
  };
  let replies = 0;
  const result = approvals
    .request('item/permissions/requestApproval', { ...params(), permissions }, controller.signal)
    .then((value) => {
      replies++;
      return value;
    });
  const [pending] = approvals.list(ids.modern);
  assert.equal(replies, 0);
  assert.equal(pending.scope, '仅本轮有效');
  assert(
    pending.details.some(
      (detail) => detail.label === '网络访问' && detail.value === '允许访问网络',
    ),
  );
  assert(pending.details.some((detail) => detail.value === '/project/output.txt'));
  assert(pending.details.some((detail) => detail.value === '/project/nested'));
  assert.throws(
    () => approvals.answer(ids.legacy, pending.id, 'accept'),
    (error: any) => error.status === 404,
  );
  const receipt = approvals.answer(ids.modern, pending.id, 'accept');
  assert.deepEqual(approvals.answer(ids.modern, pending.id, 'accept'), receipt);
  assert.throws(
    () => approvals.answer(ids.modern, pending.id, 'decline'),
    (error: any) => error.status === 409,
  );
  assert.deepEqual(await result, { permissions, scope: 'turn' });
  assert.equal(replies, 1);
  assert.equal(approvals.list(ids.modern).length, 0);
  approvals.close();
});

test('command and file approvals preserve review details without persistent command or session grants', async () => {
  const approvals = new NativeApprovals();
  const controller = new AbortController();
  const command = approvals.request(
    'item/commandExecution/requestApproval',
    {
      ...params(),
      command: 'curl https://example.com',
      availableDecisions: [
        'accept',
        'decline',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl'] } },
      ],
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
    },
    controller.signal,
  );
  const first = approvals.list(ids.modern)[0];
  assert(first.details.some((detail) => detail.value === 'curl https://example.com'));
  assert(first.details.some((detail) => detail.value === 'https://example.com'));
  approvals.answer(ids.modern, first.id, 'accept');
  assert.deepEqual(await command, { decision: 'accept' });
  const file = approvals.request(
    'item/fileChange/requestApproval',
    { ...params(), grantRoot: '/project' },
    controller.signal,
    [{ path: '/project/a.txt', diff: '-old\n+new', kind: { type: 'update' } }],
  );
  const second = approvals.list(ids.modern)[0];
  assert(second.details.some((detail) => detail.value === '-old\n+new'));
  approvals.answer(ids.modern, second.id, 'decline');
  assert.deepEqual(await file, { decision: 'decline' });
  const late = approvals.request('item/fileChange/requestApproval', params(), controller.signal);
  const waiting = approvals.list(ids.modern)[0];
  assert.equal(waiting.canAccept, false);
  assert.throws(() => approvals.answer(ids.modern, waiting.id, 'accept'));
  approvals.updateFileChanges(ids.modern, 'turn', 'item', [
    { path: '/project/old', diff: 'rename', kind: { type: 'update', move_path: '/project/new' } },
  ]);
  const loaded = approvals.get(ids.modern, waiting.id);
  assert.equal(loaded.canAccept, true);
  assert(
    loaded.details.some((detail) => detail.label === '移动到' && detail.value === '/project/new'),
  );
  approvals.answer(ids.modern, loaded.id, 'decline');
  await late;
  const restricted = approvals.request(
    'item/commandExecution/requestApproval',
    { ...params(), availableDecisions: ['cancel'] },
    controller.signal,
  );
  const third = approvals.list(ids.modern)[0];
  assert.equal(third.canAccept, false);
  assert.throws(
    () => approvals.answer(ids.modern, third.id, 'accept'),
    (error: any) => error.status === 409,
  );
  approvals.answer(ids.modern, third.id, 'decline');
  assert.deepEqual(await restricted, { decision: 'cancel' });
  assert.throws(() =>
    approvals.request(
      'item/permissions/requestApproval',
      { ...params(), permissions: { unknown: true } },
      controller.signal,
    ),
  );
  approvals.close();
});

test('aborts, completed turns, expiry and shutdown never leave an approvable callback', async () => {
  const approvals = new NativeApprovals(20);
  const controller = new AbortController();
  const aborted = approvals.request(
    'item/permissions/requestApproval',
    { ...params(), permissions: { network: { enabled: true } } },
    controller.signal,
  );
  const first = approvals.list(ids.modern)[0];
  controller.abort();
  assert.deepEqual(await aborted, { permissions: {}, scope: 'turn' });
  assert.throws(
    () => approvals.answer(ids.modern, first.id, 'accept'),
    (error: any) => error.status === 410,
  );
  const turn = approvals.request(
    'item/commandExecution/requestApproval',
    params(),
    new AbortController().signal,
  );
  const second = approvals.list(ids.modern)[0];
  approvals.cancelTurn(ids.modern, 'turn');
  assert.deepEqual(await turn, { decision: 'decline' });
  assert.equal(approvals.get(ids.modern, second.id).state, 'cancelled');
  const expired = approvals.request(
    'item/commandExecution/requestApproval',
    params(),
    new AbortController().signal,
  );
  const third = approvals.list(ids.modern)[0];
  await delay(30);
  assert.deepEqual(await expired, { decision: 'decline' });
  assert.equal(approvals.get(ids.modern, third.id).state, 'expired');
  const closed = approvals.request(
    'item/fileChange/requestApproval',
    params(),
    new AbortController().signal,
  );
  approvals.close();
  assert.deepEqual(await closed, { decision: 'decline' });
  assert.equal(approvals.list(ids.modern).length, 0);
});

test('approval API requires a live administrator, constrains the thread and answers idempotently', async () => {
  const f = fixture();
  const approvals = new NativeApprovals();
  const control = Object.assign(new FixtureDesktop(f), { approvals, creationPermissions: true });
  const service = createApp(f.config, { control });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'approval-test-password!');
  const login = service.auth.issue(owner, 'approval test');
  const request = (route: string, body?: object, token = login.token) =>
    fetch(url + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  const route = `/api/sessions/${ids.modern}/approvals`;
  const pending = approvals.request(
    'item/commandExecution/requestApproval',
    { ...params(), command: 'write-project' },
    new AbortController().signal,
  );
  try {
    assert.equal((await request(route, undefined, '')).status, 401);
    await service.auth.db
      .prepare(
        "INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,'unused','viewer',?)",
      )
      .run(randomUUID(), 'viewer', Date.now());
    const viewer = service.auth.db
      .prepare("SELECT id,username,role FROM users WHERE username='viewer'")
      .get() as any;
    const viewerLogin = service.auth.issue(viewer, 'viewer');
    assert.equal((await request(route, undefined, viewerLogin.token)).status, 403);
    const listing = await (await request(route)).json();
    assert.equal(listing.available, true);
    const [entry] = listing.requests;
    assert.equal(
      (await request(`/api/sessions/${ids.legacy}/approvals/${entry.id}`, { decision: 'accept' }))
        .status,
      404,
    );
    assert.equal(
      (await request(route + '/' + entry.id, { decision: 'acceptForSession' })).status,
      400,
    );
    assert.equal(
      (
        await request(route + '/' + entry.id, {
          decision: 'accept',
          permissions: { network: { enabled: true } },
        })
      ).status,
      400,
    );
    const accepted = await (await request(route + '/' + entry.id, { decision: 'accept' })).json();
    assert.equal(accepted.state, 'answered');
    assert.deepEqual(await pending, { decision: 'accept' });
    assert.deepEqual(
      await (await request(route + '/' + entry.id, { decision: 'accept' })).json(),
      accepted,
    );
    assert.equal((await request(route + '/' + entry.id, { decision: 'decline' })).status, 409);
    assert.equal(
      service.auth.db
        .prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'approval_accept:%'")
        .get()!.n,
      1,
    );
    const permissions = approvals.request(
      'item/permissions/requestApproval',
      { ...params(), permissions: { network: { enabled: true } } },
      new AbortController().signal,
    );
    const next = approvals.list(ids.modern)[0];
    service.auth.revoke(owner.id, service.auth.authenticate(login.token)!.sessionId);
    assert.equal((await request(route + '/' + next.id, { decision: 'accept' })).status, 401);
    assert.equal(approvals.get(ids.modern, next.id).state, 'pending');
    approvals.close();
    await permissions;
  } finally {
    approvals.close();
    await pending;
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});

test('new session permissions are explicit, validated and included in creation deduplication', async () => {
  const f = fixture();
  class PermissionsDesktop extends FixtureDesktop {
    creationPermissions = true;
    settings: SessionCreationSettings = {};
    override async create(
      context: string,
      project: string,
      prompt: string,
      settings: SessionCreationSettings = {},
    ) {
      this.settings = settings;
      return super.create(context, project, prompt, settings);
    }
  }
  const control = new PermissionsDesktop(f),
    service = createApp(f.config, { control });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const owner = await service.auth.setup('owner', 'approval-test-password!'),
    token = service.auth.issue(owner, 'permissions').token;
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (body: object) =>
    fetch(url + '/api/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (
        await (
          await fetch(url + '/api/control', { headers: { Authorization: 'Bearer ' + token } })
        ).json()
      ).creationPermissions,
      true,
    );
    for (const permissionMode of ['dangerFullAccess', 'never', { networkAccess: true }])
      assert.equal(
        (await send({ requestId: randomUUID(), projectId, prompt: 'task', permissionMode })).status,
        400,
      );
    const requestId = randomUUID();
    const input = { requestId, projectId, prompt: 'task', permissionMode: 'workspace-write' };
    assert.equal((await send(input)).status, 200);
    assert.equal(control.settings.permissionMode, 'workspace-write');
    assert.equal((await send(input)).status, 200);
    assert.equal(control.creates, 1);
    assert.equal((await send({ ...input, permissionMode: 'workspace-write-network' })).status, 409);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});

test('encrypted workspace routing isolates approvals and rechecks central account permissions', async () => {
  const a = fixture(),
    b = fixture();
  const approvalsA = new NativeApprovals(),
    approvalsB = new NativeApprovals();
  const service = createMonitorServer({ ...a.config, dataDir: path.join(a.root, 'central') });
  const server = createServer(service.app);
  service.gateway.attach(server, requestGuard(a.config));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'approval-test-password!'),
    login = service.auth.issue(owner, 'tunnel');
  const wa = service.gateway.store.create('approval A'),
    wb = service.gateway.store.create('approval B');
  const clientA = await MonitorClient.start({
    config: a.config,
    serverUrl: url,
    workspaceId: wa.workspace.id,
    key: wa.key,
    services: { control: Object.assign(new FixtureDesktop(a), { approvals: approvalsA }) },
  });
  const clientB = await MonitorClient.start({
    config: b.config,
    serverUrl: url,
    workspaceId: wb.workspace.id,
    key: wb.key,
    services: { control: Object.assign(new FixtureDesktop(b), { approvals: approvalsB }) },
  });
  const pending = approvalsA.request(
    'item/permissions/requestApproval',
    {
      ...params(),
      permissions: { fileSystem: { write: ['/project/a'] }, network: { enabled: true } },
    },
    new AbortController().signal,
  );
  const send = (workspace: string, suffix: string, body?: object) =>
    fetch(`${url}/api/workspaces/${workspace}/sessions/${ids.modern}/approvals${suffix}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    const deadline = Date.now() + 10000;
    while ((!clientA.connected || !clientB.connected) && Date.now() < deadline) await delay(20);
    const [entry] = (await (await send(wa.workspace.id, '')).json()).requests;
    assert.equal((await (await send(wb.workspace.id, '')).json()).requests.length, 0);
    assert.equal((await send(wb.workspace.id, '/' + entry.id, { decision: 'accept' })).status, 404);
    service.auth.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(owner.id);
    assert.equal((await send(wa.workspace.id, '/' + entry.id, { decision: 'accept' })).status, 403);
    assert.equal(approvalsA.get(ids.modern, entry.id).state, 'pending');
    service.auth.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(owner.id);
    assert.equal(
      (await send(wa.workspace.id, '/' + entry.id, { decision: 'decline' })).status,
      200,
    );
    assert.deepEqual(await pending, { permissions: {}, scope: 'turn' });
  } finally {
    approvalsA.close();
    approvalsB.close();
    await pending;
    await clientA.close();
    await clientB.close();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    a.close();
    b.close();
  }
});
