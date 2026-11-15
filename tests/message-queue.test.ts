import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { ControlError } from '../server/desktop.js';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop } from './control-fixture.js';

async function boot(f: ReturnType<typeof fixture>, control: FixtureDesktop, token?: string) {
  const app = createApp(f.config, { control });
  const server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  if (!token) {
    const user = await app.auth.setup('owner', 'a-long-password');
    token = app.auth.issue(user, 'queue-test').token;
  }
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let closed = false;
  return {
    app,
    token,
    request: (route: string, body?: object, auth = token) =>
      fetch(base + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail('Queue did not reach the expected state');
}
const route = `/api/sessions/${ids.modern}/messages`;

test('idle sends preserve model settings through queue migration, restart and deduplication', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f);
  mkdirSync(f.data, { recursive: true });
  const legacy = new DatabaseSync(path.join(f.data, 'monitor.sqlite'));
  legacy.exec(
    'CREATE TABLE control_message_queue (request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, prompt TEXT NOT NULL, ip TEXT NOT NULL)',
  );
  legacy.close();
  control.compacting = true;
  let service = await boot(f, control);
  const input = {
    requestId: randomUUID(),
    prompt: 'continue with another model',
    model: 'gpt-6-luna',
    thinking: 'high',
  };
  try {
    assert.equal((await service.request(route, input)).status, 202);
    assert.equal((await service.request(route, input)).status, 202);
    assert.equal((await service.request(route, { ...input, thinking: 'medium' })).status, 409);
    const saved = service.app.auth.db
      .prepare('SELECT model,thinking FROM control_message_queue WHERE request_id=?')
      .get(input.requestId)!;
    assert.equal(saved.model, input.model);
    assert.equal(saved.thinking, input.thinking);
    const token = service.token;
    await service.close();
    service = await boot(f, control, token);
    f.hist.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=?").run(ids.modern);
    control.compacting = false;
    await until(
      async () =>
        (await (await service.request(`/api/control/requests/${input.requestId}`)).json()).state ===
        'succeeded',
    );
    assert.equal(control.sends, 1);
    assert.deepEqual(control.lastSend, { model: 'gpt-6-luna', thinking: 'high' });
    assert.equal((await service.request(route, input)).status, 200);
    assert.equal(control.sends, 1);
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('model changes reject active turns, invalid efforts and turns that start during model discovery', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    service = await boot(f, control);
  const input = {
    prompt: 'change model for the next turn',
    model: 'gpt-6.1-sol',
    thinking: 'ultra',
  };
  try {
    assert.equal((await service.request(route, { ...input, requestId: randomUUID() })).status, 409);
    assert.equal(control.sends, 0);
    f.hist.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=?").run(ids.modern);
    for (const overrides of [
      { model: 'gpt-6-luna', thinking: 'ultra' },
      { model: 'missing-model', thinking: 'high' },
      { model: undefined, thinking: 'high' },
      { model: 'gpt-6.1-sol', thinking: 'invalid' },
    ])
      assert.equal(
        (await service.request(route, { ...input, ...overrides, requestId: randomUUID() })).status,
        400,
      );
    assert.equal(
      (await service.request(route, { ...input, prompt: '/compact', requestId: randomUUID() }))
        .status,
      400,
    );
    assert.equal(control.sends, 0);
    const models = control.models.bind(control);
    control.models = async () => {
      f.hist
        .prepare("UPDATE thread_turns SET status='inProgress' WHERE thread_id=?")
        .run(ids.modern);
      return models();
    };
    assert.equal((await service.request(route, { ...input, requestId: randomUUID() })).status, 409);
    assert.equal(control.sends, 0);
    const plain = await service.request(route, {
      prompt: 'append with current settings',
      requestId: randomUUID(),
    });
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).mode, 'append');
    assert.deepEqual(control.lastSend, {});
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('compaction queues persist across restart, deliver in FIFO order, deduplicate and allow owner cancellation', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f);
  control.compacting = true;
  const accepted: string[] = [];
  const send = control.send.bind(control);
  control.send = async (...args) => {
    accepted.push(args[2]);
    return send(...args);
  };
  let service = await boot(f, control);
  const first = { requestId: randomUUID(), prompt: 'first queued input' },
    second = { requestId: randomUUID(), prompt: 'second queued input' },
    cancelled = { requestId: randomUUID(), prompt: 'cancelled queued input' };
  try {
    const state = await (await service.request(`/api/sessions/${ids.modern}/control`)).json();
    assert.equal(state.available, true);
    assert.equal(state.compacting, true);
    for (const input of [first, first, second, cancelled]) {
      const response = await service.request(route, input);
      assert.equal(response.status, 202);
      assert.equal((await response.json()).state, 'queued');
    }
    assert.equal(control.sends, 0);
    await service.request('/api/users', {
      username: 'other',
      password: 'another-password',
      role: 'admin',
    });
    const other = (
      await (
        await service.request('/api/auth/login', {
          username: 'other',
          password: 'another-password',
        })
      ).json()
    ).token;
    assert.equal(
      (await service.request(`/api/control/requests/${first.requestId}`, undefined, other)).status,
      404,
    );
    assert.equal(
      (await service.request(`/api/control/requests/${first.requestId}/cancel`, {}, other)).status,
      404,
    );
    assert.equal((await service.request(route, first, other)).status, 409);
    const cancellation = await service.request(
      `/api/control/requests/${cancelled.requestId}/cancel`,
      {},
    );
    assert.equal((await cancellation.json()).state, 'cancelled');
    const token = service.token;
    await service.close();
    service = await boot(f, control, token);
    assert.equal(
      (await (await service.request(`/api/control/requests/${first.requestId}`)).json()).state,
      'queued',
    );
    assert.equal(control.sends, 0);
    control.compacting = false;
    await until(
      async () =>
        (await (await service.request(`/api/control/requests/${second.requestId}`)).json())
          .state === 'succeeded',
    );
    assert.deepEqual(accepted, [first.prompt, second.prompt]);
    assert.equal(control.sends, 2);
    assert.equal((await service.request(route, first)).status, 200);
    assert.equal(control.sends, 2);
    assert.equal(
      (await (await service.request(`/api/control/requests/${cancelled.requestId}`)).json()).state,
      'cancelled',
    );
    assert.equal(
      service.app.auth.db.prepare('SELECT count(*) AS n FROM control_message_queue').get()!.n,
      0,
    );
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('only definite compact rejection is retried; uncertain submissions are never replayed', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f);
  const send = control.send.bind(control);
  let attempts = 0;
  control.send = async (...args) => {
    attempts++;
    if (attempts === 1) {
      control.compacting = true;
      throw new ControlError(
        'ActiveTurnNotSteerable { turn_kind: Compact }',
        false,
        409,
        'compacting',
      );
    }
    return send(...args);
  };
  const service = await boot(f, control);
  try {
    const input = { requestId: randomUUID(), prompt: 'compaction started after the state probe' };
    const response = await service.request(route, input);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).state, 'queued');
    assert.equal(attempts, 1);
    control.compacting = false;
    await until(
      async () =>
        (await (await service.request(`/api/control/requests/${input.requestId}`)).json()).state ===
        'succeeded',
    );
    assert.equal(attempts, 2);
    assert.equal(control.sends, 1);
    let uncertainAttempts = 0;
    control.send = async () => {
      uncertainAttempts++;
      throw new ControlError('connection lost after dispatch', true, 504);
    };
    const uncertain = { requestId: randomUUID(), prompt: 'uncertain input' };
    const failed = await service.request(route, uncertain);
    assert.equal(failed.status, 504);
    assert.equal((await failed.json()).state, 'unknown');
    await delay(1700);
    assert.equal((await service.request(route, uncertain)).status, 409);
    assert.equal(uncertainAttempts, 1);
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('cancelling a queued input while its state probe is pending prevents dispatch', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = control.state.bind(control);
  control.state = async (...args) => {
    await ready;
    return state(...args);
  };
  const service = await boot(f, control);
  try {
    const input = { requestId: randomUUID(), prompt: 'cancel before claim' };
    assert.equal((await service.request(route, input)).status, 202);
    assert.equal(
      (await (await service.request(`/api/control/requests/${input.requestId}/cancel`, {})).json())
        .state,
      'cancelled',
    );
    release();
    await delay(100);
    assert.equal(control.sends, 0);
    assert.equal(
      (await (await service.request(`/api/control/requests/${input.requestId}`)).json()).state,
      'cancelled',
    );
  } finally {
    release();
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('restart marks dispatched inputs unknown and does not replay them', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f);
  let release!: () => void,
    attempts = 0;
  const delivered = new Promise<void>((resolve) => {
    release = resolve;
  });
  control.send = async () => {
    attempts++;
    await delivered;
    return { threadId: ids.modern };
  };
  let service = await boot(f, control);
  const input = { requestId: randomUUID(), prompt: 'in-flight input' };
  try {
    const response = await service.request(route, input);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).state, 'pending');
    assert.equal(
      (await service.request(`/api/control/requests/${input.requestId}/cancel`, {})).status,
      409,
    );
    const token = service.token;
    await service.close();
    const restarted = new FixtureDesktop(f);
    service = await boot(f, restarted, token);
    release();
    assert.equal(
      (await (await service.request(`/api/control/requests/${input.requestId}`)).json()).state,
      'unknown',
    );
    assert.equal((await service.request(route, input)).status, 409);
    await delay(1700);
    assert.equal(attempts, 1);
    assert.equal(restarted.sends, 0);
  } finally {
    release();
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
