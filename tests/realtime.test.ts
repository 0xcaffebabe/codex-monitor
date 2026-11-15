import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';
import { FixtureDesktop } from './control-fixture.js';

test('SSE viewers share slow polls, enforce connection limits, release slots and stop revoked streams', async () => {
  const f = fixture();
  f.config.pollMs = 30;
  const service = createApp(f.config, { control: new FixtureDesktop(f) });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await service.auth.setup('owner', 'a-long-password');
  const first = service.auth.issue(owner, 'first'),
    second = service.auth.issue(owner, 'second');
  let release!: () => void, reached!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let overviewCalls = 0;
  const overview = service.source.overview.bind(service.source);
  service.source.overview = async () => {
    overviewCalls++;
    reached();
    await wait;
    return overview();
  };
  const version = service.source.version.bind(service.source);
  service.source.version = async (id) => {
    if (id === ids.legacy) throw new Error('One session is unavailable');
    return version(id);
  };
  const controllers: AbortController[] = [];
  const connect = (token: string, threadId = ids.modern) => {
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(base + `/api/stream?session=${threadId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  };
  try {
    const connections = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        connect(index < 5 ? first.token : second.token, index === 4 ? ids.legacy : ids.modern),
      ),
    );
    assert.ok(connections.every((response) => response.status === 200));
    const readers = connections.map((response) => response.body!.getReader());
    for (const reader of readers)
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
    await started;
    await delay(100);
    assert.equal(overviewCalls, 1, 'one slow source read is shared by all six viewers');
    assert.equal((await connect(first.token)).status, 429);
    controllers[0].abort();
    await delay(50);
    const replacement = await connect(first.token);
    assert.equal(replacement.status, 200, 'disconnect releases the device slot');
    service.auth.revoke(owner.id, second.sessionId);
    release();
    assert.match(new TextDecoder().decode((await readers[1].read()).value), /event: update/);
    assert.match(new TextDecoder().decode((await readers[4].read()).value), /event: source-error/);
    let text = '';
    for (;;) {
      const result = await readers[5].read();
      if (result.done) break;
      text += new TextDecoder().decode(result.value);
    }
    assert.match(text, /event: unauthorized/);
    assert.doesNotMatch(
      text,
      /event: update/,
      'revocation during a slow poll must not deliver another update',
    );
  } finally {
    release();
    for (const controller of controllers) controller.abort();
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
