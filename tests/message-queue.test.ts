import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { ControlError, type DesktopControl } from '../server/desktop.js';
import { NativeDesktopControl } from '../server/native-control.js';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop, projectId } from './control-fixture.js';

async function boot(f: ReturnType<typeof fixture>, control: DesktopControl, token?: string) {
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

test('a new client resumes a web-created session with an unfinished turn in history', async () => {
  const f = fixture();
  const calls: string[] = [];
  const desktop = new FixtureDesktop(f);
  desktop.state = async () => ({ status: 'notLoaded' });
  let writerBusy = false;
  const client = () => {
    let status = 'notLoaded';
    return new NativeDesktopControl(
      {
        codexHome: f.home,
        activity: () => ({ turnId: 'turn-1', running: true, compacting: true }),
      },
      {
        desktop,
        owner: async () => {
          throw new ControlError('No desktop owner', false, 409, 'no_owner');
        },
        generateTitle: async () => undefined,
        native: {
          async request(method, params: { threadId?: string }) {
            if (method === 'project/list')
              return { data: [{ id: projectId, name: 'work', roots: [{ path: f.root }] }] };
            if (method === 'thread/start') return { thread: { id: ids.modern } };
            assert.equal(params.threadId, ids.modern);
            if (method === 'thread/read')
              return { thread: { id: ids.modern, status: { type: status } } };
            calls.push(method);
            if (method === 'thread/resume') {
              if (writerBusy)
                throw new ControlError('Thread already has an active writer', false, 409);
              status = 'idle';
            }
            if (method === 'turn/start') {
              status = 'active';
              return { turn: { id: calls.length === 1 ? 'turn-1' : 'turn-new', status: 'inProgress' } };
            }
          },
          models: async () => [],
          get: async () => null,
          set: async () => null,
          clear: async () => {},
          close() {},
        },
      },
    );
  };
  let service = await boot(f, client());
  try {
    const controlRoute = `/api/sessions/${ids.modern}/control`;
    const created = await service.request('/api/sessions', {
      projectId,
      requestId: randomUUID(),
      prompt: 'start from the web',
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).threadId, ids.modern);
    assert.equal((await (await service.request(controlRoute)).json()).compacting, true);

    const token = service.token;
    await service.close();
    service = await boot(f, client(), token);
    assert.equal((await service.app.source.get(ids.modern))?.status, 'running');
    const state = await (await service.request(controlRoute)).json();
    assert.equal(state.available, true);
    assert.equal(state.running, false);
    assert.equal(state.compacting, undefined);
    assert.deepEqual(calls, ['turn/start'], 'reconnect does not replay the first message');

    writerBusy = true;
    const blocked = await service.request(route, {
      requestId: randomUUID(),
      prompt: 'writer conflict',
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).state, 'failed');
    assert.deepEqual(calls, ['turn/start', 'thread/resume'], 'writer conflict prevents dispatch');

    writerBusy = false;
    const input = { requestId: randomUUID(), prompt: 'continue the same session' };
    const accepted = await service.request(route, input);
    assert.equal(accepted.status, 200);
    const receipt = await accepted.json();
    assert.equal(receipt.threadId, ids.modern);
    assert.equal(receipt.mode, 'start');
    assert.equal((await service.request(route, input)).status, 200);
    assert.deepEqual(calls, ['turn/start', 'thread/resume', 'thread/resume', 'turn/start']);
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('message permission changes require an idle Monitor turn and are deduplicated', async () => {
  const f = fixture(), control = new FixtureDesktop(f), service = await boot(f, control);
  const permissionMode = 'workspace-write-network';
  const send = (settings: object = {}) => service.request(route, {
    requestId: randomUUID(), prompt: 'change permissions', permissionMode, ...settings,
  });
  const controlRoute = `/api/sessions/${ids.modern}/control`;
  try {
    assert.equal((await send({ channel: 'desktop' })).status, 400);
    assert.equal((await send({ permissionMode: 'never' })).status, 400);
    assert.equal((await send({ prompt: '/compact' })).status, 400);
    assert.equal((await (await service.request(controlRoute)).json()).messagePermissions, false);
    assert.equal((await send()).status, 409);
    control.owner = 'monitor';
    f.hist.prepare("UPDATE thread_turns SET status='inProgress' WHERE thread_id=?").run(ids.modern);
    assert.equal((await send()).status, 409);
    f.hist.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=?").run(ids.modern);
    control.compacting = true;
    assert.equal((await send()).status, 409);
    control.compacting = false;
    assert.equal(control.sends, 0);
    assert.equal((await (await service.request(controlRoute)).json()).messagePermissions, true);
    const requestId = randomUUID();
    const accepted = await send({ requestId });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).mode, 'start');
    assert.deepEqual(control.lastSend, { permissionMode });
    assert.equal((await send({ requestId })).status, 200);
    assert.equal((await send({ requestId, permissionMode: 'read-only' })).status, 409);
    assert.equal(control.sends, 1);
    assert.equal((await send({ permissionMode: 'inherit' })).status, 200);
    assert.deepEqual(control.lastSend, {});
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('idle sends preserve model and desktop channel through queue migration, restart and deduplication', async () => {
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
    channel: 'desktop',
  };
  try {
    assert.equal((await service.request(route, input)).status, 202);
    assert.equal((await service.request(route, input)).status, 202);
    assert.equal((await service.request(route, { ...input, thinking: 'medium' })).status, 409);
    assert.equal((await service.request(route, { ...input, channel: undefined })).status, 409);
    const saved = service.app.auth.db
      .prepare('SELECT model,thinking,channel FROM control_message_queue WHERE request_id=?')
      .get(input.requestId)!;
    assert.equal(saved.model, input.model);
    assert.equal(saved.thinking, input.thinking);
    assert.equal(saved.channel, input.channel);
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
    assert.deepEqual(control.lastSend, {
      model: 'gpt-6-luna',
      thinking: 'high',
      channel: 'desktop',
    });
    assert.equal((await service.request(route, input)).status, 200);
    assert.equal(control.sends, 1);
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('desktop messages append to running desktop turns without waiting and deduplicate receipts', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    service = await boot(f, control);
  try {
    // The legacy desktop tools bridge does not report an owner.
    for (const owner of ['desktop', undefined] as const) {
      control.owner = owner;
      f.hist
        .prepare("UPDATE thread_turns SET status='inProgress' WHERE thread_id=?")
        .run(ids.modern);
      const previous = await control.state('', ids.modern);
      const input = { requestId: randomUUID(), prompt: 'append on desktop', channel: 'desktop' };
      const sends = control.sends;
      const response = await service.request(route, input);
      assert.equal(response.status, 200);
      const receipt = await response.json();
      assert.equal(receipt.state, 'succeeded');
      assert.equal(receipt.mode, 'append');
      assert.equal(receipt.threadId, ids.modern);
      assert.equal(receipt.previousTurnId, previous.turnId);
      assert.equal(receipt.requestId, input.requestId);
      assert.equal(control.sends, sends + 1);
      assert.deepEqual(control.lastSend, { channel: 'desktop' });
      assert.equal((await control.state('', ids.modern)).turnId, previous.turnId);
      assert.equal((await service.request(route, input)).status, 200);
      assert.equal(control.sends, sends + 1, 'a repeated receipt must not send the message twice');
    }
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('desktop channel appends when only desktop tools can see the live owner', async () => {
  const f = fixture();
  const desktop = new FixtureDesktop(f);
  desktop.owner = undefined;
  const control = new NativeDesktopControl(
    { codexHome: f.home, activity: () => ({ turnId: 'turn-1', running: true, compacting: false }) },
    {
      desktop,
      owner: async () => {
        throw new ControlError('Follower IPC is unavailable', false, 503, 'owner_unavailable');
      },
      native: {
        async request(method, params: { threadId: string }) {
          assert.equal(method, 'thread/read');
          return { thread: { id: params.threadId, status: { type: 'notLoaded' } } };
        },
        models: async () => [],
        get: async () => null,
        set: async () => null,
        clear: async () => {},
        close() {},
      },
    },
  );
  const service = await boot(f, control);
  try {
    const input = {
      requestId: randomUUID(),
      prompt: 'append through desktop tools',
      channel: 'desktop',
    };
    const response = await service.request(route, input);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.state, 'succeeded');
    assert.equal(receipt.mode, 'append');
    assert.equal(receipt.previousTurnId, 'turn-1');

    const state = await (await service.request(`/api/sessions/${ids.modern}/control`)).json();
    assert.equal(state.owner, 'desktop');
    assert.equal(state.messagePermissions, false);
    assert.equal((await service.request(route, input)).status, 200);
    assert.equal(desktop.sends, 1);
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('desktop messages wait for running monitor turns and handoff readiness, then deliver once', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    service = await boot(f, control);
  control.owner = 'monitor';
  const input = {
    requestId: randomUUID(),
    prompt: 'desktop after the current turn',
    channel: 'desktop',
    model: 'gpt-6.1-sol',
    thinking: 'high',
  };
  const send = control.send.bind(control);
  let ready = false,
    attempts = 0;
  control.send = async (...args) => {
    attempts++;
    if (!ready) throw new ControlError('waiting for goal completion', false, 409, 'desktop_busy');
    return send(...args);
  };
  try {
    const queued = await service.request(route, input);
    assert.equal(queued.status, 202);
    assert.match((await queued.json()).message, /桌面通道.*等待当前执行/);
    assert.equal(attempts, 0, 'an active turn must not be submitted to desktop');
    f.hist.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=?").run(ids.modern);
    await until(async () => attempts > 0);
    const waiting = await (
      await service.request(`/api/control/requests/${input.requestId}`)
    ).json();
    assert.equal(waiting.state, 'queued');
    assert.equal(control.sends, 0);
    ready = true;
    await until(
      async () =>
        (await (await service.request(`/api/control/requests/${input.requestId}`)).json()).state ===
        'succeeded',
    );
    assert.equal(control.sends, 1);
    assert.deepEqual(control.lastSend, {
      channel: 'desktop',
      model: 'gpt-6.1-sol',
      thinking: 'high',
    });
    assert.equal((await service.request(route, input)).status, 200);
    assert.equal(control.sends, 1);
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('desktop messages wait for an unavailable writer and append once its desktop owner is reachable', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    service = await boot(f, control);
  const state = control.state.bind(control);
  let reachable = false;
  control.state = async (...args) =>
    reachable ? state(...args) : { status: 'notLoaded', compacting: false };
  const input = { requestId: randomUUID(), prompt: 'append after reconnect', channel: 'desktop' };
  try {
    assert.equal((await service.request(route, input)).status, 202);
    assert.equal(control.sends, 0);
    reachable = true;
    await until(
      async () =>
        (await (await service.request(`/api/control/requests/${input.requestId}`)).json()).state ===
        'succeeded',
    );
    assert.equal(control.sends, 1);
    assert.equal((await (await service.request(route, input)).json()).mode, 'append');
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('desktop selection rejects unsupported clients and slash commands without dispatch', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    service = await boot(f, control);
  try {
    assert.equal(
      (await (await service.request(`/api/sessions/${ids.modern}/control`)).json()).desktopChannel,
      true,
    );
    for (const overrides of [{ channel: 'invalid' }, { channel: 'desktop', prompt: '/help' }]) {
      assert.equal(
        (await service.request(route, { requestId: randomUUID(), prompt: 'desktop', ...overrides }))
          .status,
        400,
      );
    }
    Object.defineProperty(control, 'desktopChannel', { value: false });
    assert.equal(
      (await (await service.request(`/api/sessions/${ids.modern}/control`)).json()).desktopChannel,
      false,
    );
    assert.equal(
      (
        await service.request(route, {
          requestId: randomUUID(),
          prompt: 'desktop',
          channel: 'desktop',
        })
      ).status,
      409,
    );
    assert.equal(control.sends, 0);
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
    for (const channel of [undefined, 'desktop'])
      assert.equal(
        (await service.request(route, { ...input, channel, requestId: randomUUID() })).status,
        409,
      );
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
