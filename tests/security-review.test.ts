import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop, projectId } from './control-fixture.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('revoked devices cannot dispatch commands or create chats after an asynchronous state check', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f);
  const service = createApp(f.config, { control });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'a-long-password');
  try {
    for (const action of ['goal', 'create'] as const) {
      const reached = gate(),
        proceed = gate();
      const originalState = control.state.bind(control),
        originalProjects = control.projects.bind(control);
      if (action === 'goal')
        control.state = async (...args) => {
          reached.release();
          await proceed.promise;
          return originalState(...args);
        };
      else
        control.projects = async () => {
          reached.release();
          await proceed.promise;
          return originalProjects();
        };
      const login = service.auth.issue(owner, action);
      const response = fetch(
        base + (action === 'goal' ? `/api/sessions/${ids.modern}/commands` : '/api/sessions'),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(
            action === 'goal'
              ? { requestId: randomUUID(), command: 'goal.set', prompt: 'must not run' }
              : { requestId: randomUUID(), projectId, prompt: 'must not create' },
          ),
        },
      );
      await reached.promise;
      service.auth.revoke(owner.id, login.sessionId);
      proceed.release();
      const result = await response;
      assert.equal(result.status, 403, action);
      assert.equal((await result.json()).state, 'failed');
      assert.equal(control.goals.size, 0);
      assert.equal(control.creates, 0);
      assert.equal(control.sends, 0);
      control.state = originalState;
      control.projects = originalProjects;
    }
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('archiving a chat while a command waits prevents dispatch', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    reached = gate(),
    proceed = gate();
  control.state = async () => {
    reached.release();
    await proceed.promise;
    return { status: 'idle', compacting: false, turnId: undefined };
  };
  const service = createApp(f.config, { control }),
    server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'a-long-password'),
    login = service.auth.issue(owner, 'archive');
  try {
    const response = fetch(base + `/api/sessions/${ids.modern}/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), command: 'compact' }),
    });
    await reached.promise;
    f.state.prepare('UPDATE threads SET archived=1 WHERE id=?').run(ids.modern);
    proceed.release();
    assert.equal((await response).status, 409);
    assert.equal(control.compactions, 0);
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('commands recheck local device authorization after the final remote authorization check', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    reached = gate(),
    proceed = gate();
  control.state = async () => ({ status: 'idle', compacting: false, turnId: undefined });
  let checks = 0;
  const service = createApp(f.config, {
    control,
    authorization: {
      device: async () => {
        // The command's last check runs after its asynchronous desktop and source reads.
        if (++checks === 3) {
          reached.release();
          await proceed.promise;
        }
        return true;
      },
      user: async () => true,
    },
  });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'a-long-password'),
    login = service.auth.issue(owner, 'remote authorization');
  try {
    const response = fetch(base + `/api/sessions/${ids.modern}/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), command: 'compact' }),
    });
    await reached.promise;
    service.auth.revoke(owner.id, login.sessionId);
    proceed.release();
    const result = await response;
    assert.equal(result.status, 403);
    assert.equal((await result.json()).state, 'failed');
    assert.equal(control.compactions, 0);
  } finally {
    proceed.release();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('password changes require the current device to remain authorized', async () => {
  const f = fixture(),
    service = createApp(f.config, { control: new FixtureDesktop(f) });
  const owner = await service.auth.setup('owner', 'a-long-password');
  const revoked = service.auth.issue(owner, 'revoked'),
    retained = service.auth.issue(owner, 'retained');
  try {
    service.auth.revoke(owner.id, revoked.sessionId);
    assert.equal(
      await service.auth.changePassword(owner.id, 'a-new-long-password', revoked.sessionId),
      false,
    );
    assert.ok(await service.auth.login(owner.username, 'a-long-password'));
    assert.ok(service.auth.authenticate(retained.token));
    assert.equal(
      await service.auth.changePassword(owner.id, 'a-new-long-password', retained.sessionId),
      true,
    );
    assert.ok(await service.auth.login(owner.username, 'a-new-long-password'));
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('shutdown stops waiting commands without writing to closed databases or dispatching later', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    reached = gate(),
    proceed = gate();
  control.state = async () => {
    reached.release();
    await proceed.promise;
    return { status: 'idle', compacting: false, turnId: undefined };
  };
  const service = createApp(f.config, { control }),
    server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'a-long-password'),
    login = service.auth.issue(owner, 'shutdown');
  try {
    const response = fetch(base + `/api/sessions/${ids.modern}/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), command: 'compact' }),
    });
    await reached.promise;
    await service.close();
    proceed.release();
    const result = await response;
    assert.equal(result.status, 503);
    assert.equal((await result.json()).state, 'unknown');
    assert.equal(control.compactions, 0);
  } finally {
    proceed.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
