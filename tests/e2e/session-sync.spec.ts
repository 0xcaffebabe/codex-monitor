import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ids } from '../fixture.js';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');

async function enter(page: Page, request: APIRequestContext) {
  await page.route('**/api/notifications/completions', (route) =>
    route.fulfill({ json: { generation: 'session-sync-test', revision: 0, notifications: [] } }),
  );
  const status = await (await request.get('/api/auth/status')).json();
  const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
  const login = () =>
    request.post(status.configured ? '/api/auth/login' : '/api/auth/setup', {
      data: status.configured
        ? credentials
        : {
            ...credentials,
            setupKey: readFileSync(path.join(root, 'data', 'setup-key.txt'), 'utf8').trim(),
          },
    });
  let response = await login();
  if (response.status() === 429) {
    const waitMs =
      Math.min(60, Math.max(1, Number(response.headers()['retry-after']) || 60)) * 1000 + 100;
    test.setTimeout(test.info().timeout + waitMs);
    await delay(waitMs);
    response = await login();
  }
  expect(response.ok()).toBeTruthy();
  const { token } = await response.json();
  await page.addInitScript((token) => localStorage.setItem('codex-monitor.auth.v1', token), token);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部会话', exact: true })).toBeVisible();
}

test('a generated title updates the conversation heading and recent sessions without reloading', async ({
  page,
  request,
}) => {
  const index = path.join(root, 'codex', 'session_index.jsonl');
  let original: Buffer;
  try {
    original = readFileSync(index);
  } catch {
    original = Buffer.alloc(0);
  }
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.locator('.detail-heading h1')).toHaveText('开发 codex-monitor 实时监控');
  await expect(page.locator('.connection')).toContainText('实时同步');
  const title = `自动概括会话标题 ${test.info().project.name}`;
  try {
    appendFileSync(index, JSON.stringify({ id: ids.modern, thread_name: title }) + '\n');
    await expect(page.locator('.detail-heading h1')).toHaveText(title, { timeout: 8000 });
    if (test.info().project.name === 'mobile') {
      await page.getByRole('button', { name: '打开菜单', exact: true }).click();
      await expect(
        page.getByRole('button', { name: `打开会话：${title}`, exact: true }),
      ).toBeVisible();
    } else await expect(page.getByTestId('session-row').filter({ hasText: title })).toBeVisible();
  } finally {
    writeFileSync(index, original);
  }
});

test('new sessions wait for synchronization, survive reload and recover without SSE', async ({
  page,
  request,
}) => {
  let ready = false,
    reads = 0,
    earlyOutlines = 0,
    creates = 0,
    createdId: string | undefined;
  await page.route('**/api/workspaces/local/stream**', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' }),
  );
  await page.route(/\/api\/workspaces\/local\/sessions\/[a-f\d-]{36}(?:\?.*)?$/, (route) => {
    reads++;
    return ready ? route.continue() : route.fulfill({ status: 202, json: { state: 'syncing' } });
  });
  await page.route('**/api/workspaces/local/sessions/*/outline', (route) => {
    if (!ready) earlyOutlines++;
    return route.continue();
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/workspaces/local/sessions'))
      creates++;
  });
  try {
    await enter(page, request);
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const prompt = 'delayed index ' + test.info().project.name;
    await page.getByLabel('发送给 Codex 的消息').fill(prompt);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/workspaces/local/sessions'),
    );
    await page.getByRole('button', { name: '创建并发送' }).click();
    createdId = (await (await created).json()).threadId;
    await expect(page.getByRole('region', { name: '新建会话', exact: true })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '正在同步记录' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    expect(earlyOutlines).toBe(0);

    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: '正在同步记录' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    ready = true;
    await expect(
      page.locator('.timeline').getByText('测试回复：' + prompt, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('新会话已创建，正在同步记录…', { exact: true })).toHaveCount(0);
    expect(creates).toBe(1);
    expect(earlyOutlines).toBe(0);
  } finally {
    if (createdId) {
      const hist = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
      const state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite'));
      hist.prepare('DELETE FROM thread_items WHERE thread_id=?').run(createdId);
      hist.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(createdId);
      state.prepare('DELETE FROM threads WHERE id=?').run(createdId);
      hist.close();
      state.close();
    }
  }
});

test('switching sessions cancels the synchronization retry', async ({ page, request }) => {
  let reads = 0;
  await page.route(`**/api/workspaces/local/sessions/${ids.modern}`, (route) => {
    reads++;
    return route.fulfill({ status: 202, json: { state: 'syncing' } });
  });
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.getByText('新会话已创建，正在同步记录…', { exact: true })).toBeVisible();
  await page.clock.install();
  await page.getByTitle('返回会话列表').click();
  await page
    .getByTestId('session-row')
    .filter({ hasText: '检查旧版本会话解析' })
    .filter({ hasText: '本机工作空间' })
    .click();
  await expect(
    page.locator('.timeline').getByText('旧版会话读取成功。', { exact: true }),
  ).toBeVisible();
  const previousReads = reads;
  await page.clock.fastForward(5000);
  expect(reads).toBe(previousReads);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('synchronization has a timeout, supports retry and retains real not-found errors', async ({
  page,
  request,
}) => {
  let ready = false,
    syncUpdateSent = false;
  await page.route(`**/api/workspaces/local/sessions/${ids.modern}`, (route) =>
    ready ? route.continue() : route.fulfill({ status: 202, json: { state: 'syncing' } }),
  );
  await page.route('**/api/workspaces/local/stream**', (route) => {
    let body = 'event: ready\ndata: {}\n\n';
    if (route.request().url().includes(`session=${ids.modern}`) && !syncUpdateSent) {
      syncUpdateSent = true;
      body += 'event: update\ndata: {}\n\n';
    }
    return route.fulfill({ contentType: 'text/event-stream', body });
  });
  await enter(page, request);
  await page.clock.install();
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.getByText('新会话已创建，正在同步记录…', { exact: true })).toBeVisible();
  await page.clock.fastForward(45001);
  await expect(page.getByRole('alert')).toContainText('新会话记录同步较慢，请稍后重试');
  await expect(page.getByText('新会话已创建，正在同步记录…', { exact: true })).toHaveCount(0);
  ready = true;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.timeline .user-message')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.goto('/?session=99999999-9999-4999-8999-999999999999');
  await expect(page.getByRole('alert')).toContainText('找不到此会话');
});
