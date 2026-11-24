import path from 'node:path';
import { ids } from '../fixture.js';
import { expect, localTitle, test } from './monitor.js';

test('the desktop dock stays fixed on usage and opens a running session across workspaces', async ({
  signedIn: { browserPage: page, session, usage, workspace },
  monitor,
}) => {
  const remoteName = '运行中的远程工作空间';
  const remoteTitle = '正在处理远程会话';
  const remote = await monitor.addWorkspace(remoteName, remoteTitle);
  const viewport = { width: 1440, height: 720 };
  await page.setViewportSize(viewport);
  await usage.open();

  const dock = page.getByRole('navigation', { name: '会话快捷入口' });
  const trigger = dock.getByRole('button', { name: '查看运行中的会话' });
  const dialog = page.getByRole('dialog', { name: '运行中的会话' });
  await expect(trigger).toHaveText('2');
  const bounds = (await trigger.boundingBox())!;
  const dashboard = page.locator('.usage-dashboard');
  const dashboardBounds = (await dashboard.boundingBox())!;
  expect(dashboardBounds.x + dashboardBounds.width).toBe(viewport.width);
  expect(viewport.width - bounds.x - bounds.width).toBeLessThan(16);
  await dashboard.evaluate((element) => (element.scrollTop = element.scrollHeight));
  await expect.poll(() => dashboard.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await trigger.boundingBox()).toEqual(bounds);

  await trigger.click();
  await expect(dialog.getByRole('button', { name: new RegExp(localTitle) })).toBeVisible();
  const dialogBounds = (await dialog.boundingBox())!;
  expect(dialogBounds.x + dialogBounds.width).toBeLessThan(bounds.x);
  const close = dialog.getByRole('button', { name: '关闭运行中列表' });
  const closeBounds = (await close.boundingBox())!;
  expect(closeBounds.y - dialogBounds.y).toBeLessThanOrEqual(10);
  expect(
    dialogBounds.x + dialogBounds.width - closeBounds.x - closeBounds.width,
  ).toBeLessThanOrEqual(16);
  const remoteSession = dialog.getByRole('button', { name: new RegExp(remoteTitle) });
  await expect(remoteSession).toContainText(remoteName);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await remoteSession.click();
  await expect(dialog).toBeHidden();
  await expect(workspace.workspaceSelector).toHaveValue(remote.id);
  await expect(session.heading(remoteTitle)).toBeVisible();
  await trigger.click();
  await expect(remoteSession).toHaveAttribute('aria-current', 'page');
});

test('a slow workspace leaves other session lists visible and refreshing', async ({
  app: { browserPage: page, account, workspace },
  monitor,
  local,
}) => {
  const remoteName = '响应缓慢的工作空间';
  const remoteTitle = '远程工作空间会话';
  const remote = await monitor.addWorkspace(remoteName, remoteTitle);
  let requested = false;
  let respond!: () => void;
  const waiting = new Promise<void>((resolve) => {
    respond = resolve;
  });
  await page.route(
    (url) => url.pathname === `/api/workspaces/${remote.id}/sessions`,
    async (route) => {
      requested = true;
      await waiting;
      await route.fulfill({ status: 503, json: { error: '工作空间已离线' } });
    },
    { times: 1 },
  );

  try {
    await account.setUpOwner(monitor.setupKey, monitor.credentials, `/?workspace=${local.id}&view=all`);
    await expect.poll(() => requested).toBe(true);
    await expect(workspace.sessionRow(localTitle)).toBeVisible({ timeout: 4000 });
    await expect(workspace.sessionRow(remoteTitle)).toHaveCount(0);

    const updatedTitle = '本机工作空间更新后的会话';
    local.data.state.prepare('UPDATE threads SET title=? WHERE id=?').run(updatedTitle, ids.modern);
    await expect(workspace.sessionRow(updatedTitle)).toBeVisible({ timeout: 5000 });

    respond();
    const warning = page.getByText(`${remoteName}（加载失败）`, { exact: true });
    await expect(warning).toBeVisible();
    await expect(workspace.sessionRow(updatedTitle)).toBeVisible();
    await expect(workspace.sessionRow(remoteTitle)).toBeVisible();
    await expect(warning).toHaveCount(0);
  } finally {
    respond();
  }
});

test('sidebar projects browse all workspaces and open the selected workspace for an identical path', async ({
  signedIn: { browserPage: page, workspace },
  monitor,
  local,
}) => {
  const projectPath = path.join(local.data.root, 'project');
  const remoteTitle = '远程项目会话';
  const remoteName = '远程工作空间';
  const remote = await monitor.addWorkspace(remoteName, remoteTitle, undefined, projectPath);
  const remoteGroup = workspace.projectGroup(remoteName);
  const remoteProject = remoteGroup.getByRole('button', { name: '项目：project' });
  const localProject = workspace.projectGroup('本机工作空间').getByRole('button', { name: '项目：project' });

  await expect(workspace.projectScope).toHaveValue('');
  await expect(localProject).toBeVisible();
  await expect(remoteProject).toBeVisible();
  await workspace.projectScope.selectOption(remote.id);
  await expect(localProject).toHaveCount(0);
  await expect(workspace.workspaceSelector).toHaveValue(local.id);
  await workspace.projectScope.selectOption('');

  const toggleNavigation = page.getByRole('button', { name: '切换导航' });
  const preview = page.getByRole('tooltip');
  await toggleNavigation.click();
  await remoteProject.hover();
  await expect(preview).toContainText(remoteName);
  await expect(preview).toContainText(/\d+ 个会话/);
  await preview.getByText(projectPath, { exact: true }).hover();
  await expect(preview).toBeVisible();

  await localProject.hover();
  await expect(preview).toContainText('本机工作空间');
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();

  await remoteProject.click();
  await expect(workspace.workspaceSelector).toHaveValue(remote.id);
  await expect(workspace.sessionScope).toHaveValue(remote.id);
  await expect(remoteProject).toHaveAttribute('aria-current', 'page');
  await expect(localProject).not.toHaveAttribute('aria-current', 'page');
  await expect(workspace.sessionRow(remoteTitle)).toBeVisible();
  await expect(workspace.sessionRow(localTitle)).toHaveCount(0);
  await expect(preview).toBeHidden();
  await toggleNavigation.click();

  await workspace.showArchivedSessions();
  await expect(page.getByRole('heading', { name: 'project', exact: true })).toBeVisible();
  await expect(workspace.sessionRow('已归档的历史会话')).toHaveCount(1);
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
    workspace: remote.id,
    scope: remote.id,
    project: projectPath,
    status: 'archived',
  });
  await page.goBack();
  await expect(workspace.workspaceSelector).toHaveValue(local.id);
  await expect(workspace.sessionListHeading).toBeVisible();

  await remote.stop();
  await expect(remoteGroup.getByText('离线', { exact: true })).toBeVisible();
  await expect(localProject).toBeVisible();
  await remote.start();
  await expect(remoteGroup.getByText('离线', { exact: true })).toBeHidden();
  await expect(remoteProject).toBeVisible();
});

test('two clients with the same session ID isolate draft, history and message delivery', async ({
  signedIn: { session, workspace },
  monitor,
  local,
}) => {
  const remoteTitle = '第二个工作空间的会话';
  const other = await monitor.addWorkspace('第二个工作空间', remoteTitle);
  await session.open(local.id, ids.modern);
  const draft = '本机工作空间的草稿';
  await session.writeDraft(draft);

  await workspace.switchTo(other.id);
  await workspace.openSession(remoteTitle);
  await expect(session.heading(remoteTitle)).toBeVisible();
  expect(session.currentId()).toBe(ids.modern);
  await expect(session.draft).toBeEmpty();
  const message = '只发给第二个工作空间';
  await session.sendMessage(message);
  await expect(session.message(`测试回复：${message}`)).toBeVisible();

  await workspace.switchTo(local.id);
  await workspace.openSession(localTitle);
  await expect(session.heading(localTitle)).toBeVisible();
  await expect(session.draft).toHaveValue(draft);
  await expect(session.timeline).not.toContainText(message);
  expect(local.control.sends).toBe(0);
  expect(other.control.sends).toBe(1);
});

test('an admin can copy the full connection command for an existing remote workspace', async ({
  signedIn: { browserPage: page },
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const manage = page.getByRole('button', { name: '管理工作空间' });
  const dialog = page.getByRole('dialog', { name: '管理工作空间' });
  const commandField = dialog.getByRole('textbox', { name: 'Client 启动命令' });
  await manage.click();
  await dialog.getByLabel('添加工作空间').fill('远程电脑');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(commandField).toHaveValue(/^npm run client -- /);
  const expectedCommand = await commandField.inputValue();
  await dialog.getByRole('button', { name: '关闭工作空间管理' }).click();
  await manage.click();
  await expect(commandField).toHaveCount(0);

  const remoteRow = dialog.getByRole('article').filter({ hasText: '远程电脑' });
  const copy = remoteRow.getByRole('button', { name: '复制连接命令' });
  const localRow = dialog.getByRole('article').filter({ hasText: '本机工作空间' });
  await expect(localRow.getByRole('button', { name: '复制连接命令' })).toHaveCount(0);

  await page.route(
    '**/api/workspaces/*/connection-key',
    (route) => route.fulfill({ status: 503, json: { error: '暂时无法读取连接命令' } }),
    { times: 1 },
  );
  await copy.click();
  await expect(remoteRow.getByRole('alert')).toHaveText('暂时无法读取连接命令');

  await copy.click();
  await expect(remoteRow.getByRole('button', { name: '已复制' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedCommand);
});

test('privacy work runs on enable and survives a Windows client reconnect', async ({
  signedIn: { browserPage: page },
  monitor,
}) => {
  test.skip(process.platform !== 'win32', 'Privacy work requires a Windows client');
  const remote = await monitor.addWorkspace('隐私工作测试电脑', '远程会话');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  const dialog = page.getByRole('dialog', { name: '管理工作空间' });
  const remoteRow = dialog.getByRole('article').filter({ hasText: '隐私工作测试电脑' });
  const localRow = dialog.getByRole('article').filter({ hasText: '本机工作空间' });
  const privacySwitch = remoteRow.getByRole('switch', { name: '隐私工作' });
  const localSwitch = localRow.getByRole('switch', { name: '隐私工作' });

  await expect(privacySwitch).toHaveAttribute('aria-checked', 'false');
  await privacySwitch.click();
  await expect(privacySwitch).toHaveAttribute('aria-checked', 'true');
  await expect(localSwitch).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => remote.displayOffCalls).toBe(1);

  await remote.stop();
  await expect(remoteRow.locator('.client-status')).toHaveText('离线');
  await remote.start();
  await expect(remoteRow.locator('.client-status')).toHaveText('在线');
  await expect(privacySwitch).toHaveAttribute('aria-checked', 'true');
  expect(remote.displayOffCalls).toBe(1);

  await privacySwitch.click();
  await expect(privacySwitch).toHaveAttribute('aria-checked', 'false');
});

test('workspace management shows system uptime next to the Windows client version', async ({
  signedIn: { browserPage: page },
  monitor,
}) => {
  test.skip(process.platform !== 'win32', 'System uptime requires a Windows client');
  const name = '开机时长测试电脑';
  const remote = await monitor.addWorkspace(name, '远程会话');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  const dialog = page.getByRole('dialog', { name: '管理工作空间' });
  const row = dialog.getByRole('article').filter({ has: page.getByText(name, { exact: true }) });
  const details = row.locator('.client-details');
  const uptime = details.getByText(/^开机时长 /);
  await expect(uptime).toHaveText(/^开机时长 (不足 1|(?:\d+ 天 )?(?:\d+ 小时 )?\d+) 分钟$/);
  const versionBox = await details.getByText(/^客户端版本 /).boundingBox();
  const uptimeBox = await uptime.boundingBox();
  expect(uptimeBox!.x).toBeGreaterThan(versionBox!.x + versionBox!.width);
  expect(uptimeBox!.y).toBe(versionBox!.y);

  await remote.stop();
  await expect(uptime).toHaveCount(0);
});
