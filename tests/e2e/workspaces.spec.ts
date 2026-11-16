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
import { HOST_RESOURCE_STALE_MS } from '../../src/workspaces.js';
import type { Session } from '../../src/types.js';

const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('a server without clients keeps central account management available', async ({ page }) => {
  const f = fixture(),
    service = createMonitorServer(f.config, { publicDir: process.env.MONITOR_TEST_PUBLIC_DIR }),
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
    await expect(dialog.getByRole('heading', { name: /Webhook 通知/ })).toBeVisible();
    await expect(dialog.getByLabel('启用 Webhook 通知')).toBeEnabled();
    await dialog.getByRole('button', { name: '关闭设置' }).click();
    await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '管理工作空间' }).getByLabel('添加工作空间'),
    ).toBeVisible();
  } finally {
    await service.close();
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
  const headers = { Authorization: `Bearer ${token}` };
  // Projects share a server; earlier sends can leave cards covering the mobile session list.
  const pending = await (await request.get('/api/notifications/completions', { headers })).json();
  if (pending.notifications.length)
    expect(
      (
        await request.post('/api/notifications/completions/dismiss', {
          headers,
          data: {
            generation: pending.generation,
            ids: pending.notifications.map((item: { id: number }) => item.id),
          },
        })
      ).ok(),
    ).toBeTruthy();
  await page.addInitScript((token) => localStorage.setItem('codex-monitor.auth.v1', token), token);
  await page.goto('/?' + query);
  await expect(page.getByLabel('切换工作空间')).toBeVisible();
  return token;
}

test('session records search all workspaces and retain the query when opening identical session IDs', async ({
  page,
  request,
  isMobile,
}) => {
  await enter(page, request, 'workspace=local');
  const rows = page.getByTestId('session-row');
  await expect(rows.filter({ hasText: '第二台电脑的独立会话' })).toHaveCount(1);
  const search = page.getByLabel('搜索会话', { exact: true });
  await search.fill('旧版本');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: '本机工作空间' })).toHaveCount(1);
  await expect(rows.filter({ hasText: '第二台测试电脑' })).toHaveCount(1);
  await rows.filter({ hasText: '第二台测试电脑' }).click();
  await expect(page.getByLabel('切换工作空间')).toHaveValue(second);
  await expect(page.locator('.detail-heading')).toContainText('检查旧版本会话解析');
  expect(new URL(page.url()).searchParams.get('q')).toBe('旧版本');
  if (!isMobile) {
    await expect(page.getByRole('region', { name: '会话记录', exact: true })).toBeVisible();
    await expect(rows.filter({ hasText: '第二台测试电脑' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(rows.filter({ hasText: '本机工作空间' })).not.toHaveAttribute('aria-current');
    await page.screenshot({ path: test.info().outputPath('global-session-records-compact.png') });
  }
  await page.getByTitle('返回会话列表').click();
  await expect(search).toHaveValue('旧版本');
  await expect(rows).toHaveCount(2);
  await page.getByTitle('清除搜索').click();
  await search.fill('第二台电脑的独立会话');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('第二台测试电脑');
  await expect(rows.first()).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('global-session-records-search.png'),
    fullPage: true,
  });
});

test('session records merge workspace pages, preserve loaded results and recover unavailable workspaces', async ({
  page,
  request,
}) => {
  const now = Date.now();
  let mode: 'online' | 'error' | 'offline' = 'online';
  let remoteActivity = false;
  let template: Session | undefined;
  await page.route('**/api/workspaces', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (mode === 'offline')
      body.workspaces.find((item: { id: string }) => item.id === second).online = false;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/workspaces/*/sessions?*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('q')) return route.continue();
    const remote = url.pathname.includes(second);
    if (remote && mode === 'error')
      return route.fulfill({ status: 503, json: { error: '测试连接失败' } });
    const response = await route.fetch();
    const body = await response.json();
    template ||= body.sessions[0];
    const sessions = Array.from({ length: 125 }, (_, index) => ({
      ...template!,
      id: `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`,
      title:
        remote && remoteActivity && index === 0
          ? '远端最新活动'
          : `跨空间分页 ${remote ? '远端' : '本机'} ${index}`,
      status: 'completed',
      updatedAt:
        remote && remoteActivity && index === 0
          ? now + 1000
          : now - (remote ? 3600000 : 0) - index * 1000,
    }));
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    await route.fulfill({
      response,
      json: { ...body, sessions: sessions.slice(offset, offset + limit), total: sessions.length },
    });
  });
  await page.clock.install();
  await enter(page, request, 'workspace=local');
  const rows = page.getByTestId('session-row');
  const panel = page.getByRole('region', { name: '会话记录', exact: true });
  await expect(rows).toHaveCount(60);
  await expect(rows.first()).toContainText('本机 0');
  await expect(panel.locator('.count')).toHaveText('250');
  await panel.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await expect(rows).toHaveCount(120);
  await expect(rows.last()).toContainText('本机 119');
  await panel.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await expect(rows).toHaveCount(180);
  await expect(rows.filter({ hasText: '本机工作空间' })).toHaveCount(125);
  await expect(rows.filter({ hasText: '第二台测试电脑' })).toHaveCount(55);
  remoteActivity = true;
  await page.clock.fastForward(3000);
  await expect(rows.first()).toContainText('远端最新活动');
  await expect(rows).toHaveCount(180);
  await page.getByTitle('刷新数据', { exact: true }).click();
  await expect(rows).toHaveCount(180);
  mode = 'error';
  await page.clock.fastForward(3000);
  await expect(panel.getByRole('status')).toContainText('第二台测试电脑（加载失败）');
  await expect(rows).toHaveCount(125);
  mode = 'offline';
  await page.clock.fastForward(3000);
  await expect(panel.getByRole('status')).toContainText('第二台测试电脑（离线）');
  await expect(rows).toHaveCount(60);
  mode = 'online';
  await page.clock.fastForward(3000);
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect(rows.first()).toContainText('远端最新活动');
});

test('mobile running shortcuts group workspaces and open identical session IDs in the right client', async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== 'mobile', 'The fixed running switcher is mobile only');
  await enter(page, request, `workspace=local&session=${ids.modern}`);
  const shortcuts = page.getByRole('navigation', { name: '正在进行的会话快捷切换' });
  const local = shortcuts.getByRole('region', { name: '本机工作空间的进行中会话' });
  const remote = shortcuts.getByRole('region', { name: '第二台测试电脑的进行中会话' });
  await expect(shortcuts.locator('.running-launcher')).toHaveText('2');
  await page.getByTitle('展开正在进行的会话').click();
  await expect(local.getByRole('heading')).toContainText('当前空间');
  await expect(local.getByRole('button')).toHaveAttribute('aria-current', 'page');
  await expect(remote.getByRole('button')).not.toHaveAttribute('aria-current');
  await expect(remote.getByRole('button')).toContainText('第二台电脑的独立会话');
  await remote.getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`workspace=${second}&session=${ids.modern}`));
  await expect(page.locator('.detail-heading')).toContainText('第二台电脑的独立会话');
  await expect(shortcuts).toHaveClass(/collapsed/);
  await page.getByTitle('展开正在进行的会话').click();
  await expect(remote.getByRole('heading')).toContainText('当前空间');
  await expect(remote.getByRole('button')).toHaveAttribute('aria-current', 'page');
  await expect(local.getByRole('button')).not.toHaveAttribute('aria-current');
  await local.getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`workspace=local&session=${ids.modern}`));
  await expect(page.locator('.detail-heading')).toContainText('开发 codex-monitor');
});

test('mobile running shortcuts update activity times and recover individual workspace lists', async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== 'mobile', 'The fixed running switcher is mobile only');
  const now = Date.now();
  let mode: 'running' | 'empty' | 'error' | 'offline' = 'running';
  await page.route('**/api/workspaces', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (mode === 'offline')
      body.workspaces.find((workspace: { id: string }) => workspace.id === second).online = false;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/workspaces/*/sessions?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('status') !== 'running') return route.continue();
    const remote = url.pathname.includes(second);
    if (remote && mode === 'error')
      return route.fulfill({ status: 503, json: { error: '测试连接失败' } });
    const response = await route.fetch();
    const body = await response.json();
    if (remote && mode === 'empty') {
      body.sessions = [];
      body.total = 0;
    }
    for (const session of body.sessions) session.updatedAt = now - (remote ? 125000 : 5000);
    await route.fulfill({ response, json: body });
  });
  await page.clock.install({ time: now });
  await enter(page, request, 'workspace=local');
  const shortcuts = page.getByRole('navigation', { name: '正在进行的会话快捷切换' });
  await expect(shortcuts.locator('.running-launcher')).toHaveText('2');
  await page.getByTitle('展开正在进行的会话').click();
  const local = shortcuts.getByRole('region', { name: '本机工作空间的进行中会话' });
  const remote = shortcuts.getByRole('region', { name: '第二台测试电脑的进行中会话' });
  const localTime = local.locator('time');
  await expect(localTime).toHaveText(/^\d+ 秒前$/);
  await expect(remote.locator('time')).toHaveText('2 分钟前');
  await expect(localTime).toHaveAttribute('datetime', new Date(now - 5000).toISOString());
  await expect(localTime).toHaveAttribute('title', /^最后活跃：/);
  const initialTime = await localTime.textContent();
  await page.clock.fastForward(1000);
  await expect(localTime).not.toHaveText(initialTime!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('all-workspaces-running.png'),
    fullPage: true,
  });
  await page.clock.fastForward(60000);
  await expect(localTime).toHaveText('1 分钟前');
  mode = 'empty';
  await page.clock.fastForward(3000);
  await expect(remote).toContainText('暂无进行中的会话');
  await expect(remote.getByRole('button')).toHaveCount(0);
  await expect(local.getByRole('button')).toHaveCount(1);
  mode = 'error';
  await page.clock.fastForward(3000);
  await expect(remote).toContainText('暂时无法加载，正在重试');
  await expect(local.getByRole('button')).toHaveCount(1);
  mode = 'offline';
  await page.clock.fastForward(3000);
  await expect(remote).toContainText('空间已离线');
  mode = 'running';
  await page.clock.fastForward(3000);
  await expect(remote.getByRole('button')).toHaveCount(1);
  await expect(shortcuts.locator('.running-switcher-header')).toContainText('2');
});

test('shows real host CPU and memory for connected clients in the header and management list', async ({
  page,
  request,
}) => {
  await enter(page, request, `workspace=local&session=${ids.modern}`);
  const summary = page
    .locator('.workspace-selector')
    .getByRole('group', { name: '本机工作空间整机资源' });
  await expect(summary).toContainText(/CPU\s*\d+\.\d%/, { timeout: 15000 });
  await expect(summary).toContainText(/内存\s*\d+\.\d%/);
  const header = page.locator('.topbar');
  const headerBox = await header.boundingBox();
  const summaryBox = await summary.boundingBox();
  expect(summaryBox!.y + summaryBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height);
  await page.screenshot({
    path: test.info().outputPath('host-resources-header.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '管理工作空间' });
  for (const name of ['本机工作空间', '第二台测试电脑']) {
    const resources = dialog.getByRole('group', { name: `${name}整机资源` });
    await expect(resources).toContainText(/CPU\s*\d+\.\d%/);
    await expect(resources).toContainText(/内存\s*\d+\.\d%/);
    await expect(resources).toContainText(/\d+\.\d \/ \d+\.\d GiB/);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('host-resources.png'), fullPage: true });
});

test('hides stale and offline values, expires a sample without another response, and handles older clients', async ({
  page,
  request,
}) => {
  let mode: 'fresh' | 'expiring' | 'offline' | 'waiting' = 'fresh';
  await page.route('**/api/workspaces', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const workspace of body.workspaces) {
      if (workspace.id !== 'local') continue;
      workspace.online = mode !== 'offline';
      workspace.resources =
        mode === 'waiting' || mode === 'offline'
          ? null
          : {
              // The sample age, rather than a remote clock, determines freshness.
              sampledAt: Date.now() + 3600000,
              cpuPercent: 23.5,
              memory: { totalBytes: 8 * 2 ** 30, usedBytes: 6 * 2 ** 30, usedPercent: 75 },
              ageMs: mode === 'expiring' ? HOST_RESOURCE_STALE_MS - 300 : 0,
            };
    }
    await route.fulfill({ response, json: body });
  });
  await enter(page, request, 'workspace=local');
  const summary = page
    .locator('.workspace-selector')
    .getByRole('group', { name: '本机工作空间整机资源' });
  await expect(summary).toContainText('CPU 23.5%');
  await expect(summary).toContainText('内存 75.0%');
  mode = 'expiring';
  await expect(summary).toContainText('数据过期');
  await expect(summary).not.toContainText('23.5%');
  mode = 'fresh';
  await expect(summary).toContainText('CPU 23.5%');
  mode = 'offline';
  await expect(summary).toContainText('离线');
  await expect(summary).not.toContainText('23.5%');
  mode = 'waiting';
  await expect(summary).toContainText('等待上报');
  await expect(summary).not.toContainText('75.0%');
});

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
  context,
}) => {
  const token = await enter(page, request);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '管理工作空间' });
  const name = `临时 client ${test.info().project.name}`;
  await dialog.getByLabel('添加工作空间').fill(name);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  const commandField = dialog.getByLabel('Client 启动命令');
  await expect(commandField).not.toBeEmpty();
  const command = await commandField.inputValue();
  const match =
    /^npm run client -- --server-url "([^"]+)" --workspace-id "([^"]+)" --client-key "([^"]+)"$/.exec(
      command,
    );
  expect(match).not.toBeNull();
  const [, serverUrl, id, key] = match!;
  expect(serverUrl).toBe(baseURL!.replace(/^http/, 'ws'));
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole('button', { name: '复制 client 启动命令' }).click();
  await expect(dialog.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  const f = fixture();
  const client = await MonitorClient.start({
    config: f.config,
    serverUrl,
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
    await expect(row.locator('.client-heading strong')).toHaveText(name + ' 新名称');
    await row.getByRole('button', { name: '轮换密钥', exact: true }).click();
    await row.getByRole('button', { name: '确认轮换' }).click();
    await expect(commandField).not.toHaveValue(command);
    const rotatedCommand = await commandField.inputValue();
    expect(rotatedCommand).toContain(`--workspace-id "${id}"`);
    expect(rotatedCommand).not.toContain(key);
    await dialog.getByRole('button', { name: '复制 client 启动命令' }).click();
    await expect(dialog.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(rotatedCommand);
    await expect(row.locator('.client-heading').getByText('离线', { exact: true })).toBeVisible();
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
