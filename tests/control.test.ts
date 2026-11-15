import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createApp } from '../server/app.js';
import { DesktopBridge, ControlError } from '../server/desktop.js';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop, projectId } from './control-fixture.js';
import { normalizeItem } from '../server/normalize.js';

test('desktop follow-up prompts render as conversation input without exposing their transport envelope', () => {
  for (const name of ['create_thread', 'send_message_to_thread']) {
    const item = {
      type: 'functionCallOutput',
      namespace: 'codex_app',
      name,
      output: `<codex_delegation>\n<source_thread_id>${ids.modern}</source_thread_id>\n<input>Keep &lt;markup&gt; &amp; 中文\nsecond line</input>\n</codex_delegation>`,
    };
    const event = normalizeItem(item, 'input', 123, 'turn');
    assert.equal(event?.kind, 'user');
    assert.equal(event?.text, 'Keep <markup> & 中文\nsecond line');
    assert.equal(event?.turnId, 'turn');
    assert.equal(normalizeItem({ ...item, namespace: 'other' }, 'other', 123)?.kind, 'tool');
  }
});

test('control API enforces roles, uses live state, deduplicates concurrent/restarted requests, and creates project sessions', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    application = createApp(f.config, { control });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const owner = await application.auth.setup('owner', 'a-long-password'),
    token = application.auth.issue(owner, 'control').token;
  const send = (route: string, data?: object, auth = token) =>
    fetch(base + route, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
  try {
    assert.equal((await send('/api/control', undefined, '')).status, 401);
    await send('/api/users', { username: 'viewer', password: 'a-viewer-password', role: 'viewer' });
    const viewer = (
      await (
        await send('/api/auth/login', { username: 'viewer', password: 'a-viewer-password' }, '')
      ).json()
    ).token;
    for (const route of [
      '/api/control',
      '/api/control/models',
      `/api/sessions/${ids.modern}/control`,
      `/api/sessions/${ids.modern}/goal`,
      '/api/control/requests/' + randomUUID(),
    ])
      assert.equal((await send(route, undefined, viewer)).status, 403);
    for (const route of ['/api/sessions', `/api/sessions/${ids.modern}/messages`])
      assert.equal(
        (await send(route, { requestId: randomUUID(), prompt: 'forbidden', projectId }, viewer))
          .status,
        403,
      );
    assert.equal(control.sends, 0);
    assert.equal((await (await send('/api/control')).json()).projects[0].id, projectId);
    assert.equal((await (await send(`/api/sessions/${ids.modern}/control`)).json()).running, true);
    for (const prompt of ['', '   ', 'x'.repeat(12001)])
      assert.equal(
        (await send(`/api/sessions/${ids.modern}/messages`, { prompt, requestId: randomUUID() }))
          .status,
        400,
      );
    assert.equal(
      (
        await send(`/api/sessions/${ids.archived}/messages`, {
          prompt: 'no',
          requestId: randomUUID(),
        })
      ).status,
      409,
    );
    const requestId = randomUUID(),
      payload = { requestId, prompt: 'active instruction' },
      route = `/api/sessions/${ids.modern}/messages`;
    const responses = await Promise.all([send(route, payload), send(route, payload)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).mode, 'append');
    }
    assert.equal(control.sends, 1);
    assert.equal((await send(route, { ...payload, prompt: 'different' })).status, 409);
    const idle = await (
      await send(route, { requestId: randomUUID(), prompt: 'idle instruction' })
    ).json();
    assert.equal(idle.mode, 'start');
    assert.equal(control.sends, 2);
    control.compacting = true;
    assert.equal(
      (await (await send(`/api/sessions/${ids.modern}/control`)).json()).available,
      true,
    );
    const queuedId = randomUUID();
    const blockedSend = await send(route, {
      requestId: queuedId,
      prompt: 'wait for compaction',
    });
    assert.equal(blockedSend.status, 202);
    assert.equal((await blockedSend.json()).state, 'queued');
    assert.equal(
      (await (await send('/api/control/requests/' + queuedId + '/cancel', {})).json()).state,
      'cancelled',
    );
    assert.equal(control.sends, 2);
    const blockedGoal = await send(`/api/sessions/${ids.modern}/commands`, {
      requestId: randomUUID(),
      command: 'goal.set',
      prompt: 'must not set during compaction',
    });
    assert.equal(blockedGoal.status, 409);
    assert.equal(control.goals.size, 0);
    control.compacting = false;
    assert.equal(
      (await (await send('/api/control/requests/' + requestId)).json()).state,
      'succeeded',
    );
    const receipt = await (
      await send('/api/sessions', {
        requestId: randomUUID(),
        projectId,
        prompt: 'new session instruction',
      })
    ).json();
    assert.equal(receipt.mode, 'create');
    assert.equal(control.creates, 1);
    assert.deepEqual(control.lastCreation, {});
    const detail = await (await send(`/api/sessions/${receipt.threadId}`)).json();
    assert.ok(
      detail.events.some(
        (e: any) => e.kind === 'assistant' && e.text.includes('new session instruction'),
      ),
    );
    const catalog = await (await send('/api/control/models')).json();
    assert.equal(catalog.available, true);
    assert.deepEqual(catalog.models[1].supportedReasoningEfforts, [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    for (const settings of [
      { model: 'missing-model' },
      { model: 'gpt-6-luna', thinking: 'ultra' },
      { thinking: 'high' },
      { model: 'gpt-6.1-sol', thinking: 'invalid' },
    ]) {
      assert.equal(
        (
          await send('/api/sessions', {
            requestId: randomUUID(),
            projectId,
            prompt: 'invalid settings',
            ...settings,
          })
        ).status,
        400,
      );
    }
    assert.equal(control.creates, 1);
    const configured = {
      requestId: randomUUID(),
      projectId,
      prompt: 'configured session',
      model: 'gpt-6.1-sol',
      thinking: 'ultra',
    };
    const created = await send('/api/sessions', configured);
    assert.equal(created.status, 200);
    const configuredReceipt = await created.json();
    assert.deepEqual(control.lastCreation, { model: 'gpt-6.1-sol', thinking: 'ultra' });
    assert.equal(
      (await (await send(`/api/sessions/${configuredReceipt.threadId}`)).json()).session.model,
      'gpt-6.1-sol',
    );
    assert.equal((await send('/api/sessions', configured)).status, 200);
    assert.equal((await send('/api/sessions', { ...configured, thinking: 'high' })).status, 409);
    assert.equal((await send('/api/sessions', { ...configured, model: 'gpt-6-luna' })).status, 409);
    assert.equal(control.creates, 2);
    assert.equal(
      (
        await send(route, {
          requestId: randomUUID(),
          prompt: 'unchanged append',
          model: 'gpt-6.1-sol',
        })
      ).status,
      200,
    );
    assert.deepEqual(control.lastSend, { model: 'gpt-6.1-sol' });
    const listModels = control.models.bind(control);
    control.models = async () => {
      throw new ControlError('模型列表暂不可用');
    };
    assert.equal((await (await send('/api/control/models')).json()).available, false);
    assert.equal(
      (
        await send('/api/sessions', {
          requestId: randomUUID(),
          projectId,
          prompt: 'defaults without catalog',
        })
      ).status,
      200,
    );
    assert.deepEqual(control.lastCreation, {});
    control.models = listModels;
    const commandRoute = `/api/sessions/${ids.modern}/commands`;
    assert.equal(
      (await send(commandRoute, { requestId: randomUUID(), command: 'compact' }, viewer)).status,
      403,
    );
    const compactId = randomUUID();
    assert.equal(
      (await send(commandRoute, { requestId: compactId, command: 'compact' })).status,
      200,
    );
    assert.equal(
      (await send(commandRoute, { requestId: compactId, command: 'compact' })).status,
      200,
    );
    assert.equal(control.compactions, 1);
    const goal = await (
      await send(route, { requestId: randomUUID(), prompt: '/goal verify a persistent objective' })
    ).json();
    assert.equal(goal.mode, 'goal');
    assert.equal(goal.goal.objective, 'verify a persistent objective');
    assert.equal(
      (await (await send(`/api/sessions/${ids.modern}/goal`)).json()).goal.status,
      'active',
    );
    for (const [action, expected] of [
      ['pause', 'paused'],
      ['resume', 'active'],
    ] as const) {
      const result = await (
        await send(commandRoute, { requestId: randomUUID(), command: 'goal.' + action })
      ).json();
      assert.equal(result.goal.status, expected);
    }
    await send(route, { requestId: randomUUID(), prompt: '/goal clear' });
    assert.equal((await (await send(`/api/sessions/${ids.modern}/goal`)).json()).goal, null);
    const beforeHelp = control.sends;
    assert.equal(
      (await (await send(route, { requestId: randomUUID(), prompt: '/help' })).json()).mode,
      'help',
    );
    assert.equal(control.sends, beforeHelp);
    assert.equal(
      (await send(route, { requestId: randomUUID(), prompt: '/unsupported' })).status,
      400,
    );
    const before = control.sends;
    control.send = async () => {
      throw new ControlError('connection lost after dispatch', true, 504);
    };
    const unknownId = randomUUID(),
      unknown = { requestId: unknownId, prompt: 'uncertain' };
    assert.equal((await send(route, unknown)).status, 504);
    assert.equal((await send(route, unknown)).status, 409);
    assert.equal(control.sends, before);
    assert.equal(
      (await (await send('/api/control/requests/' + unknownId)).json()).state,
      'unknown',
    );
    // A new application instance must preserve successful IDs and mark pending IDs unknown.
    const pending = randomUUID();
    application.auth.db
      .prepare('INSERT INTO control_requests VALUES(?,?,?,?,?,?)')
      .run(pending, owner.id, 'fingerprint', 'pending', null, Date.now());
    const restarted = createApp(f.config, { control });
    try {
      assert.equal(
        restarted.auth.db.prepare('SELECT state FROM control_requests WHERE id=?').get(requestId)!
          .state,
        'succeeded',
      );
      assert.equal(
        restarted.auth.db.prepare('SELECT state FROM control_requests WHERE id=?').get(pending)!
          .state,
        'unknown',
      );
    } finally {
      restarted.close();
    }
  } finally {
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('desktop bridge handles split frames, rejects invalid receipts and never retries an uncertain mutation', async () => {
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\monitor-test-${randomUUID()}`
      : `/tmp/monitor-${randomUUID()}.sock`;
  let calls = 0,
    mode = 'ok';
  let lastArgs: Record<string, unknown> | undefined;
  const sockets = new Set<net.Socket>();
  const server = net
    .createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let bytes = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 4 || bytes.length < 4 + bytes.readUInt32LE()) return;
        const request = JSON.parse(bytes.subarray(4).toString());
        calls++;
        assert.equal(request.method, 'tools/call');
        lastArgs = request.params.arguments;
        if (request.params.tool === 'send_message_to_thread')
          assert.equal(request.params.arguments.threadId, ids.modern);
        if (mode === 'drop') {
          socket.destroy();
          return;
        }
        const body = Buffer.from(
          JSON.stringify(
            mode === 'rpc-compact'
              ? {
                  jsonrpc: '2.0',
                  id: 1,
                  error: {
                    message:
                      'failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
                  },
                }
              : {
                  jsonrpc: '2.0',
                  id: 1,
                  result: {
                    success: !['compact', 'other-turn'].includes(mode),
                    contentItems: [
                      {
                        type: 'inputText',
                        text:
                          mode === 'compact'
                            ? 'failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }'
                            : mode === 'other-turn'
                              ? 'ActiveTurnNotSteerable { turn_kind: Review }'
                              : JSON.stringify({
                                  threadId: mode === 'wrong' ? ids.legacy : ids.modern,
                                }),
                      },
                    ],
                  },
                },
          ),
        );
        const frame = Buffer.alloc(body.length + 4);
        frame.writeUInt32LE(body.length);
        body.copy(frame, 4);
        socket.write(frame.subarray(0, 2));
        setTimeout(() => {
          if (!socket.destroyed) socket.write(frame.subarray(2));
        }, 5);
      });
    })
    .listen(pipe);
  await once(server, 'listening');
  const bridge = new DesktopBridge({ pipe, timeoutMs: 1000 });
  try {
    await bridge.create(ids.modern, projectId, 'new', { model: 'gpt-6.1-sol', thinking: 'ultra' });
    assert.deepEqual(lastArgs, {
      prompt: 'new',
      target: { type: 'project', projectId, environment: { type: 'local' } },
      model: 'gpt-6.1-sol',
      thinking: 'ultra',
    });
    await bridge.create(ids.modern, projectId, 'defaults');
    assert.deepEqual(lastArgs, {
      prompt: 'defaults',
      target: { type: 'project', projectId, environment: { type: 'local' } },
    });
    assert.equal((await bridge.send(ids.modern, ids.modern, 'hello')).threadId, ids.modern);
    assert.deepEqual(lastArgs, { threadId: ids.modern, hostId: 'local', prompt: 'hello' });
    await bridge.send(ids.modern, ids.modern, 'continue', {
      model: 'gpt-6-luna',
      thinking: 'high',
    });
    assert.deepEqual(lastArgs, {
      threadId: ids.modern,
      hostId: 'local',
      prompt: 'continue',
      model: 'gpt-6-luna',
      thinking: 'high',
    });
    for (const compact of ['compact', 'rpc-compact']) {
      mode = compact;
      await assert.rejects(
        bridge.send(ids.modern, ids.modern, 'hello'),
        (e: unknown) => e instanceof ControlError && !e.uncertain && e.code === 'compacting',
      );
    }
    mode = 'other-turn';
    await assert.rejects(
      bridge.send(ids.modern, ids.modern, 'hello'),
      (e: unknown) => e instanceof ControlError && !e.uncertain && !e.code,
    );
    mode = 'wrong';
    await assert.rejects(
      bridge.send(ids.modern, ids.modern, 'hello'),
      (e: unknown) => e instanceof ControlError && e.uncertain,
    );
    mode = 'drop';
    await assert.rejects(
      bridge.send(ids.modern, ids.modern, 'hello'),
      (e: unknown) => e instanceof ControlError && e.uncertain,
    );
    assert.equal(calls, 9);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
