import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, ids } from '../fixture.js';
import { FixtureDesktop } from '../control-fixture.js';
import { MonitorClient } from '../../server/client/connection.js';
import { createMonitorServer } from '../../server/server-app.js';
import { once } from 'node:events';
import { createServer } from 'node:http';

const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('a server without clients keeps central account management available', async ({ page }) => {
  const f = fixture(),
    service = createMonitorServer(f.config),
    server = createServer(service.app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const user = await service.auth.setup('owner', 'monitor-e2e-password!');
  const token = service.auth.issue(user, 'empty server').token;
  try {
    await page.addInitScript(
      (token) => localStorage.setItem('codex-monitor.auth.v1', token),
      token,
    );
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await expect(page.getByRole('heading', { name: '连接你的工作空间' })).toBeVisible();
    await page.getByRole('button', { name: '设置与访问管理', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置与访问管理' });
    await expect(dialog.getByText('owner', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByText('Webhook 通知', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '关闭设置' }).click();
    await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '管理工作空间' }).getByLabel('添加工作空间'),
    ).toBeVisible();
  } finally {
    service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function enter(page: Page, request: APIRequestContext, query = '') {
  const status = await (await request.get('/api/auth/status')).json();
  const root =
    process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
  const route = `/api/auth/${status.configured ? 'login' : 'setup'}`;
  const options = {
    data: {
      username: 'owner',
      password: 'monitor-e2e-password!',
      ...(!status.configured
        ? { setupKey: readFileSync(path.join(root, 'data/setup-key.txt'), 'utf8').trim() }
        : {}),
    },
  };
  let result = await request.post(route, options);
  if (result.status() === 429) {
    // Other tests share this server; successful logins also consume its rate budget.
    const waitMs =
      Math.min(60, Math.max(1, Number(result.headers()['retry-after']) || 60)) * 1000 + 100;
    test.setTimeout(test.info().timeout + waitMs);
    await delay(waitMs);
    result = await request.post(route, options);
  }
  expect(result.ok()).toBeTruthy();
  const token = (await result.json()).token;
  await page.addInitScript((token) => localStorage.setItem('codex-monitor.auth.v1', token), token);
  await page.goto('/?' + query);
  await expect(page.getByLabel('切换工作空间')).toBeVisible();
  return token;
}

test('switches clients with identical session IDs, isolates drafts and attachments, and supports simultaneous tabs', async ({
  page,
  request,
  context,
}) => {
  await enter(page, request, `workspace=local&session=${ids.modern}`);
  const input = page.getByLabel('发送给 Codex 的消息');
  await expect(input).toBeEnabled();
  await input.fill('只属于本机的草稿');
  await page.getByLabel('上传图片或文件', { exact: true }).setInputFiles({
    name: 'local-only.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('local-file'),
  });
  await expect(page.getByRole('list', { name: '待发送附件' })).toContainText('local-only.txt');
  await page.getByLabel('切换工作空间').selectOption(second);
  await expect(page).toHaveURL(new RegExp(`workspace=${second}`));
  await page.getByTestId('session-row').filter({ hasText: '第二台电脑的独立会话' }).click();
  await expect(input).toBeEmpty();
  await expect(page.getByRole('list', { name: '待发送附件' })).toHaveCount(0);
  await input.fill('只属于第二台的草稿');
  await page.getByLabel('切换工作空间').selectOption('local');
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(input).toHaveValue('只属于本机的草稿');
  await expect(page.getByRole('list', { name: '待发送附件' })).toContainText('local-only.txt');
  await page.getByRole('button', { name: '移除附件 local-only.txt' }).click();
  await input.fill('');
  const other = await context.newPage();
  await other.goto(`/?workspace=${second}&session=${ids.modern}`);
  await expect(other.getByLabel('发送给 Codex 的消息')).toBeEmpty();
  const message = '仅发送给第二台 ' + test.info().project.name;
  await other.getByLabel('发送给 Codex 的消息').fill(message);
  await expect(other.locator('.message-composer button[type="submit"]')).toBeEnabled();
  await other.locator('.message-composer button[type="submit"]').click();
  await expect(
    other.locator('.timeline').getByText('测试回复：' + message, { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.timeline')).not.toContainText(message);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await other.close();
});

test('registers a client with a fixed AES key, shows live status, renames it and disconnects when the key rotates', async ({
  page,
  request,
  baseURL,
}) => {
  const token = await enter(page, request);
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '管理工作空间' });
  const name = `临时 client ${test.info().project.name}`;
  await dialog.getByLabel('添加工作空间').fill(name);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  const config = await dialog.getByLabel('Client 环境配置').inputValue();
  const id = /MONITOR_WORKSPACE_ID=(.*)/.exec(config)![1];
  const key = /MONITOR_CLIENT_KEY=(.*)/.exec(config)![1];
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const f = fixture();
  const client = await MonitorClient.start({
    config: f.config,
    serverUrl: baseURL!,
    workspaceId: id,
    key,
    services: { control: new FixtureDesktop(f) },
    reconnectMs: 100,
  });
  try {
    const row = dialog.locator('.client-row').filter({ hasText: name });
    await expect(row.getByText('在线', { exact: true })).toBeVisible();
    await row.getByRole('textbox').fill(name + ' 新名称');
    await row.getByRole('button', { name: '保存名称' }).click();
    await expect(row.locator('strong')).toHaveText(name + ' 新名称');
    await row.getByRole('button', { name: '轮换密钥', exact: true }).click();
    await row.getByRole('button', { name: '确认轮换' }).click();
    await expect(dialog.getByLabel('Client 环境配置')).not.toHaveValue(config);
    await expect(row.getByText('离线', { exact: true })).toBeVisible();
    const list = await (
      await request.get('/api/workspaces', { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    expect(JSON.stringify(list)).not.toContain(key);
    expect(
      await page.evaluate(
        (key) =>
          !JSON.stringify(localStorage).includes(key) &&
          !JSON.stringify(sessionStorage).includes(key),
        key,
      ),
    ).toBeTruthy();
    await dialog.getByRole('button', { name: '关闭工作空间管理' }).click();
    await page.getByLabel('切换工作空间').selectOption(id);
    await expect(page.getByRole('status')).toContainText('工作空间已离线');
    await page.screenshot({ path: test.info().outputPath('client-offline.png'), fullPage: true });
  } finally {
    await client.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await request.delete(`/api/workspaces/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
});
