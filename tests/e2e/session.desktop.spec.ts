import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ids } from '../fixture.js';
import { expect, localTitle, test } from './monitor.js';

test('reads archived history and renders untrusted conversation Markdown without remote images', async ({
  signedIn: { browserPage, workspace, session },
  local,
}) => {
  const externalImages: string[] = [];
  const externalHost = 'example.com';
  browserPage.on('request', (request) => {
    if (new URL(request.url()).hostname === externalHost) externalImages.push(request.url());
  });
  await workspace.showArchivedSessions();
  await workspace.openSession('已归档的历史会话');
  await expect(session.message('旧版会话读取成功。')).toBeVisible();

  await session.open(local.id, ids.modern);
  await expect(session.heading(localTitle)).toBeVisible();
  await expect(session.markdownCell('通过')).toBeVisible();
  await expect(session.forbiddenMarkdownElements(externalHost)).toHaveCount(0);
  expect(externalImages).toEqual([]);
});

test('opens a linked file outside the selected workspace project and downloads its workbook', async ({
  signedIn: { browserPage, session },
  monitor,
  local,
}) => {
  const remote = await monitor.addWorkspace('报告主机', '验证报告文件引用');
  const filename = '结果 日志.txt';
  const workbook = '结果 表.xlsx';
  const workbookData = Buffer.from([0x50, 0x4b, 3, 4, 0, 0]);
  const message = [
    '| 内容 | 项目文件 |',
    '| --- | --- |',
    `| 验证结果 | [外部日志](<../${filename}#L3-L4>) |`,
    '',
    '[验收表格][result]',
    '',
    `[result]: <../${workbook}>`,
    '',
    '[网页](https://example.com/docs)',
  ].join('\n');
  await writeFile(path.join(local.data.root, filename), '本机文件');
  await writeFile(path.join(remote.data.root, filename), '报告文件\n记录开始\n报告主机的第 3 行\n报告主机的第 4 行\n');
  await writeFile(path.join(remote.data.root, workbook), workbookData);
  local.data.append(message);
  remote.data.append(message);
  await session.open(remote.id, ids.modern);
  const link = session.detail.getByRole('button', { name: '外部日志', exact: true });
  let opened = 0;
  browserPage.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/file-preview/')) opened++;
  });
  await expect(link).toBeVisible();
  expect(opened).toBe(0);
  await expect(session.detail.getByRole('link', { name: '网页', exact: true })).toHaveAttribute('href', 'https://example.com/docs');
  await link.click();
  const dialog = browserPage.getByRole('dialog', { name: '文件预览' });
  await expect(dialog.getByRole('heading', { name: filename })).toBeVisible();
  await expect(dialog).toContainText('报告主机 · 第 3–4 行');
  await expect(dialog.locator('.file-preview-line.highlighted')).toHaveCount(2);
  await expect(dialog.locator('[data-target-line]')).toContainText('报告主机的第 3 行');
  await browserPage.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(link).toBeFocused();

  await session.detail.getByRole('button', { name: '验收表格', exact: true }).click();
  const downloading = browserPage.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载文件' }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe(workbook);
  expect(await readFile(await downloaded.path())).toEqual(workbookData);
});

test('a submitted message reaches a second tab via the real session stream', async ({
  signedIn: app,
  local,
}) => {
  await app.session.open(local.id, ids.modern);
  const observer = await app.newTab();
  const now = Date.now();
  await observer.browserPage.clock.install({ time: now });
  await observer.browserPage.clock.pauseAt(now + 1000);
  const stream = observer.browserPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/workspaces/${local.id}/stream` &&
      new URL(response.url()).searchParams.get('session') === ids.modern &&
      response.ok(),
  );
  await observer.session.open(local.id, ids.modern);
  expect((await stream).headers()['content-type']).toContain('text/event-stream');
  await expect(observer.session.liveSync).toBeVisible();
  await expect(observer.session.heading(localTitle)).toBeVisible();

  const prompt = '请验证消息已通过加密连接同步';
  await app.session.sendMessage(prompt);
  await expect(observer.session.message(`测试回复：${prompt}`)).toBeVisible();
  expect(local.control.sends).toBe(1);
});

test('the open conversation receives new records again after a real client disconnect', async ({
  signedIn: { session, workspace },
  local,
}) => {
  await session.open(local.id, ids.modern);
  await expect(session.liveSync).toBeVisible();
  await expect(session.heading(localTitle)).toBeVisible();
  local.data.append('断开前写入的会话记录');
  await expect(session.message('断开前写入的会话记录')).toBeVisible();

  await local.stop();
  await expect(workspace.offlineNotice).toBeVisible();
  await expect(session.liveSync).toBeHidden();
  await local.start();
  await expect(workspace.offlineNotice).toBeHidden();
  await expect(session.liveSync).toBeVisible();
  local.data.append('重连后写入的会话记录');
  await expect(session.message('重连后写入的会话记录')).toBeVisible();
});

test('a completed goal leaves the composer but remains in goal management', async ({
  signedIn: { browserPage, session },
  local,
}) => {
  await browserPage.clock.install();
  await session.open(local.id, ids.modern);
  const objective = '验证目标完成后的显示';
  const goalStrip = session.detail.getByLabel('会话目标', { exact: true });
  const notice = session.detail.getByText('目标已更新，Codex 已接收执行指令。', { exact: true });
  const manager = await session.openGoalManager();
  await manager.getByRole('textbox', { name: '目标内容', exact: true }).fill(objective);
  const refreshed = browserPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(`/sessions/${ids.modern}/goal`) && response.ok(),
  );
  await manager.getByRole('button', { name: '设置目标并执行', exact: true }).click();
  await manager.getByRole('button', { name: '关闭目标管理', exact: true }).click();
  await expect(goalStrip).toHaveAttribute('data-status', 'active');
  await expect(notice).toBeVisible();
  await (await refreshed).finished();

  local.control.goals.get(ids.modern).status = 'complete';
  await browserPage.clock.fastForward(10000);
  await expect(goalStrip).toHaveCount(0);
  await expect(notice).toHaveCount(0);

  const currentGoal = (await session.openGoalManager()).getByLabel('当前目标', { exact: true });
  await expect(currentGoal).toContainText('已完成');
  await expect(currentGoal).toContainText(objective);
});

test('creates a session and waits for one explicit approval before writing the requested file', async ({
  signedIn: { newSession, session },
  local,
}) => {
  await newSession.open();
  await expect(newSession.permissions).toHaveValue('inherit');
  await newSession.choosePermissions('workspace-write-network');
  await newSession.createAndSend('APPROVAL_TEST:permissions');

  await expect(session.approval).toContainText('允许访问网络');
  await expect(session.approval).toContainText('仅本轮有效');
  const sessionId = session.currentId();
  expect(sessionId).toBeTruthy();
  const output = path.join(local.data.root, 'approval-output', `${sessionId}.txt`);
  await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await session.approveOnce();
  await expect(session.message('测试回复：APPROVAL_ALLOWED')).toBeVisible();
  await expect(session.allowOnce).toHaveCount(0);
  expect(await readFile(output, 'utf8')).toBe('approved\n');
  expect(local.control.creates).toBe(1);
});
