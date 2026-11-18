import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
const remote = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let cachedToken = '';

async function enter(page: Page, request: APIRequestContext) {
  if (
    cachedToken &&
    (
      await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${cachedToken}` } })
    ).ok()
  ) {
    await page.addInitScript(
      (value) => localStorage.setItem('codex-monitor.auth.v1', value),
      cachedToken,
    );
    return { Authorization: `Bearer ${cachedToken}` };
  }
  const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
  const status = await (await request.get('/api/auth/status')).json();
  const response = await request.post(status.configured ? '/api/auth/login' : '/api/auth/setup', {
    data: status.configured
      ? credentials
      : {
          ...credentials,
          setupKey: readFileSync(path.join(root, 'data/setup-key.txt'), 'utf8').trim(),
        },
  });
  expect(response.ok()).toBeTruthy();
  const { token } = await response.json();
  cachedToken = token;
  await page.addInitScript((value) => localStorage.setItem('codex-monitor.auth.v1', value), token);
  return { Authorization: `Bearer ${token}` };
}

test('default attention workspace preserves last observation across offline reload and leaves history separate', async ({
  page,
  request,
  isMobile,
}) => {
  await enter(page, request);
  for (const width of isMobile ? [440] : [1280, 2560]) {
    await page.setViewportSize({ width, height: isMobile ? 956 : 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '任务动态', exact: true })).toBeVisible();
    await expect(page.getByText('2/2 个工作空间已同步')).toBeVisible();
    await expect(page.getByRole('region', { name: '运行中' })).toContainText('第二台测试电脑');
    const columns = await page
      .locator('.attention-grid')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(width > 1360 ? 2 : 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await page.screenshot({ path: test.info().outputPath(`attention-${width}.png`) });
  }
  await page.route('**/api/workspaces', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        workspaces: payload.workspaces.map((workspace: { id: string }) =>
          workspace.id === remote ? { ...workspace, online: false } : workspace,
        ),
      },
    });
  });
  await page.reload();
  await expect(page.getByText('第二台测试电脑（离线）', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '待处理' })).toContainText('最后同步');
  await expect(page.getByRole('region', { name: '运行中' })).not.toContainText('第二台测试电脑');
  if (isMobile) await page.getByTitle('打开菜单').click();
  await page.getByRole('button', { name: '全部会话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索会话', exact: true })).toBeVisible();
});

test('review remote approval from home and recover the original receipt after a lost response and reload', async ({
  page,
  request,
}) => {
  test.skip(process.env.MONITOR_TEST_APPROVALS !== '1', 'Needs the approval fixture');
  const headers = await enter(page, request);
  const base = `/api/workspaces/${remote}`;
  const control = await (await request.get(base + '/control', { headers })).json();
  const prompt = `APPROVAL_TEST:permissions:${randomUUID().slice(0, 8)}`;
  const creation = await request.post(base + '/sessions', {
    headers,
    data: {
      requestId: randomUUID(),
      projectId: control.projects[0].id,
      permissionMode: 'workspace-write',
      prompt,
    },
  });
  expect(creation.ok()).toBeTruthy();
  const { threadId } = await creation.json();
  await page.goto('/?workspace=local');
  const button = page
    .getByRole('region', { name: '待处理' })
    .getByRole('button', { name: `核对审批：${prompt}`, exact: true });
  await button.click();
  const dialog = page.getByRole('dialog', { name: '核对权限请求' });
  await expect(dialog).toContainText('第二台测试电脑');
  expect(new URL(page.url()).searchParams.get('workspace')).toBe('local');
  let submissions = 0;
  const receiptRoute = `**/api/workspaces/${remote}/sessions/${threadId}/approvals/*`;
  await page.route(receiptRoute, async (route) => {
    if (route.request().method() === 'POST') {
      submissions++;
      const result = await route.fetch();
      expect(result.ok()).toBeTruthy();
    }
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(dialog).toContainText('结果待确认，请查询原回执');
  await page.reload();
  const pending = page.getByRole('region', { name: '待处理' });
  await expect(pending).toContainText('结果待确认，请查询原回执');
  await page.unroute(receiptRoute);
  await pending.getByRole('button', { name: '查询原回执' }).click();
  await expect(page.getByRole('region', { name: '最近回执' })).toContainText(
    '答复已确认：允许本次',
  );
  expect(submissions).toBe(1);
  const result = page
    .getByRole('region', { name: '最近结束' })
    .getByRole('button', { name: `查看结果：${prompt}`, exact: true });
  await result.click();
  expect(new URL(page.url()).searchParams.get('session')).toBe(threadId);
  await expect(page.getByRole('region', { name: '本轮结果' })).toContainText('APPROVAL_ALLOWED');
  await page
    .getByRole('region', { name: '本轮结果' })
    .getByRole('button', { name: '定位本轮记录' })
    .click();
  const watch = page.getByRole('button', { name: '关注通知（团队）' });
  await watch.click();
  await expect(watch).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(watch).toHaveAttribute('aria-pressed', 'true');
  await watch.click();
});
