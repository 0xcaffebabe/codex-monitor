import { ids } from '../fixture.js';
import { expect, localTitle, test } from './monitor.js';

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
