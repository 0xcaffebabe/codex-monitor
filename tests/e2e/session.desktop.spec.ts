import { readFile } from 'node:fs/promises';
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
