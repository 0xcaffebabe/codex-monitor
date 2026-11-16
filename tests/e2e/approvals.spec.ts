import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test.skip(
  process.env.MONITOR_TEST_APPROVALS !== '1',
  'Run with a dedicated approval fixture server',
);
const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');

async function create(
  page: Page,
  request: APIRequestContext,
  kind: string,
  permissionMode = 'workspace-write-network',
) {
  await page.route('**/api/notifications/completions', (route) =>
    route.fulfill({ json: { generation: 'approvals-test', revision: 0, notifications: [] } }),
  );
  const status = await (await request.get('/api/auth/status')).json();
  const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
  const login = await request.post(status.configured ? '/api/auth/login' : '/api/auth/setup', {
    data: status.configured
      ? credentials
      : {
          ...credentials,
          setupKey: readFileSync(path.join(root, 'data/setup-key.txt'), 'utf8').trim(),
        },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  await page.addInitScript((value) => localStorage.setItem('codex-monitor.auth.v1', value), token);
  await page.goto('/');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const dialog = page.getByRole('region', { name: '新建会话', exact: true });
  await expect(dialog.getByLabel('新会话权限')).toHaveValue('danger-full-access');
  if (permissionMode !== 'danger-full-access')
    await dialog.getByLabel('新会话权限').selectOption(permissionMode);
  if (kind === 'ordinary')
    await page.screenshot({
      path: test.info().outputPath('full-access-default.png'),
      fullPage: true,
    });
  await dialog
    .getByLabel('发送给 Codex 的消息')
    .fill(kind === 'ordinary' ? 'FULL_ACCESS_DEFAULT_TEST' : 'APPROVAL_TEST:' + kind);
  const creation = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/api/workspaces/local/sessions'),
  );
  await dialog.getByRole('button', { name: '创建并发送', exact: true }).click();
  expect((await creation).postDataJSON().permissionMode).toBe(permissionMode);
  await expect(dialog).toHaveCount(0);
  const panel = page.getByRole('region', { name: '权限审批' });
  if (kind !== 'ordinary') {
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: '允许本次', exact: true })).toBeEnabled();
  }
  const id = new URL(page.url()).searchParams.get('session')!;
  expect(id).toBeTruthy();
  const file = path.join(root, 'approval-output', id + '.txt');
  expect(existsSync(file)).toBe(false);
  return { panel, file };
}

test('requested write and network permissions appear before execution and approving continues once', async ({
  page,
  request,
}) => {
  const { panel, file } = await create(page, request, 'permissions');
  await expect(panel).toContainText('允许访问网络');
  await expect(panel).toContainText(file);
  await expect(panel).toContainText('仅本轮有效');
  await page.screenshot({
    path: test.info().outputPath('permissions-pending.png'),
    fullPage: true,
  });
  await panel.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(page.locator('.timeline')).toContainText('APPROVAL_ALLOWED');
  expect(readFileSync(file, 'utf8')).toBe('approved\n');
  await expect(panel.getByRole('button', { name: '允许本次', exact: true })).toHaveCount(0);
});

test('new sessions select full access by default and submit that choice explicitly', async ({
  page,
  request,
}) => {
  await create(page, request, 'ordinary', 'danger-full-access');
  await expect(page.locator('.timeline')).toContainText('FULL_ACCESS_DEFAULT_TEST');
  await expect(page.getByRole('region', { name: '权限审批' })).toHaveCount(0);
});

test('denying a command sends a real denial and leaves its target untouched', async ({
  page,
  request,
}) => {
  const { panel, file } = await create(page, request, 'command');
  await expect(panel).toContainText('printf');
  await expect(panel).toContainText('http://127.0.0.1');
  await panel.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator('.timeline')).toContainText('APPROVAL_DECLINED');
  expect(existsSync(file)).toBe(false);
});

test('a lost approval response is queried without sending approval a second time', async ({
  page,
  request,
}) => {
  const { panel, file } = await create(page, request, 'file');
  await expect(panel).toContainText('+approved');
  let decisions = 0;
  await page.route('**/approvals/*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    decisions++;
    await route.fetch();
    await route.abort('failed');
  });
  await panel.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(panel).toContainText('已允许，Codex 将继续执行。');
  await expect(page.locator('.timeline')).toContainText('APPROVAL_ALLOWED');
  expect(decisions).toBe(1);
  expect(readFileSync(file, 'utf8')).toBe('approved\n');
});

test('pending approval survives a page reload and stopping invalidates it', async ({
  page,
  request,
}) => {
  const { file } = await create(page, request, 'permissions');
  await page.reload();
  const panel = page.getByRole('region', { name: '权限审批' });
  await expect(panel.getByRole('button', { name: '允许本次', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '停止当前执行', exact: true }).click();
  await expect(panel.getByRole('button', { name: '允许本次', exact: true })).toHaveCount(0);
  await expect(page.locator('.timeline')).toContainText('APPROVAL_DECLINED');
  expect(existsSync(file)).toBe(false);
});
