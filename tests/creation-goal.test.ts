import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createApp } from '../server/app.js';
import { ControlError } from '../server/control-error.js';
import { fixture } from './fixture.js';
import { FixtureDesktop, projectId } from './control-fixture.js';

async function harness(t: TestContext) {
  const f = fixture(),
    desktop = new FixtureDesktop(f);
  let application = createApp(f.config, { control: desktop });
  let server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const owner = await application.auth.setup('owner', 'a-long-password');
  const login = application.auth.issue(owner, 'goal creation');
  const send = (route: string, data?: object, token = login.token) =>
    fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${route}`, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
  t.after(async () => {
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  return {
    f,
    desktop,
    owner,
    login,
    send,
    get application() {
      return application;
    },
    async restart() {
      await application.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      application = createApp(f.config, { control: desktop });
      server = application.app.listen(0, '127.0.0.1');
      await once(server, 'listening');
    },
  };
}

test('a first-message goal creates once, preserves model settings, and never sends a second execution message', async (t) => {
  const h = await harness(t);
  const requestId = randomUUID();
  const input = {
    requestId,
    projectId,
    prompt: 'Finish the first goal',
    asGoal: true,
    model: 'gpt-6.1-sol',
    thinking: 'high',
  };
  const responses = await Promise.all([
    h.send('/api/sessions', input),
    h.send('/api/sessions', input),
  ]);
  const receipts = await Promise.all(
    responses.map(async (response) => {
      assert.equal(response.status, 200);
      return response.json();
    }),
  );
  assert.equal(h.desktop.creates, 1);
  assert.equal(h.desktop.sends, 1);
  assert.deepEqual(h.desktop.lastCreation, { model: input.model, thinking: input.thinking });
  assert.equal(receipts[0].threadId, receipts[1].threadId);
  assert.equal(receipts[0].goalState, 'saved');
  assert.equal(receipts[0].goal.objective, input.prompt);
  assert.equal(receipts[0].goal.status, 'active');
  const detail = await (await h.send(`/api/sessions/${receipts[0].threadId}`)).json();
  assert.equal(detail.events.filter((event: any) => event.kind === 'user').length, 1);
  assert.ok(
    detail.events.some(
      (event: any) => event.kind === 'user' && event.text === `/goal ${input.prompt}`,
    ),
  );
  assert.equal((await h.send('/api/sessions', { ...input, asGoal: false })).status, 409);
  assert.equal(
    (await h.send('/api/sessions', { ...input, prompt: 'A different goal' })).status,
    409,
  );
  assert.equal((await h.send(`/api/control/requests/${requestId}/goal`, {})).status, 200);
  assert.equal(h.desktop.sends, 1);
});

test('desktop creation preserves its channel, model and goal intent through idempotent requests', async (t) => {
  const h = await harness(t);
  const input = {
    requestId: randomUUID(),
    projectId,
    prompt: 'desktop goal',
    asGoal: true,
    channel: 'desktop',
    model: 'gpt-6.1-sol',
    thinking: 'high',
    permissionMode: 'inherit',
  };
  assert.equal((await (await h.send('/api/control')).json()).desktopChannel, true);
  const response = await h.send('/api/sessions', input);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.goalState, 'saved');
  assert.equal(h.desktop.creates, 1);
  assert.equal(h.desktop.sends, 1);
  assert.deepEqual(h.desktop.lastCreation, {
    channel: 'desktop',
    model: input.model,
    thinking: input.thinking,
    permissionMode: 'inherit',
  });
  assert.equal((await h.send('/api/sessions', input)).status, 200);
  assert.equal(h.desktop.creates, 1);
  assert.equal((await h.send('/api/sessions', { ...input, channel: undefined })).status, 409);
  assert.equal(
    (
      await h.send('/api/sessions', {
        ...input,
        requestId: randomUUID(),
        permissionMode: 'danger-full-access',
      })
    ).status,
    400,
  );
  Object.defineProperty(h.desktop, 'desktopChannel', { value: false });
  assert.equal((await h.send('/api/sessions', { ...input, requestId: randomUUID() })).status, 409);
  assert.equal(h.desktop.creates, 1);
});

test('new-session /goal input is normalized and rejects invalid objectives before creating', async (t) => {
  const h = await harness(t);
  for (const input of [
    { prompt: '/goal' },
    { prompt: '/goal pause' },
    { prompt: '/goal status' },
    { prompt: '/goal resume' },
    { prompt: '/goal clear' },
    { prompt: ' '.repeat(3), asGoal: true },
    { prompt: 'x'.repeat(4001), asGoal: true },
    { prompt: '/goal ' + 'x'.repeat(4001) },
    { prompt: 'valid', asGoal: 'true' },
  ])
    assert.equal(
      (await h.send('/api/sessions', { requestId: randomUUID(), projectId, ...input })).status,
      400,
    );
  assert.equal(h.desktop.creates, 0);
  const receipt = await (
    await h.send('/api/sessions', {
      requestId: randomUUID(),
      projectId,
      prompt: ' /goal\nFinish this goal ',
    })
  ).json();
  assert.equal(receipt.goal.objective, 'Finish this goal');
  assert.equal(h.desktop.creates, 1);
  assert.equal(h.desktop.sends, 1);
  const plain = await (
    await h.send('/api/sessions', {
      requestId: randomUUID(),
      projectId,
      prompt: 'ordinary message',
      asGoal: false,
    })
  ).json();
  assert.equal(plain.goalState, undefined);
  assert.equal(h.desktop.goals.has(plain.threadId), false);
});

test('a failed goal write preserves the created thread and retries only the goal, with ownership and role checks', async (t) => {
  const h = await harness(t);
  const goal = h.desktop.goal.bind(h.desktop);
  let fail = true,
    writes = 0;
  h.desktop.goal = async (...args) => {
    if (args[1] === 'set') {
      writes++;
      if (fail) throw new ControlError('目标保存失败', false, 502);
    }
    return goal(...args);
  };
  const requestId = randomUUID(),
    input = { requestId, projectId, prompt: 'Save after recovery', asGoal: true };
  const response = await h.send('/api/sessions', input);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.state, 'succeeded');
  assert.equal(receipt.goalState, 'failed');
  assert.ok(receipt.threadId);
  const queried = await (await h.send(`/api/control/requests/${requestId}`)).json();
  assert.equal(queried.threadId, receipt.threadId);
  assert.equal(queried.goalState, 'failed');
  assert.equal((await (await h.send('/api/sessions', input)).json()).threadId, receipt.threadId);
  assert.equal(writes, 1);
  await h.send('/api/users', {
    username: 'other-admin',
    password: 'another-password',
    role: 'admin',
  });
  const other = (await h.application.auth.login('other-admin', 'another-password'))!;
  const otherToken = h.application.auth.issue(other, 'other').token;
  assert.equal(
    (await h.send(`/api/control/requests/${requestId}/goal`, {}, otherToken)).status,
    404,
  );
  await h.send('/api/users', { username: 'viewer', password: 'another-password', role: 'viewer' });
  const viewer = (await h.application.auth.login('viewer', 'another-password'))!;
  assert.equal(
    (
      await h.send(
        `/api/control/requests/${requestId}/goal`,
        {},
        h.application.auth.issue(viewer, 'viewer').token,
      )
    ).status,
    403,
  );
  fail = false;
  const retries = await Promise.all([
    h.send(`/api/control/requests/${requestId}/goal`, {}),
    h.send(`/api/control/requests/${requestId}/goal`, {}),
  ]);
  for (const retry of retries) {
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).goalState, 'saved');
  }
  assert.equal(writes, 2);
  assert.deepEqual(
    h.application.auth.db.prepare("SELECT action,username,ip FROM audit WHERE action='creation_goal_retried'")
      .all().map((entry) => ({ ...entry })),
    [{ action: 'creation_goal_retried', username: 'owner', ip: '127.0.0.1' }],
  );
  assert.equal(h.desktop.creates, 1);
  assert.equal(h.desktop.sends, 1);
});

test('an uncertain delivered goal is read back without reactivating a completed goal or resending work', async (t) => {
  const h = await harness(t);
  const goal = h.desktop.goal.bind(h.desktop);
  let writes = 0;
  h.desktop.goal = async (...args) => {
    if (args[1] !== 'set') return goal(...args);
    writes++;
    const result = await goal(...args);
    result.status = 'complete';
    throw new ControlError('写入回执丢失', true, 504);
  };
  const requestId = randomUUID();
  const created = await (
    await h.send('/api/sessions', {
      requestId,
      projectId,
      prompt: 'Already completed',
      asGoal: true,
    })
  ).json();
  assert.equal(created.goalState, 'unknown');
  const retry = await (await h.send(`/api/control/requests/${requestId}/goal`, {})).json();
  assert.equal(retry.goalState, 'saved');
  assert.equal(retry.goal.status, 'complete');
  assert.equal(writes, 1);
  assert.equal(h.desktop.creates, 1);
  assert.equal(h.desktop.sends, 1);
});

test('goal recovery preserves a replacement target and a restarted creation checkpoint', async (t) => {
  const h = await harness(t);
  const goal = h.desktop.goal.bind(h.desktop);
  h.desktop.goal = async (...args) => {
    if (args[1] === 'set') throw new ControlError('目标保存失败', false, 502);
    return goal(...args);
  };
  const requestId = randomUUID(),
    input = { requestId, projectId, prompt: 'Original objective', asGoal: true };
  const created = await (await h.send('/api/sessions', input)).json();
  h.application.auth.db
    .prepare("UPDATE control_requests SET state='pending' WHERE id=?")
    .run(requestId);
  await h.restart();
  const recovered = await (await h.send(`/api/control/requests/${requestId}`)).json();
  assert.equal(recovered.state, 'succeeded');
  assert.equal(recovered.threadId, created.threadId);
  assert.equal(recovered.goalState, 'unknown');
  assert.equal((await (await h.send('/api/sessions', input)).json()).threadId, created.threadId);
  h.desktop.goals.set(created.threadId, { objective: 'A later user objective', status: 'paused' });
  const retry = await (await h.send(`/api/control/requests/${requestId}/goal`, {})).json();
  assert.equal(retry.goalState, 'conflict');
  assert.equal(retry.goal.objective, 'A later user objective');
  assert.equal(retry.goal.status, 'paused');
  assert.equal(h.desktop.creates, 1);
  assert.equal(h.desktop.sends, 1);
});

test('revocation after creation prevents goal writes, and archived threads reject goal recovery', async (t) => {
  const h = await harness(t);
  const goal = h.desktop.goal.bind(h.desktop);
  let writes = 0;
  h.desktop.goal = async (...args) => {
    if (args[1] === 'get') h.application.auth.revoke(h.owner.id, h.login.sessionId);
    else if (args[1] === 'set') writes++;
    return goal(...args);
  };
  const requestId = randomUUID();
  const created = await (
    await h.send('/api/sessions', {
      requestId,
      projectId,
      prompt: 'Must not save after revocation',
      asGoal: true,
    })
  ).json();
  assert.equal(created.goalState, 'failed');
  assert.equal(writes, 0);
  assert.equal(h.desktop.creates, 1);
  h.desktop.goal = goal;
  const renewed = h.application.auth.issue(h.owner, 'renewed').token;
  h.f.state.prepare('UPDATE threads SET archived=1 WHERE id=?').run(created.threadId);
  assert.equal((await h.send(`/api/control/requests/${requestId}/goal`, {}, renewed)).status, 409);
  assert.equal(h.desktop.goals.size, 0);
});
