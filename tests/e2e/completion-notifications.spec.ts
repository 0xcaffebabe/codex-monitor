import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ids } from '../fixture.js';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
const remote = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function start(page: Page, request: APIRequestContext) {
  const status = await (await request.get('/api/auth/status')).json();
  const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
  const response = await request.post(status.configured ? '/api/auth/login' : '/api/auth/setup', {
    data: status.configured
      ? credentials
      : {
          ...credentials,
          setupKey: readFileSync(path.join(root, 'data', 'setup-key.txt'), 'utf8').trim(),
        },
  });
  expect(response.ok()).toBeTruthy();
  const token = (await response.json()).token as string;
  const headers = { Authorization: `Bearer ${token}` };
  // Test the independent browser channel with no webhook enabled.
  expect(
    (
      await request.put('/api/notifications', {
        headers,
        data: { enabled: false, provider: 'lark', publicUrl: '' },
      })
    ).ok(),
  ).toBeTruthy();
  await page.addInitScript((token) => localStorage.setItem('codex-monitor.auth.v1', token), token);
  const baseline = page.waitForResponse(
    (r) => r.url().endsWith('/api/notifications/completions') && r.ok(),
  );
  await page.goto('/?workspace=local');
  await baseline;
  await expect(page.getByRole('region', { name: '任务完成通知' })).toHaveCount(0);
  return headers;
}
async function send(
  request: APIRequestContext,
  headers: Record<string, string>,
  workspace = 'local',
  id = ids.modern,
) {
  const response = await request.post(`/api/workspaces/${workspace}/sessions/${id}/messages`, {
    headers,
    data: { requestId: randomUUID(), prompt: `网页完成通知验收-${Date.now()}` },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test('HTTP pages show and dismiss completion cards, keep them through reload and open the completed session', async ({
  page,
  request,
}, info) => {
  const headers = await start(page, request);
  await send(request, headers);
  const region = page.getByRole('region', { name: '任务完成通知' });
  await expect(region).toBeVisible();
  await expect(region.getByText('任务已完成', { exact: true })).toHaveCount(1);
  const link = region.getByRole('link', {
    name: '查看已完成会话：开发 codex-monitor 实时监控',
    exact: true,
  });
  await expect(link).toHaveAttribute('href', `/?workspace=local&session=${ids.modern}`);
  if (info.project.name === 'mobile') {
    // A pending card must not cover the navigation or trap access to settings.
    await page.getByTitle('打开菜单').click();
    await page.getByRole('button', { name: '设置与访问管理', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByRole('button', { name: '关闭菜单', exact: true }).click();
    await expect(link).toBeVisible();
  }
  const bounds = await region.boundingBox(),
    viewport = page.viewportSize()!;
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  expect(bounds!.y).toBeGreaterThan(viewport.height / 2);
  if (info.project.name === 'desktop') expect(bounds!.x).toBeGreaterThan(viewport.width / 2);
  await page.screenshot({ path: info.outputPath('completion-notification.png') });
  await region
    .getByRole('button', { name: '关闭通知：开发 codex-monitor 实时监控', exact: true })
    .click();
  await expect(region).toHaveCount(0);
  await page.reload();
  await expect(region).toHaveCount(0);
  // A second successful turn of the same session produces a new notification.
  await send(request, headers);
  await expect(link).toBeVisible();
  await page.goto('/?workspace=local&view=usage');
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`workspace=local&session=${ids.modern}`));
  await expect(page.locator('.detail-header')).toContainText('开发 codex-monitor 实时监控');
  await expect(region).toHaveCount(0);
  const feed = await (
    await request.get('/api/notifications/completions?after=0', { headers })
  ).json();
  expect(
    feed.notifications.filter((row: { sessionId: string }) => row.sessionId === ids.modern).length,
  ).toBeGreaterThanOrEqual(2);
});

test('a completion from another workspace opens that workspace and the matching session', async ({
  page,
  request,
}) => {
  const headers = await start(page, request);
  await send(request, headers, remote);
  const region = page.getByRole('region', { name: '任务完成通知' });
  await expect(region).toContainText('第二台测试电脑');
  const link = region.getByRole('link', {
    name: '查看已完成会话：第二台电脑的独立会话',
    exact: true,
  });
  await expect(link).toHaveAttribute('href', `/?workspace=${remote}&session=${ids.modern}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`workspace=${remote}&session=${ids.modern}`));
  await expect(page.getByRole('combobox', { name: '切换工作空间' })).toHaveValue(remote);
  await expect(page.locator('.detail-header')).toContainText('第二台电脑的独立会话');
  await expect(region).toHaveCount(0);
});

test('polling recovers missed completions after a failed request without duplicate cards and preserves unread cards on refresh', async ({
  page,
  request,
}) => {
  const headers = await start(page, request);
  let disconnected = true,
    failures = 0;
  await page.route('**/api/notifications/completions?after=*', async (route) => {
    if (disconnected) {
      failures++;
      await route.abort('failed');
    } else await route.continue();
  });
  await send(request, headers);
  await send(request, headers);
  await expect.poll(() => failures).toBeGreaterThan(0);
  disconnected = false;
  const region = page.getByRole('region', { name: '任务完成通知' });
  await expect(region.locator('article')).toHaveCount(2);
  await page.reload();
  await expect(region.locator('article')).toHaveCount(2);
  // Observe another completed poll so duplicate delivery cannot hide behind the refresh assertion.
  await page.waitForResponse(
    (r) => r.url().includes('/api/notifications/completions?after=') && r.ok(),
  );
  await expect(region.locator('article')).toHaveCount(2);
  await region.getByRole('button', { name: '全部关闭', exact: true }).click();
  await expect(region).toHaveCount(0);
  await page.reload();
  await expect(region).toHaveCount(0);
});
