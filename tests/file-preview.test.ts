import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.js';
import { messageFiles } from '../server/source/message-files.js';
import type { SessionFilePreview } from '../src/file-preview-types.js';
import { fixture, ids } from './fixture.js';

test('only Markdown links to local files become session file references', () => {
  const text = [
    '[源文件](D:/shared/main.ts:42)',
    '[Windows 路径](</D:/shared/交付 文件.md>)',
    '[相对路径](../shared/log.txt#L5-L7)',
    '[带行号](README.md:20)',
    '[带特殊字符](../报告%231.md)',
    '[引用][doc]',
    '[doc]: <./work/%E8%A1%A8%E6%A0%BC (1).xlsx>',
    '[网页](https://example.com/manual#L42)',
    '[邮件](mailto:123)',
    '[段落](#intro)',
    '[共享路径](file://other-host/private/log.txt)',
    '![原有图片语法](./chart.png)',
    '`[代码内链接](./notes.md)`',
    '```md\n[代码块](./notes.md)\n```',
  ].join('\n\n');
  const files = messageFiles({ id: 'item', kind: 'assistant', text, timestamp: 0 });
  assert.deepEqual(
    files.map(({ path, line, endLine }) => [path, line, endLine]),
    [
      ['D:/shared/main.ts', 42, undefined],
      ['/D:/shared/交付 文件.md', undefined, undefined],
      ['../shared/log.txt', 5, 7],
      ['README.md', 20, undefined],
      ['../报告#1.md', undefined, undefined],
      ['./work/表格 (1).xlsx', undefined, undefined],
    ],
  );
  assert.equal(files[5].offset, text.indexOf('[引用]'));
  const destination = pathToFileURL(path.resolve('notes.md')).href;
  assert.equal(
    messageFiles({ id: 'autolink', kind: 'assistant', text: `<${destination}>`, timestamp: 0 })[0]
      ?.path,
    path.resolve('notes.md'),
  );
});

test('signed-in admins can read referenced files outside the project with bounded previews', async () => {
  const f = fixture();
  const project = path.join(f.root, 'project');
  const deliverables = path.join(f.root, '交付 输出');
  mkdirSync(project);
  mkdirSync(deliverables);
  f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(project, ids.modern);
  const log = path.join(deliverables, '执行记录.txt');
  const report = path.join(deliverables, '验收报告.md');
  const workbook = path.join(deliverables, '验收.xlsx');
  const chart = path.join(deliverables, '截图.png');
  const missing = path.join(deliverables, '已删除.txt');
  const big = path.join(deliverables, '大文件.log');
  const privateFile = path.join(f.home, 'private.txt');
  const privateDirAlias = path.join(deliverables, 'private-alias');
  const aliasFile = path.join(privateDirAlias, 'private.txt');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPwmJZHU8QwasGoBaMWjFowasGoBaMWDBULAEvsMEwbybntAAAAAElFTkSuQmCC',
    'base64',
  );
  const workbookData = Buffer.from([0x50, 0x4b, 3, 4, 0, 0]);
  writeFileSync(
    log,
    Array.from({ length: 3000 }, (_, line) => `执行记录第 ${line + 1} 行`).join('\r\n'),
  );
  writeFileSync(report, '# 验收结果\n\n**通过**\n');
  writeFileSync(workbook, workbookData);
  writeFileSync(chart, png);
  writeFileSync(privateFile, 'private state');
  symlinkSync(f.home, privateDirAlias, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(big, '');
  truncateSync(big, 20 * 1024 * 1024 + 1);
  f.append(
    [
      '[相对引用](<../交付 输出/执行记录.txt#L2501-L2503>)',
      `[本地 URI](<${pathToFileURL(report).href}>)`,
      ...[workbook, chart, missing, big, privateFile, aliasFile].map(
        (file) => `[引用](<${file.replaceAll('\\', '/')}>)`,
      ),
    ].join('\n\n'),
  );
  const service = createApp(f.config);
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const owner = await service.auth.setup('owner', 'preview-admin-password!');
    const admin = service.auth.issue(owner, 'admin preview').token;
    const created = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'viewer',
        password: 'preview-viewer-password!',
        role: 'viewer',
      }),
    });
    assert.equal(created.status, 201);
    const viewer = service.auth.issue(
      (await service.auth.login('viewer', 'preview-viewer-password!'))!,
      'viewer preview',
    ).token;
    const page = await service.source.detail(ids.modern);
    const event = page!.events.find((entry) => entry.text.includes('[相对引用]'))!;
    const files = event.files!;
    const get = (index: number, query = '', token: string | null = admin, id = ids.modern) =>
      fetch(`${base}/api/sessions/${id}/file-preview/${event.id}/${files[index].id}${query}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

    assert.equal((await get(0, '', null)).status, 401);
    assert.equal((await get(0, '', viewer)).status, 403);
    assert.equal((await get(0, '', admin, ids.archived)).status, 404);
    assert.equal((await get(0, '?path=private.txt')).status, 400);
    const response = await get(0);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const preview = (await response.json()) as SessionFilePreview;
    assert.equal(preview.kind, 'text');
    assert.equal(preview.path, realpathSync(log));
    assert.equal(preview.startLine, 2481);
    assert.equal(preview.lines[20], '执行记录第 2501 行');
    assert.equal(preview.endLine, 2503);
    assert.equal(preview.partial, true);
    const note = (await (await get(1)).json()) as SessionFilePreview;
    assert.equal(note.kind, 'markdown');
    assert.equal(note.lines[0], '# 验收结果');
    assert.equal((await (await get(2)).json()).kind, 'download');
    const download = await get(2, '?view=download');
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), workbookData);
    assert.equal((await get(1, '?view=download')).status, 415);
    const image = await get(3, '?view=image');
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal((await get(4)).status, 404);
    assert.equal((await get(5)).status, 413);
    assert.equal((await get(6)).status, 403);
    assert.equal((await get(7)).status, 403);
    f.hist
      .prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)')
      .run(
        ids.modern,
        event.id,
        20,
        Date.now(),
        JSON.stringify({ type: 'agentMessage', text: '[变更后的引用](./another.txt)' }),
      );
    assert.equal((await get(0)).status, 404);
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
