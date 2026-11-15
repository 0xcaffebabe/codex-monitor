import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CodexSource } from '../server/source.js';
import { createApp } from '../server/app.js';
import { isComputerUseCall, screenshotMedia } from '../server/source/computer-use-parser.js';
import { fixture, ids } from './fixture.js';
import {
  computerUseRecords,
  screenshot,
  screenshotB,
  seedComputerUse,
} from './computer-use-fixture.js';

test('Computer Use merges persisted calls with complete log images and keeps screenshots on their own step', async () => {
  const f = fixture();
  seedComputerUse(f.home, f.hist);
  const source = new CodexSource(f.home);
  try {
    assert.equal((await source.detail(ids.modern))!.hasComputerUse, true);
    assert.equal((await source.detail(ids.legacy))!.hasComputerUse, false);
    const page = (await source.computerUse(ids.modern))!;
    assert.equal(page.total, 3);
    assert.deepEqual(
      page.steps.map((step) => step.screenshots),
      [1, 0, 2],
    );
    assert.equal(page.steps[2].title, '查看查询结果');
    assert.equal(page.steps[2].url, 'https://example.test/query');
    assert.equal(page.steps[2].pageTitle, '业务查询');
    assert.equal(page.steps[2].durationMs, 120);
    assert.ok(!JSON.stringify(page).includes('base64'));
    assert.ok(!JSON.stringify(page).includes('getByRole'));
    assert.deepEqual(
      (await source.computerUseImage(ids.modern, 'cu-2', 1))!.data,
      Buffer.from(screenshotB.split(',')[1], 'base64'),
    );
    assert.deepEqual(
      (await source.computerUseImage(ids.modern, 'cu-0', 0))!.data,
      Buffer.from(screenshot.split(',')[1], 'base64'),
    );
    assert.equal(await source.computerUseImage(ids.modern, 'cu-1', 0), null);
    assert.equal(await source.computerUseImage(ids.legacy, 'cu-0', 0), null);
    assert.equal(await source.computerUseImage(ids.modern, 'cu-2', 3), null);
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Computer Use finds older calls, pages history and appends a partial live record exactly once', async () => {
  const f = fixture(),
    file = seedComputerUse(f.home, f.hist, 105),
    source = new CodexSource(f.home);
  try {
    // Availability must not depend on whether the last detail page contains a CU call.
    for (let n = 0; n < 75; n++) f.append(`后续普通回复 ${n}`);
    assert.equal((await source.detail(ids.modern, undefined, 10))!.hasComputerUse, true);
    const page = (await source.computerUse(ids.modern))!;
    assert.equal(page.steps.length, 100);
    assert.equal(page.before, 5);
    assert.equal((await source.computerUse(ids.modern, page.before!))!.steps.length, 5);
    const next = computerUseRecords(105, 1);
    const line = JSON.stringify(next.records[0]);
    appendFileSync(file, line.slice(0, 40));
    assert.equal((await source.computerUse(ids.modern))!.total, 105);
    appendFileSync(
      file,
      line.slice(40) +
        '\n' +
        next.records
          .slice(1)
          .map((record) => JSON.stringify(record))
          .join('\n') +
        '\n',
    );
    const [one, two] = await Promise.all([
      source.computerUse(ids.modern),
      source.computerUse(ids.modern),
    ]);
    assert.equal(one!.total, 106);
    assert.equal(two!.total, 106);
    assert.equal((await source.computerUseImage(ids.modern, next.id, 0))!.mime, 'image/png');
    // Replacing or truncating a log invalidates byte offsets rather than serving another step's image.
    f.hist.prepare('DELETE FROM thread_items WHERE thread_id=?').run(ids.modern);
    writeFileSync(
      file,
      JSON.stringify({ type: 'session_meta', payload: { id: ids.modern } }) + '\n',
    );
    assert.equal((await source.computerUse(ids.modern))!.total, 0);
    assert.equal(await source.computerUseImage(ids.modern, next.id, 0), null);
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Computer Use supports JSONL-only desktop calls and safely handles absent or disallowed logs', async () => {
  const f = fixture(),
    source = new CodexSource(f.home);
  try {
    const file = path.join(f.home, 'sessions', `rollout-${ids.legacy}.jsonl`);
    const row = computerUseRecords(0);
    const call = row.records[0].payload as any;
    call.namespace = 'mcp__node_repl';
    call.arguments = JSON.stringify({
      code: 'await sky.get_window_state({window:targetWindow});',
      title: '查看桌面窗口',
    });
    const event = row.records[1].payload as any;
    event.item.server = 'node_repl';
    event.item.arguments = JSON.parse(call.arguments);
    appendFileSync(file, row.records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    assert.equal((await source.detail(ids.legacy))!.hasComputerUse, true);
    assert.equal((await source.computerUse(ids.legacy))!.steps[0].title, '查看桌面窗口');
    assert.ok(await source.computerUseImage(ids.legacy, row.id, 0));
    seedComputerUse(f.home, f.hist);
    unlinkSync(path.join(f.home, 'sessions', `rollout-${ids.modern}.jsonl`));
    assert.equal((await source.computerUse(ids.modern))!.total, 3);
    assert.equal(await source.computerUseImage(ids.modern, 'cu-0', 0), null);
    const privateFile = path.join(f.root, 'private.jsonl');
    writeFileSync(privateFile, readFileSync(file));
    assert.equal((await source.computerUse(ids.outside))!.total, 0);
    assert.equal(await source.computerUseImage(ids.outside, row.id, 0), null);
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Computer Use rejects truncated images, remote images and unrelated tool calls', () => {
  assert.equal(screenshotMedia(screenshot.slice(0, 60) + '…100 chars truncated…'), null);
  assert.equal(screenshotMedia('https://example.test/screenshot.png'), null);
  assert.equal(
    isComputerUseCall({ server: 'node_repl', tool: 'js', arguments: { code: 'console.log(1)' } }),
    false,
  );
  assert.equal(
    isComputerUseCall({
      server: 'cua_repl',
      tool: 'js',
      arguments: { completion_summary: '检查完成' },
    }),
    false,
  );
  assert.equal(
    isComputerUseCall({
      namespace: 'mcp__cua_repl',
      name: 'js',
      arguments: '{"code":"await tab.getScreenshot()"}',
    }),
    true,
  );
});

test('Computer Use keeps database-only screenshots available when realtime items move into history', async () => {
  const f = fixture();
  unlinkSync(path.join(f.home, 'sessions', `rollout-${ids.modern}.jsonl`));
  const item = computerUseRecords(0).item;
  item.result = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          content: [{ type: 'input_image', image_url: screenshot }],
        }),
      },
    ],
  };
  f.hist
    .prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)')
    .run(ids.modern, item.id, 20, Date.now(), JSON.stringify(item));
  const source = new CodexSource(f.home);
  try {
    assert.equal((await source.detail(ids.modern))!.hasComputerUse, true);
    assert.equal((await source.computerUse(ids.modern))!.steps[0].screenshots, 1);
    assert.equal((await source.computerUseImage(ids.modern, item.id, 0))!.mime, 'image/png');
    f.hist.prepare('DELETE FROM thread_realtime_items WHERE thread_id=?').run(ids.modern);
    f.hist
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(
        ids.modern,
        'turn-1',
        item.id,
        20,
        Date.now(),
        JSON.stringify(item),
        Date.now(),
        Date.now(),
      );
    f.state
      .prepare('UPDATE threads SET updated_at_ms=? WHERE id=?')
      .run(Date.now() + 1, ids.modern);
    await source.refresh(true);
    assert.equal((await source.computerUseImage(ids.modern, item.id, 0))!.mime, 'image/png');
    assert.equal((await source.computerUse(ids.modern))!.total, 1);
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Computer Use endpoints require login, validate identifiers and return only recorded session images', async () => {
  const f = fixture();
  seedComputerUse(f.home, f.hist);
  const application = createApp(f.config),
    server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const user = await application.auth.setup('owner', 'long-test-password!'),
    session = application.auth.issue(user, 'cu test');
  const get = (suffix: string, authorized = true) =>
    fetch(base + suffix, {
      headers: authorized ? { Authorization: `Bearer ${session.token}` } : {},
    });
  try {
    const route = `/api/sessions/${ids.modern}/computer-use`;
    assert.equal((await get(route, false)).status, 401);
    assert.equal((await get(route + '/cu-0/images/0', false)).status, 401);
    const timeline = await get(route);
    assert.equal(timeline.status, 200);
    assert.equal((await timeline.json()).total, 3);
    const image = await get(route + '/cu-2/images/1');
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(image.headers.get('cache-control')!, /no-store/);
    assert.deepEqual(
      Buffer.from(await image.arrayBuffer()),
      Buffer.from(screenshotB.split(',')[1], 'base64'),
    );
    assert.equal((await get(route + '?limit=201')).status, 400);
    assert.equal((await get(route + '/cu-0/images/-1')).status, 400);
    assert.equal((await get(route + '/not-recorded/images/0')).status, 404);
    assert.equal((await get(`/api/sessions/${ids.legacy}/computer-use/cu-0/images/0`)).status, 404);
  } finally {
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
