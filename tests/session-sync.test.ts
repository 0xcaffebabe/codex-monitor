import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createApp } from '../server/app.js';
import { fixture } from './fixture.js';
import { FixtureDesktop, projectId } from './control-fixture.js';

test('a successful creation stays pending until indexed, including after a monitor restart', async () => {
  const f = fixture(),
    desktop = new FixtureDesktop(f),
    create = desktop.create.bind(desktop);
  let thread: Record<string, any> | undefined;
  desktop.create = async (...args) => {
    const result = await create(...args);
    thread = f.state.prepare('SELECT * FROM threads WHERE id=?').get(result.threadId);
    // Codex acknowledges creation before its state index becomes readable.
    f.state.prepare('DELETE FROM threads WHERE id=?').run(result.threadId);
    return result;
  };
  let application = createApp(f.config, { control: desktop }),
    server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const user = await application.auth.setup('owner', 'a-long-password'),
    token = application.auth.issue(user, 'sync test').token,
    headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const requestId = randomUUID();
  try {
    const response = await fetch(base() + '/api/sessions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId, projectId, prompt: 'delayed new session' }),
    });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.state, 'succeeded');
    assert.equal(desktop.creates, 1);
    const route = `/api/sessions/${receipt.threadId}`;
    const pending = await fetch(base() + route, { headers });
    assert.equal(pending.status, 202);
    assert.equal(pending.headers.get('Retry-After'), '1');
    assert.deepEqual(await pending.json(), { state: 'syncing' });
    assert.equal((await fetch(base() + route)).status, 401);

    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    application = createApp(f.config, { control: new FixtureDesktop(f) });
    server = application.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.equal((await fetch(base() + route, { headers })).status, 202);

    // A receipt only grants a short synchronization window, never a permanent placeholder.
    application.auth.db
      .prepare('UPDATE control_requests SET result_json=? WHERE id=?')
      .run(JSON.stringify({ ...receipt, acceptedAt: Date.now() - 120001 }), requestId);
    assert.equal((await fetch(base() + route, { headers })).status, 404);

    f.state
      .prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(...Object.values(thread!));
    await application.source.refresh(true);
    const ready = await fetch(base() + route, { headers });
    assert.equal(ready.status, 200);
    const page = await ready.json();
    assert.equal(page.session.id, receipt.threadId);
    assert.ok(page.events.some((event: any) => event.text === 'delayed new session'));
    assert.equal((await fetch(base() + `/api/sessions/${randomUUID()}`, { headers })).status, 404);
  } finally {
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('failed, uncertain and non-creation receipts do not hide a missing session', async () => {
  const f = fixture(),
    application = createApp(f.config, { control: new FixtureDesktop(f) }),
    server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    user = await application.auth.setup('owner', 'a-long-password'),
    token = application.auth.issue(user, 'missing test').token;
  try {
    for (const [state, mode] of [
      ['failed', 'create'],
      ['unknown', 'create'],
      ['pending', 'create'],
      ['succeeded', 'start'],
    ]) {
      const id = randomUUID();
      application.auth.db
        .prepare('INSERT INTO control_requests VALUES(?,?,?,?,?,?)')
        .run(
          randomUUID(),
          user.id,
          'test',
          state,
          JSON.stringify({ mode, threadId: id, acceptedAt: Date.now() }),
          Date.now(),
        );
      const response = await fetch(base + `/api/sessions/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 404, `${state}/${mode} must not imply creation`);
    }
  } finally {
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
