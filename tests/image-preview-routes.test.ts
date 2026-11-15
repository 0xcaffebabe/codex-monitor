import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';
import { previewPng } from './image-preview-fixture.js';
import { screenshot, seedComputerUse } from './computer-use-fixture.js';

test('authorized image variants cover messages, image views, Computer Use and uploads without weakening source permissions', async () => {
  const f = fixture(),
    data = await previewPng();
  const file = path.join(f.root, '大图 preview.png');
  writeFileSync(file, data);
  const log = seedComputerUse(f.home, f.hist);
  writeFileSync(
    log,
    readFileSync(log, 'utf8').replaceAll(
      screenshot,
      `data:image/png;base64,${data.toString('base64')}`,
    ),
  );
  for (const [id, item] of [
    ['compressed-message', { type: 'agentMessage', text: `![图片](${pathToFileURL(file).href})` }],
    ['compressed-view', { type: 'imageView', path: file }],
  ] as const) {
    f.hist
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(ids.modern, 'turn-1', id, 400, Date.now(), JSON.stringify(item), null, null);
  }
  const application = createApp(f.config),
    server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await application.auth.setup('owner', 'image-preview-password!');
  const login = application.auth.issue(owner, 'preview tests');
  const other = { ...owner, id: randomUUID(), username: 'other' };
  application.auth.db
    .prepare('INSERT INTO users SELECT ?,?,password,role,created_at FROM users WHERE id=?')
    .run(other.id, other.username, owner.id);
  const otherLogin = application.auth.issue(other, 'another account');
  const get = (route: string, token = login.token) =>
    fetch(base + route, { headers: { Authorization: `Bearer ${token}` } });
  const variant = 'variant=thumbnail&format=avif';
  try {
    for (const route of [
      `/api/sessions/${ids.modern}/images/compressed-message?index=0&`,
      `/api/sessions/${ids.modern}/images/compressed-view?`,
      `/api/sessions/${ids.modern}/computer-use/cu-0/images/0?`,
    ]) {
      const response = await get(route + variant);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-type')!, /^image\/avif/);
      const encoded = Buffer.from(await response.arrayBuffer());
      assert.ok(encoded.length < data.length);
      assert.equal((await sharp(encoded).metadata()).width, 720);
      assert.equal((await get(route + variant, '')).status, 401);
      assert.deepEqual(
        Buffer.from(await (await get(route + 'variant=original')).arrayBuffer()),
        data,
      );
      assert.equal((await get(route + 'variant=preview&format=unknown')).status, 400);
      assert.equal((await get(route + 'variant=thumbnail&width=100000')).status, 400);
    }
    const hidden = `/api/sessions/${ids.archived}/images/compressed-view?${variant}`;
    assert.equal((await get(hidden)).status, 404);
    f.hist.prepare("DELETE FROM thread_items WHERE item_id='compressed-view'").run();
    assert.equal(
      (await get(`/api/sessions/${ids.modern}/images/compressed-view?${variant}`)).status,
      404,
    );

    const upload = await fetch(base + '/api/uploads?name=preview.png', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${login.token}`,
        'Content-Type': 'application/octet-stream',
        'X-Upload-Type': 'image/png',
      },
      body: data,
    });
    assert.equal(upload.status, 201);
    const attachment = await upload.json(),
      route = `/api/uploads/${attachment.id}`;
    const thumbnail = await get(`${route}?variant=thumbnail&format=webp`);
    assert.match(thumbnail.headers.get('content-type')!, /^image\/webp/);
    assert.equal((await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata()).width, 720);
    assert.equal((await get(`${route}?${variant}`, otherLogin.token)).status, 400);
    const original = await get(route);
    assert.equal(original.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), data);
    await fetch(base + route, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${login.token}` },
    });
    assert.equal((await get(`${route}?${variant}`)).status, 400);
    assert.deepEqual(readFileSync(file), data);
  } finally {
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
