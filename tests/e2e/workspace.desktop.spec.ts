import { appendFile, writeFile } from 'node:fs/promises';
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

test('the overview URL survives reload and follows browser navigation', async ({
  signedIn: { browserPage: page, usage },
  context,
}) => {
  await usage.open();
  await expect(page.locator('.usage-dashboard')).toBeVisible();
  const dashboardUrl = page.url();
  const trigger = page.getByRole('button', { name: '查看运行中的会话' });
  const overview = page.getByRole('dialog', { name: '任务全览' });
  const pane = overview.getByRole('region', { name: `本机工作空间 · ${localTitle}` });
  await trigger.click();
  await page.getByRole('button', { name: '全览', exact: true }).click();
  await expect(page).toHaveURL(/\/overview\?/);
  await expect(pane).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/overview\?/);
  await expect(pane).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(dashboardUrl);
  await expect(overview).toBeHidden();
  await expect(page.locator('.usage-dashboard')).toBeVisible();
  await page.goForward();
  await expect(pane).toBeVisible();
  await overview.getByRole('button', { name: '退出全览' }).click();
  await expect(page).toHaveURL(dashboardUrl);

  const direct = await context.newPage();
  await direct.setViewportSize({ width: 390, height: 844 });
  await direct.goto(new URL('/overview', page.url()).href);
  const directOverview = direct.getByRole('dialog', { name: '任务全览' });
  const directPane = directOverview.getByRole('region', { name: `本机工作空间 · ${localTitle}` });
  await expect(directPane).toBeVisible();
  await direct.reload();
  await expect(directPane).toBeVisible();
  await directPane.getByRole('button', { name: '打开会话详情' }).click();
  await expect(direct).toHaveURL(/\/\?[^#]*session=/);
  await expect(directOverview).toBeHidden();
  await expect(direct.getByRole('heading', { name: localTitle, exact: true })).toBeVisible();
  await direct.goBack();
  await expect(directPane).toBeVisible();
  await directOverview.getByRole('button', { name: '退出全览' }).click();
  await expect(direct).toHaveURL(/\/\?workspace=/);
  await expect(directOverview).toBeHidden();
});

test('running overview follows and sends messages independently across workspaces', async ({
  signedIn: { browserPage: page, workspace },
  local,
  monitor,
  context,
}) => {
  const remote = await monitor.addWorkspace('远程全览工作空间', '远程全览任务');
  const third = await monitor.addWorkspace('第三个全览工作空间', '第三个全览任务');
  const trigger = page.getByRole('button', { name: '查看运行中的会话' });
  await expect(trigger).toHaveText('3');
  await trigger.click();
  await page.getByRole('button', { name: '全览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '任务全览' });
  const localPane = overview.getByRole('region', { name: `本机工作空间 · ${localTitle}` });
  const remotePane = overview.getByRole('region', { name: '远程全览工作空间 · 远程全览任务' });
  const thirdPane = overview.getByRole('region', { name: '第三个全览工作空间 · 第三个全览任务' });
  await expect(overview.getByRole('region', { name: '会话输出' })).toHaveCount(3);
  await expect(remotePane.locator('.overview-message').first()).toBeVisible();
  const lastActive = remotePane.getByTitle(/^最后活跃时间/);
  await expect(lastActive).toHaveText('刚刚');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const localTools = localPane.locator('.activity-group').filter({ hasText: '2 次工具调用' });
  await expect(localTools).not.toHaveAttribute('open');
  await localTools.locator(':scope > summary').click();
  await expect(localTools.getByLabel('执行失败')).toBeVisible();
  const command = localTools.locator('.tool-card').filter({ hasText: 'npm test' });
  await command.locator('summary').click();
  await expect(command.locator('pre')).toHaveText('npm test');
  await command.getByRole('button', { name: '复制工具调用' }).click();
  await expect(overview.getByText('已复制到剪贴板')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm test');
  const localInput = localPane.getByRole('textbox');
  const remoteInput = remotePane.getByRole('textbox');

  await localInput.fill('本机分屏草稿');
  await remoteInput.fill('远程分屏草稿');
  local.data.append('来自本机的实时进展');
  remote.data.hist.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)').run(
    ids.modern,
    'overview-realtime-tool',
    99,
    Date.now(),
    JSON.stringify({ type: 'commandExecution', command: 'echo remote-only', status: 'inProgress' }),
  );
  const remoteProgressAt = Date.now();
  remote.data.hist.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)').run(
    ids.modern,
    'overview-realtime-progress',
    100,
    remoteProgressAt,
    JSON.stringify({ type: 'agentMessage', text: '来自远程的实时进展', phase: 'commentary' }),
  );
  await expect(localPane.getByText('来自本机的实时进展')).toBeVisible();
  await expect(remotePane.getByText('来自远程的实时进展')).toBeVisible();
  await expect(lastActive).toHaveAttribute('datetime', new Date(remoteProgressAt).toISOString());
  await expect(command.locator('pre')).toBeVisible();
  const remoteTools = remotePane.locator('.activity-group').filter({ hasText: '正在执行' });
  await remoteTools.locator(':scope > summary').click();
  await expect(remoteTools.locator('.tool-preview')).toHaveText('echo remote-only');
  await expect(remoteTools.getByLabel('执行中')).toBeVisible();
  await expect(localPane.getByText('echo remote-only')).toHaveCount(0);
  await expect(localInput).toHaveValue('本机分屏草稿');
  await expect(remoteInput).toHaveValue('远程分屏草稿');

  await remotePane.getByRole('button', { name: '放大此会话' }).click();
  await expect(localPane).toBeHidden();
  await expect(remoteInput).toHaveValue('远程分屏草稿');
  const contextUsage = remotePane.getByRole('button', { name: '上下文用量' });
  await contextUsage.click();
  const usageDetails = remotePane.getByRole('dialog', { name: '上下文用量' });
  await expect(usageDetails.getByText('上下文窗口上限未知')).toBeVisible();
  await appendFile(
    path.join(remote.data.home, 'sessions', `rollout-${ids.modern}.jsonl`),
    JSON.stringify({
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'token_count',
        info: { model_context_window: 200000, last_token_usage: { total_tokens: 150000 } },
      },
    }) + '\n',
  );
  await expect(usageDetails.getByRole('meter')).toHaveText('已用 75.0%');
  await expect(usageDetails.getByText('150,000 / 200,000 tokens')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(usageDetails).toBeHidden();
  await expect(localPane).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(localInput).toHaveValue('本机分屏草稿');
  await expect(localPane.getByRole('button', { name: '上下文用量' }))
    .toHaveAccessibleDescription(/上下文窗口上限未知/);

  await page.setViewportSize({ width: 800, height: 500 });
  await expect(overview.getByRole('region', { name: '会话输出' })).toHaveCount(2);
  await overview.getByRole('button', { name: '下一页' }).click();
  await expect(overview.getByRole('region', { name: '会话输出' })).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(thirdPane).toBeVisible();
  await expect(localInput).toHaveValue('本机分屏草稿');
  await expect(remoteInput).toHaveValue('远程分屏草稿');

  await localPane.getByRole('button', { name: '追加消息' }).click();
  await remotePane.getByRole('button', { name: '追加消息' }).click();
  await expect(localPane.getByText('测试回复：本机分屏草稿')).toBeVisible();
  await expect(remotePane.getByText('测试回复：远程分屏草稿')).toBeVisible();
  expect(local.control.sends).toBe(1);
  expect(remote.control.sends).toBe(1);
  expect(third.control.sends).toBe(0);
  await expect(workspace.workspaceSelector).toHaveValue(local.id);

  await page.keyboard.press('Escape');
  await expect(overview).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('creating from the overview adds a remote session pane even before attention sync', async ({
  signedIn: { browserPage: page, workspace },
  local,
  monitor,
}) => {
  const remoteName = '远程新建工作空间';
  const remote = await monitor.addWorkspace(remoteName, '已有远程会话');
  await page.route(`**/api/workspaces/${remote.id}/sessions/attention`, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.running = snapshot.running?.filter(({ id }: { id: string }) => id === ids.modern);
    await route.fulfill({ response, json: snapshot });
  });
  const trigger = page.getByRole('button', { name: '查看运行中的会话' });
  await expect(trigger).toHaveText('2');
  await trigger.click();
  await page.getByRole('button', { name: '全览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '任务全览' });
  const start = overview.getByRole('button', { name: '新建会话', exact: true });
  const editor = overview.getByRole('dialog', { name: '新建会话', exact: true });
  const localPane = overview.getByRole('region', { name: `本机工作空间 · ${localTitle}` });
  await localPane.getByRole('textbox').fill('原会话草稿');
  await start.click();
  await expect(editor.getByRole('tab', { name: '本机工作空间' })).toHaveAttribute('aria-selected', 'true');
  await editor.getByRole('tab', { name: remoteName }).click();
  await expect(editor.getByRole('radio', { name: 'work', exact: true })).toBeChecked();
  const prompt = '从全览启动远程会话';
  const input = editor.getByRole('textbox', { name: '发送给 Codex 的消息' });
  await input.fill(prompt);
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(start).toBeFocused();
  await start.click();
  await expect(input).toHaveValue(prompt);

  let rejectCreation = true;
  await page.route(`**/api/workspaces/${remote.id}/sessions`, (route) => {
    if (route.request().method() !== 'POST' || !rejectCreation) return route.fallback();
    rejectCreation = false;
    return route.fulfill({ status: 400, json: { error: '暂时无法创建' } });
  });
  const send = editor.getByRole('button', { name: '创建并发送' });
  await send.click();
  await expect(editor.getByRole('alert')).toHaveText('暂时无法创建');
  await expect(input).toHaveValue(prompt);
  await expect(overview.getByRole('region', { name: `${remoteName} · ${prompt}` })).toHaveCount(0);
  await send.click();

  await expect(editor).toBeHidden();
  await expect(overview).toBeVisible();
  const pane = overview.getByRole('region', { name: `${remoteName} · ${prompt}` });
  await expect(pane.getByText(`测试回复：${prompt}`)).toBeVisible();
  await expect(localPane.getByRole('textbox')).toHaveValue('原会话草稿');
  await expect(overview.getByRole('region', { name: '会话输出' })).toHaveCount(3);
  expect(remote.control.creates).toBe(1);
  expect(local.control.creates).toBe(0);
  await pane.getByRole('button', { name: '打开会话详情' }).click();
  await expect(workspace.workspaceSelector).toHaveValue(remote.id);
});

test('the overview continues an existing remote session without adding duplicate panes', async ({
  signedIn: { browserPage: page, workspace },
  monitor,
  local,
}) => {
  const remoteName = '远程历史工作空间';
  const title = '远程历史开发任务';
  const remote = await monitor.addWorkspace(remoteName, title);
  remote.data.hist
    .prepare("UPDATE thread_turns SET status='completed',completed_at=? WHERE thread_id=?")
    .run(Math.floor(Date.now() / 1000), ids.modern);

  await page.getByRole('button', { name: '查看运行中的会话' }).click();
  await page.getByRole('button', { name: '全览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '任务全览' });
  const open = overview.getByRole('button', { name: '继续历史会话', exact: true });
  const picker = overview.getByRole('dialog', { name: '继续历史会话' });
  const search = picker.getByRole('textbox', { name: '搜索历史会话' });
  const row = picker.getByRole('button', { name: `继续会话 ${title}（${remoteName}）` });
  const pane = overview.getByRole('region', { name: `${remoteName} · ${title}` });
  await expect(pane).toHaveCount(0);

  await open.click();
  await expect(search).toBeFocused();
  await picker.getByRole('combobox', { name: '历史会话工作空间' }).selectOption(remote.id);
  await expect(picker.getByRole('list', { name: '可继续的会话' })).toBeVisible();
  await expect(picker.getByRole('button', { name: /已归档的历史会话|内部子代理任务/ })).toHaveCount(0);
  await search.fill(title);
  await expect(row).toBeEnabled();
  await row.click();
  await expect(picker).toBeHidden();
  await expect(open).toBeFocused();
  await expect(pane.getByRole('region', { name: '会话输出' })).toBeVisible();

  await open.click();
  await row.click();
  await expect(pane).toHaveCount(1);

  const message = '从全览继续这条历史会话';
  await pane.getByRole('textbox').fill(message);
  const sent = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/workspaces/${remote.id}/sessions/${ids.modern}/messages` &&
    response.request().method() === 'POST',
  );
  await pane.getByRole('button', { name: '发送消息', exact: true }).click();
  expect((await sent).ok()).toBe(true);
  await expect(pane.getByText(`测试回复：${message}`)).toBeVisible();
  await expect(overview).toBeVisible();
  await expect(workspace.workspaceSelector).toHaveValue(local.id);
  expect(remote.control.sends).toBe(1);
  expect(remote.control.creates).toBe(0);
  expect(local.control.sends).toBe(0);
});

test('the overview composer floats over the remote pane and retains its draft and controls', async ({
  signedIn: { browserPage: page },
  local,
  monitor,
}) => {
  const remote = await monitor.addWorkspace('远程编辑工作空间', '远程编辑任务');
  await writeFile(path.join(remote.data.root, 'project', 'remote-notes.txt'), 'remote notes');
  await expect(page.getByRole('button', { name: '查看运行中的会话' })).toHaveText('2');
  await page.getByRole('button', { name: '查看运行中的会话' }).click();
  await page.getByRole('button', { name: '全览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '任务全览' });
  const pane = overview.getByRole('region', { name: '远程编辑工作空间 · 远程编辑任务' });
  const expand = pane.getByRole('button', { name: '展开消息编辑器' });
  const compactInput = pane.getByRole('textbox');
  const composer = page.getByRole('dialog', { name: '远程编辑工作空间 · 远程编辑任务' });
  const input = composer.getByRole('textbox', { name: '发送给 Codex 的消息' });
  await expect(pane.getByRole('button', { name: '快捷操作' })).toHaveCount(0);
  await compactInput.fill('远程编辑草稿');
  const expandBounds = (await expand.boundingBox())!;
  const compactInputBounds = (await compactInput.boundingBox())!;
  expect(expandBounds.x + expandBounds.width).toBeLessThan(compactInputBounds.x);
  expect(expandBounds.y).toBeCloseTo(compactInputBounds.y, 0);
  await expand.click();
  await expect(input).toHaveValue('远程编辑草稿');
  await expect(input).toBeFocused();
  const paneBounds = (await pane.boundingBox())!;
  const composerBounds = (await composer.boundingBox())!;
  const inputBounds = (await input.boundingBox())!;
  expect(composerBounds.width).toBeLessThan(720);
  expect(composerBounds.height).toBeLessThan(260);
  expect(composerBounds.x).toBeGreaterThan(paneBounds.x);
  expect(composerBounds.x + composerBounds.width).toBeLessThan(paneBounds.x + paneBounds.width);
  expect(composerBounds.y + composerBounds.height).toBeCloseTo(
    paneBounds.y + paneBounds.height - 8,
    0,
  );
  expect(inputBounds.height).toBeLessThan(100);
  await expect(composer.getByRole('button', { name: '上下文用量' })).toBeVisible();
  await expect(composer.getByRole('button', { name: '发送设置' })).toBeVisible();

  await composer.getByRole('button', { name: '快捷操作' }).click();
  await composer.getByRole('button', { name: '目标', exact: true }).click();
  await expect(composer.getByRole('dialog', { name: '目标管理' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(composer.getByRole('dialog', { name: '目标管理' })).toBeHidden();

  await composer.getByRole('button', { name: '添加内容' }).click();
  await composer.getByRole('button', { name: '引用会话', exact: true }).click();
  const reference = composer.getByRole('dialog', { name: '引用会话' });
  await expect(reference.getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(reference).toBeHidden();

  await composer.getByRole('button', { name: '添加内容' }).click();
  await composer.getByRole('button', { name: '项目文件' }).click();
  const files = page.getByRole('dialog', { name: '选择项目文件' });
  await expect(files.getByRole('checkbox', { name: '选择文件 remote-notes.txt' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(files).toBeHidden();
  await expect(input).toBeVisible();

  const upload = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/workspaces/${remote.id}/uploads` &&
    response.request().method() === 'POST',
  );
  await composer.getByLabel('上传图片或文件').setInputFiles({
    name: 'draft.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('attachment content'),
  });
  expect((await upload).status()).toBe(201);
  await expect(composer.getByText('draft.txt', { exact: true })).toBeVisible();
  await input.fill('修改后的远程编辑草稿');
  await page.keyboard.press('Escape');
  await expect(composer).toBeHidden();
  await expect(expand).toBeFocused();
  await expect(pane.getByRole('textbox')).toHaveValue('修改后的远程编辑草稿');
  await expand.click();
  await expect(composer.getByText('draft.txt', { exact: true })).toBeVisible();
  await page.mouse.click(composerBounds.x - 5, composerBounds.y);
  await expect(composer).toBeHidden();
  await expect(expand).toBeFocused();
  await expand.click();
  await composer.getByRole('button', { name: '追加消息' }).click();
  await expect(composer).toBeHidden();
  await expect(expand).toBeFocused();
  await expect(compactInput).toHaveValue('');
  await expect(pane.getByText(/Codex 已接收/)).toBeVisible();
  expect(remote.control.sends).toBe(1);
  expect(local.control.sends).toBe(0);
  await expect(overview).toBeVisible();
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
