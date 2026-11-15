import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';

test('message image previews resolve recorded Markdown with authentication and stay scoped to the message', async () => {
  const f = fixture(),
    application = createApp(f.config),
    server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await application.auth.setup('reader', 'message-images-password!');
  application.auth.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(owner.id);
  const session = application.auth.issue({ ...owner, role: 'viewer' }, 'message images');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPwmJZHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEvsMEwbybntAAAAAElFTkSuQmCC',
    'base64',
  );
  const directory = path.join(f.root, '图片 with spaces');
  mkdirSync(directory);
  const first = path.join(directory, '月同期对比 (1).png'),
    second = path.join(directory, 'second.png'),
    fake = path.join(directory, 'fake.png');
  writeFileSync(first, png);
  writeFileSync(second, Buffer.concat([png, Buffer.from('second')]));
  writeFileSync(fake, 'not an image');
  const text = [
    `正文图片：![已发布的月同期对比](<${first.replaceAll('\\', '/')}>).`,
    '![第二张][saved]',
    `[saved]: ${pathToFileURL(second).href}`,
    `![伪图片](<${fake.replaceAll('\\', '/')}>)`,
    '![远程图片](https://example.invalid/tracker.png)',
    '![网络共享](file://untrusted.invalid/share/picture.png)',
    `[普通文件链接](${pathToFileURL(second).href})`,
    '```markdown',
    `![代码示例](${pathToFileURL(second).href})`,
    '```',
  ].join('\n\n');
  f.hist
    .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
    .run(
      ids.modern,
      'turn-1',
      'message-images',
      100,
      Date.now(),
      JSON.stringify({ type: 'agentMessage', text }),
      null,
      null,
    );
  const get = (id: string, index: string, authorized = true, thread: string = ids.modern) =>
    fetch(`${base}/api/sessions/${thread}/images/${id}?${index}`, {
      headers: authorized ? { Authorization: 'Bearer ' + session.token } : {},
    });
  try {
    const detail = await application.source.detail(ids.modern),
      event = detail!.events.find((event) => event.id === 'message-images')!;
    assert.deepEqual(
      event.images?.map((image) => image.name),
      ['已发布的月同期对比', '第二张', '伪图片'],
    );
    assert.equal((await get('message-images', 'index=0', false)).status, 401);
    const response = await get('message-images', 'index=0');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type')!, /image\/png/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.deepEqual(
      Buffer.from(await (await get('message-images', 'index=1')).arrayBuffer()),
      Buffer.concat([png, Buffer.from('second')]),
    );
    assert.equal((await get('message-images', 'index=2')).status, 415);
    assert.equal((await get('message-images', 'index=3')).status, 404);
    assert.equal((await get('message-images', 'index=-1')).status, 400);
    assert.equal(
      (await get('message-images', 'index=0&path=' + encodeURIComponent(second))).status,
      400,
    );
    assert.equal((await get('message-images', 'index=0', true, ids.archived)).status, 404);
    assert.equal((await get('tool-1', 'index=0')).status, 404);
  } finally {
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('legacy and realtime message images remain available without an image-view operation', async () => {
  const f = fixture(),
    application = createApp(f.config),
    file = path.join(f.root, 'message.png'),
    png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  writeFileSync(file, png);
  const text = `![历史消息](${pathToFileURL(file).href})`;
  appendFileSync(
    path.join(f.home, 'sessions', `rollout-${ids.legacy}.jsonl`),
    JSON.stringify({
      type: 'response_item',
      payload: { id: 'legacy-image', type: 'message', role: 'assistant', content: [{ text }] },
    }) + '\n',
  );
  f.hist
    .prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)')
    .run(
      ids.modern,
      'realtime-image',
      100,
      Date.now(),
      JSON.stringify({ type: 'agentMessage', text }),
    );
  try {
    for (const [thread, id] of [
      [ids.legacy, 'legacy-image'],
      [ids.modern, 'realtime-image'],
    ]) {
      const detail = await application.source.detail(thread),
        image = detail!.events.find((event) => event.id === id)!.images![0];
      assert.equal(image.index, 0);
      const result = await application.source.image(thread, id, 0);
      assert.ok(result && 'file' in result);
      assert.equal(result.file, file);
    }
  } finally {
    await application.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
