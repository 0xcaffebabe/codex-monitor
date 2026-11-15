import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { ControlError } from '../server/control-error.js';
import { compactOwnedThread, interruptOwnedThread } from '../server/native.js';
import { FixtureDesktop } from './control-fixture.js';
import { fixture, ids } from './fixture.js';

test('stop targets the selected turn, enforces access, and deduplicates requests without clearing goals', async () => {
  const f = fixture();
  const control = new FixtureDesktop(f);
  const application = createApp(f.config, { control });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const owner = await application.auth.setup('owner', 'a-long-password');
  const token = application.auth.issue(owner, 'stop-test').token;
  const viewer = { id: randomUUID(), username: 'viewer', role: 'viewer' as const };
  application.auth.db
    .prepare('INSERT INTO users VALUES(?,?,?,?,?)')
    .run(viewer.id, viewer.username, 'unused-fixture-password', viewer.role, Date.now());
  const viewerToken = application.auth.issue(viewer, 'stop-test').token;
  const send = (id: string, body: object, auth = token) =>
    fetch(`${base}/api/sessions/${id}/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const payload = { requestId: randomUUID(), command: 'interrupt', turnId: 'turn-1' };
  try {
    assert.equal((await send(ids.modern, payload, '')).status, 401);
    assert.equal((await send(ids.modern, payload, viewerToken)).status, 403);
    for (const id of [ids.archived, ids.child]) assert.equal((await send(id, payload)).status, 409);
    assert.equal((await send(randomUUID(), payload)).status, 404);
    assert.equal(
      (await send(ids.modern, { requestId: randomUUID(), command: 'interrupt' })).status,
      400,
    );
    assert.equal(
      (await send(ids.modern, { ...payload, requestId: randomUUID(), turnId: 'old-turn' })).status,
      409,
    );
    assert.equal(control.interruptions, 0);
    await control.goal(ids.modern, 'set', 'Keep this objective');
    const responses = await Promise.all([send(ids.modern, payload), send(ids.modern, payload)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).message, '已停止当前执行。');
    }
    assert.equal(control.interruptions, 1);
    assert.equal((await control.state('', ids.modern)).status, 'idle');
    assert.equal((await control.goal(ids.modern, 'get')).status, 'paused');
    assert.equal((await control.goal(ids.modern, 'get')).objective, 'Keep this objective');
    assert.equal((await send(ids.modern, payload)).status, 200);
    assert.equal((await send(ids.modern, { ...payload, turnId: 'another-turn' })).status, 409);
    assert.equal(control.interruptions, 1);
    const idle = await send(ids.modern, { ...payload, requestId: randomUUID() });
    assert.equal((await idle.json()).message, '该轮次已结束，无需停止。');
    f.hist.prepare("UPDATE thread_turns SET status='inProgress' WHERE thread_id=?").run(ids.modern);
    control.compacting = true;
    const status = await fetch(`${base}/api/sessions/${ids.modern}/control`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal((await status.json()).turnId, 'turn-1');
    assert.equal((await send(ids.modern, { ...payload, requestId: randomUUID() })).status, 200);
    assert.equal(control.compacting, false);
    assert.equal(control.interruptions, 2);
  } finally {
    application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    assert.ok(path.resolve(f.root).startsWith(path.join(os.tmpdir(), 'codex-monitor-test-')));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('stop bypasses a pending send and rechecks authorization before interrupting', async () => {
  const f = fixture();
  const control = new FixtureDesktop(f);
  const application = createApp(f.config, { control });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const owner = await application.auth.setup('owner', 'a-long-password');
  const identity = application.auth.issue(owner, 'stop-test');
  const post = (route: string, body: object) =>
    fetch(base + route, {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  let releaseSend!: () => void;
  let sendStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    sendStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  control.send = async (_caller, threadId) => {
    sendStarted();
    await blocked;
    return { threadId };
  };
  const pending = post(`/api/sessions/${ids.modern}/messages`, {
    requestId: randomUUID(),
    prompt: 'A pending message receipt',
  });
  try {
    await started;
    const route = `/api/sessions/${ids.modern}/commands`;
    const result = await post(route, {
      requestId: randomUUID(),
      command: 'interrupt',
      turnId: 'turn-1',
    });
    assert.equal(result.status, 200);
    assert.equal(control.interruptions, 1);
    releaseSend();
    await pending;
    f.hist.prepare("UPDATE thread_turns SET status='inProgress' WHERE thread_id=?").run(ids.modern);
    const state = control.state.bind(control);
    control.state = async (...args) => {
      const current = await state(...args);
      application.auth.db.prepare('DELETE FROM sessions WHERE user_id=?').run(owner.id);
      return current;
    };
    const revoked = await post(route, {
      requestId: randomUUID(),
      command: 'interrupt',
      turnId: 'turn-1',
    });
    assert.equal(revoked.status, 403);
    assert.equal(control.interruptions, 1);
  } finally {
    releaseSend();
    await pending.catch(() => {});
    application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    assert.ok(path.resolve(f.root).startsWith(path.join(os.tmpdir(), 'codex-monitor-test-')));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('native stop routes to the owner with a turn guard and preserves uncertain outcomes', async () => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\monitor-interrupt-test-${randomUUID()}`
      : path.join(os.tmpdir(), `monitor-interrupt-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  let mode = 'success';
  const calls: any[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reply = (requestId: string, fields: object) => {
      const body = Buffer.from(JSON.stringify({ type: 'response', requestId, ...fields }));
      const frame = Buffer.alloc(body.length + 4);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      socket.write(frame.subarray(0, 3));
      socket.write(frame.subarray(3));
    };
    let bytes = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE() + 4) {
        const size = bytes.readUInt32LE();
        const request = JSON.parse(bytes.subarray(4, size + 4).toString());
        bytes = bytes.subarray(size + 4);
        calls.push(request);
        if (request.method === 'initialize') {
          reply(request.requestId, {
            resultType: 'success',
            result: { clientId: 'monitor-client' },
          });
        } else if (request.method === 'thread-owner-discovery') {
          reply(
            request.requestId,
            mode === 'missing-owner'
              ? { resultType: 'error', error: 'no-client-found' }
              : { resultType: 'success', handledByClientId: 'owner-window', result: {} },
          );
        } else if (mode === 'disconnect') {
          socket.destroy();
        } else {
          reply(request.requestId, {
            resultType: 'success',
            result: {
              ok: true,
              interruptedTurnId:
                mode === 'finished' ? null : mode === 'wrong-turn' ? 'other-turn' : 'turn-1',
              ...(mode === 'goal-error' ? { goalPauseError: 'goal pause failed' } : {}),
            },
          });
        }
      }
    });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  const interrupt = () => interruptOwnedThread(ids.modern, 'turn-1', undefined, endpoint);
  try {
    assert.deepEqual(await interrupt(), { interruptedTurnId: 'turn-1' });
    const request = calls.find((call) => call.method === 'thread-follower-interrupt-turn');
    assert.equal(request.version, 4);
    assert.equal(request.sourceClientId, 'monitor-client');
    assert.equal(request.targetClientId, 'owner-window');
    assert.deepEqual(request.params, {
      conversationId: ids.modern,
      mode: 'user-stop',
      expectedTurnId: 'turn-1',
    });
    mode = 'finished';
    assert.deepEqual(await interrupt(), { interruptedTurnId: null });
    mode = 'goal-error';
    assert.deepEqual(await interrupt(), {
      interruptedTurnId: 'turn-1',
      goalPauseError: 'goal pause failed',
    });
    for (const failure of ['disconnect', 'wrong-turn', 'missing-owner']) {
      mode = failure;
      await assert.rejects(
        interrupt(),
        (error: unknown) =>
          error instanceof ControlError && error.uncertain === (failure !== 'missing-owner'),
      );
    }
    mode = 'success';
    await compactOwnedThread(ids.modern, undefined, endpoint);
    const compact = calls.find((call) => call.method === 'thread-follower-compact-thread');
    assert.equal(compact.version, 1);
    assert.deepEqual(compact.params, { conversationId: ids.modern });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
