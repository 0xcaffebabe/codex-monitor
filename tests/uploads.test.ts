import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../server/app.js';
import { MAX_UPLOAD_BYTES, UploadStore } from '../server/uploads.js';
import { FixtureDesktop, projectId } from './control-fixture.js';
import { fixture, ids } from './fixture.js';

async function boot(f: ReturnType<typeof fixture>, control: FixtureDesktop, token?: string) {
  const app = createApp(f.config, { control });
  const server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  if (!token) {
    const owner = await app.auth.setup('owner', 'a-long-password');
    token = app.auth.issue(owner, 'uploads').token;
  }
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new UploadStore(app.auth.db, f.config.dataDir);
  return {
    app,
    base,
    token,
    store,
    json: (route: string, body?: object, auth = token) =>
      fetch(base + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
    upload: (name: string, bytes: Uint8Array, auth = token, type = 'application/octet-stream') =>
      fetch(base + '/api/uploads?name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth}`,
          'Content-Type': 'application/octet-stream',
          'X-Upload-Type': type,
        },
        body: bytes as BodyInit,
      }),
    async close() {
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const route = `/api/sessions/${ids.modern}/messages`;

test('uploads preserve binary data, isolate owners, constrain size and append trusted paths for existing/new sessions', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f),
    service = await boot(f, control);
  const prompts: string[] = [];
  const send = control.send.bind(control);
  control.send = async (...args) => {
    prompts.push(args[2]);
    return send(...args);
  };
  try {
    assert.equal((await service.upload('private.txt', Buffer.from('private'), '')).status, 401);
    await service.json('/api/users', {
      username: 'viewer',
      password: 'a-viewer-password',
      role: 'viewer',
    });
    const viewer = (
      await (
        await service.json('/api/auth/login', { username: 'viewer', password: 'a-viewer-password' })
      ).json()
    ).token;
    assert.equal((await service.upload('read-only.txt', Buffer.from('no'), viewer)).status, 403);
    await service.json('/api/users', {
      username: 'other',
      password: 'another-password',
      role: 'admin',
    });
    const other = (
      await (
        await service.json('/api/auth/login', { username: 'other', password: 'another-password' })
      ).json()
    ).token;
    const bytes = Buffer.from([0, 255, 1, 128, 10, 0]);
    const uploaded = await service.upload('../escape/资料.txt', bytes);
    assert.equal(uploaded.status, 201);
    const attachment = await uploaded.json();
    assert.equal(attachment.name, '资料.txt');
    assert.equal(attachment.size, bytes.length);
    const stored = service.store.file(
      service.app.auth.authenticate(service.token!)!.user.id,
      attachment.id,
    ).path;
    assert.ok(path.isAbsolute(stored));
    assert.equal(path.dirname(stored), service.store.directory);
    assert.deepEqual(readFileSync(stored), bytes);
    assert.equal(
      (await service.json('/api/uploads/' + attachment.id, undefined, other)).status,
      400,
    );
    assert.equal(
      (
        await service.json(
          route,
          { requestId: randomUUID(), prompt: 'steal', attachments: [attachment.id] },
          other,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await service.json(route, {
          requestId: randomUUID(),
          prompt: 'no',
          attachments: ['C:/private.txt'],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await service.json(route, {
          requestId: randomUUID(),
          prompt: 'duplicate',
          attachments: [attachment.id, attachment.id],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await service.json(route, {
          requestId: randomUUID(),
          prompt: '/compact',
          attachments: [attachment.id],
        })
      ).status,
      400,
    );
    const message = { requestId: randomUUID(), prompt: '请查看附件', attachments: [attachment.id] };
    for (let i = 0; i < 2; i++) {
      const receipt = await service.json(route, message);
      assert.equal(receipt.status, 200);
    }
    assert.equal(control.sends, 1);
    assert.equal(prompts[0], `请查看附件\n\n附件（已上传到本机临时目录）：\n- ${stored}`);
    assert.equal(
      (
        await fetch(service.base + '/api/uploads/' + attachment.id, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + service.token },
        })
      ).status,
      409,
    );
    const image = await (
      await service.upload('图片.png', bytes, service.token, 'image/png')
    ).json();
    const response = await service.json('/api/uploads/' + image.id);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const created = await service.json('/api/sessions', {
      requestId: randomUUID(),
      projectId,
      prompt: '',
      attachments: [image.id],
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).mode, 'create');
    assert.equal(control.creates, 1);
    assert.ok(prompts[1].startsWith('附件（已上传到本机临时目录）：\n- '));
    const disposable = await (await service.upload('remove.txt', bytes)).json();
    const deletion = await fetch(service.base + '/api/uploads/' + disposable.id, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + service.token },
    });
    assert.equal(deletion.status, 204);
    assert.equal((await service.json('/api/uploads/' + disposable.id)).status, 400);
    const before = readdirSync(service.store.directory).length;
    const oversized = await service.upload('large.bin', new Uint8Array(MAX_UPLOAD_BYTES + 1));
    assert.equal(oversized.status, 413);
    assert.equal(readdirSync(service.store.directory).length, before);
    const chunked = await fetch(service.base + '/api/uploads?name=stream.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + service.token,
        'Content-Type': 'application/octet-stream',
      },
      body: Readable.from([Buffer.alloc(MAX_UPLOAD_BYTES), Buffer.alloc(1)]) as unknown as BodyInit,
      ...{ duplex: 'half' },
    });
    assert.equal(chunked.status, 413);
    assert.equal(readdirSync(service.store.directory).length, before);
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
    rmSync(service.store.directory, { recursive: true, force: true });
  }
});

test('streaming uploads have per-account limits and release capacity and partial files on abort', async () => {
  const f = fixture(),
    service = await boot(f, new FixtureDesktop(f));
  const pending: ReturnType<typeof httpRequest>[] = [];
  const begin = (name: string) => {
    let resolve!: (response: { status: number }) => void;
    const done = new Promise<{ status: number }>((finish) => {
      resolve = finish;
    });
    const request = httpRequest(
      service.base + '/api/uploads?name=' + name,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + service.token,
          'Content-Type': 'application/octet-stream',
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve({ status: response.statusCode! }));
      },
    );
    request.on('error', () => resolve({ status: 0 }));
    request.write('partial');
    pending.push(request);
    return { request, done };
  };
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!check() && Date.now() < deadline) await delay(20);
    assert.ok(check());
  };
  try {
    const first = begin('slow-a.bin'),
      second = begin('slow-b.bin');
    await until(() => {
      try {
        return readdirSync(service.store.directory).length === 2;
      } catch {
        return false;
      }
    });
    assert.equal((await service.upload('blocked.bin', Buffer.from('test'))).status, 429);
    first.request.end('done');
    assert.equal((await first.done).status, 201);
    assert.equal((await service.upload('after.bin', Buffer.from('test'))).status, 201);
    second.request.destroy();
    await second.done;
    await until(
      () => !readdirSync(service.store.directory).some((name) => name.endsWith('-slow-b.bin')),
    );
    assert.equal((await service.upload('after-abort.bin', Buffer.from('test'))).status, 201);
  } finally {
    for (const request of pending) request.destroy();
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
    rmSync(service.store.directory, { recursive: true, force: true });
  }
});

test('shutdown aborts unfinished uploads and removes their partial files before closing', async () => {
  const f = fixture(),
    service = await boot(f, new FixtureDesktop(f));
  let finish!: (status: number) => void;
  const response = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const request = httpRequest(
    service.base + '/api/uploads?name=shutdown.bin',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + service.token,
        'Content-Type': 'application/octet-stream',
      },
    },
    (result) => {
      result.resume();
      result.once('end', () => finish(result.statusCode!));
    },
  );
  request.on('error', () => finish(0));
  try {
    request.write('partial');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        if (readdirSync(service.store.directory).length) break;
      } catch {}
      await delay(20);
    }
    assert.equal(readdirSync(service.store.directory).length, 1);
    await service.app.close();
    request.end();
    assert.equal(await response, 503);
    assert.equal(readdirSync(service.store.directory).length, 0);
  } finally {
    request.destroy();
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
    rmSync(service.store.directory, { recursive: true, force: true });
  }
});

test('attachments survive queued-message restart, cancellation and missing-file errors without resending', async () => {
  const f = fixture(),
    control = new FixtureDesktop(f);
  control.compacting = true;
  let service = await boot(f, control);
  const directory = service.store.directory;
  const prompts: string[] = [],
    send = control.send.bind(control);
  control.send = async (...args) => {
    prompts.push(args[2]);
    return send(...args);
  };
  try {
    const attachment = await (await service.upload('queued.txt', Buffer.from('queue data'))).json();
    const message = { requestId: randomUUID(), prompt: '压缩后读取', attachments: [attachment.id] };
    assert.equal((await service.json(route, message)).status, 202);
    assert.equal(control.sends, 0);
    const token = service.token;
    await service.close();
    service = await boot(f, control, token);
    assert.equal((await service.json(route, message)).status, 202);
    control.compacting = false;
    for (let i = 0; i < 150 && control.sends === 0; i++) await delay(20);
    assert.equal(control.sends, 1);
    assert.ok(prompts[0].includes('queued.txt'));
    assert.ok(readFileSync(prompts[0].split('\n- ')[1], 'utf8') === 'queue data');
    const disposable = await (await service.upload('cancel.txt', Buffer.from('cancel'))).json();
    control.compacting = true;
    const cancelId = randomUUID();
    await service.json(route, {
      requestId: cancelId,
      prompt: 'cancel',
      attachments: [disposable.id],
    });
    assert.equal(
      (await (await service.json(`/api/control/requests/${cancelId}/cancel`, {})).json()).state,
      'cancelled',
    );
    const deleted = await fetch(service.base + '/api/uploads/' + disposable.id, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + service.token },
    });
    assert.equal(deleted.status, 204);
    const missing = await (await service.upload('missing.txt', Buffer.from('gone'))).json();
    unlinkSync(
      service.store.file(service.app.auth.authenticate(service.token!)!.user.id, missing.id).path,
    );
    assert.equal(
      (
        await service.json(route, {
          requestId: randomUUID(),
          prompt: '',
          attachments: [missing.id],
        })
      ).status,
      400,
    );
    assert.equal(control.sends, 1);
  } finally {
    await service.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
