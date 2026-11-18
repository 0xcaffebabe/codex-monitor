import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompletionNotificationSnapshot } from '../../src/types';
import { ids } from '../fixture.js';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
const remote = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const completionPath = '/api/notifications/completions';
const localTitle = '开发 codex-monitor 实时监控';

async function start(page: Page, request: APIRequestContext) {
  const { configured } = await (await request.get('/api/auth/status')).json();
  const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
  const response = await request.post(configured ? '/api/auth/login' : '/api/auth/setup', {
    data: configured
      ? credentials
      : {
          ...credentials,
          setupKey: readFileSync(path.join(root, 'data', 'setup-key.txt'), 'utf8').trim(),
        },
  });
  expect(response.ok()).toBeTruthy();
  const { token } = await response.json();
  const headers = { Authorization: `Bearer ${token}` };
  const settings = await request.put('/api/notifications', {
    headers,
    data: { enabled: false, provider: 'lark', publicUrl: '' },
  });
  expect(settings.ok()).toBeTruthy();
  const { generation, notifications }: CompletionNotificationSnapshot = await (
    await request.get(completionPath, { headers })
  ).json();
  if (notifications.length) {
    const cleared = await request.post(`${completionPath}/dismiss`, {
      headers,
      data: { generation, ids: notifications.map((item) => item.id) },
    });
    expect(cleared.ok()).toBeTruthy();
  }
  await page
    .context()
    .addInitScript((value) => localStorage.setItem('codex-monitor.auth.v1', value), token);
  const baseline = page.waitForResponse(
    (result) => result.url().endsWith(completionPath) && result.ok(),
  );
  await page.goto('/?workspace=local');
  await baseline;
  await expect(completionRegion(page)).toHaveCount(0);
  return headers;
}

function completionRegion(page: Page) {
  return page.getByRole('region', { name: '任务完成通知' });
}

async function send(
  request: APIRequestContext,
  headers: Record<string, string>,
  workspace = 'local',
) {
  const response = await request.post(
    `/api/workspaces/${workspace}/sessions/${ids.modern}/messages`,
    {
      headers,
      data: { requestId: randomUUID(), prompt: `网页完成通知验收-${Date.now()}` },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
}

test('completion appears without Webhook and stays clear of mobile navigation', async ({
  page,
  request,
  isMobile,
}) => {
  const headers = await start(page, request);
  await send(request, headers);
  const region = completionRegion(page);
  await expect(region.getByText('任务已完成', { exact: true })).toHaveCount(1);
  const bounds = (await region.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y).toBeGreaterThan(viewport.height / 2);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  if (isMobile) {
    const shortcut = page.getByRole('button', { name: '查看运行中的会话', exact: true });
    await expect(shortcut).toBeVisible();
    expect(bounds.y + bounds.height).toBeLessThan((await shortcut.boundingBox())!.y);
    await shortcut.click();
    await expect(page.getByRole('dialog', { name: '运行中的会话', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
  } else expect(bounds.x).toBeGreaterThan(viewport.width / 2);
  await page.screenshot({ path: test.info().outputPath('completion-notification.png') });
  await region.getByRole('button', { name: `关闭通知：${localTitle}`, exact: true }).click();
  await expect(region).toHaveCount(0);
});

test('completion card opens the session across workspaces', async ({ page, request }) => {
  const headers = await start(page, request);
  await send(request, headers, remote);
  const region = completionRegion(page);
  const title = '第二台电脑的独立会话';
  const link = region.getByRole('link', { name: `查看已完成会话：${title}`, exact: true });
  await expect(region).toContainText('第二台测试电脑');
  await expect(link).toHaveAttribute('href', `/?workspace=${remote}&session=${ids.modern}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`workspace=${remote}&session=${ids.modern}`));
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(region).toHaveCount(0);
});

test('polling recovers and closing all synchronizes across tabs', async ({ page, request }) => {
  const headers = await start(page, request);
  let disconnected = true;
  const failRead = page.waitForEvent('requestfailed', (result) =>
    result.url().endsWith(completionPath),
  );
  await page.route(`**${completionPath}`, (route) =>
    disconnected ? route.abort('failed') : route.continue(),
  );
  await send(request, headers);
  await send(request, headers);
  await failRead;
  disconnected = false;
  const region = completionRegion(page);
  await expect(region.getByRole('article')).toHaveCount(2);
  await page.reload();
  await expect(region.getByRole('article')).toHaveCount(2);
  const otherTab = await page.context().newPage();
  await otherTab.goto('/?workspace=local&view=usage');
  await expect(completionRegion(otherTab).getByRole('article')).toHaveCount(2);
  await region.getByRole('button', { name: '全部关闭', exact: true }).click();
  await expect(region).toHaveCount(0);
  await expect(completionRegion(otherTab)).toHaveCount(0);
});
