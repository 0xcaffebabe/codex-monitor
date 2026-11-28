import { expect, test } from './monitor.js';

test('first-time setup, password login, remembered device and logout use the real account API', async ({
  app,
  monitor,
  local,
}) => {
  const { account, workspace, browserPage } = app;
  await account.setUpOwner(monitor.setupKey, monitor.credentials);
  await expect(workspace.activityHeading).toBeVisible();
  await expect(workspace.workspaceSelector).toHaveValue(local.id);
  await account.logOut();
  await expect(account.signInHeading).toBeVisible();

  await account.logIn({ ...monitor.credentials, password: 'incorrect' });
  await expect(account.loginError).toContainText('用户名或密码错误');
  await expect(account.rememberDevice).toBeChecked();
  const loginResponse = browserPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/auth/login' && response.ok(),
  );
  await account.logIn(monitor.credentials);
  const { token } = (await (await loginResponse).json()) as { token: string };
  await expect(workspace.activityHeading).toBeVisible();
  await browserPage.reload();
  await expect(workspace.activityHeading).toBeVisible();

  const otherTab = await app.newTab();
  await otherTab.browserPage.goto('/');
  await expect(otherTab.workspace.activityHeading).toBeVisible();
  await account.logOut();
  await expect(account.signInHeading).toBeVisible();
  const revoked = await browserPage.request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(revoked.status()).toBe(401);
  await otherTab.browserPage.reload();
  await expect(otherTab.account.signInHeading).toBeVisible();
});

test('notification settings persist private recipients without refilling the secret', async ({
  signedIn,
  local,
}) => {
  const { browserPage } = signedIn;
  const entry = browserPage.getByRole('button', { name: '设置与访问管理', exact: true });
  const settings = browserPage.getByRole('region', { name: '飞书 / Lark 通知' });
  await entry.click();
  await settings.getByLabel('应用平台').selectOption('feishu');
  await settings.getByLabel('App ID', { exact: true }).fill('cli_e2e');
  await settings.getByLabel('App Secret', { exact: true }).fill('test-app-secret');
  await settings.getByLabel('私聊接收人的 Open ID').fill('ou_owner，ou_operator');
  const targets = settings.getByRole('group', { name: 'Lark 新建会话目标' });
  await targets.getByRole('combobox', { name: '工作空间', exact: true }).selectOption(local.id);
  await targets.getByRole('combobox', { name: '项目', exact: true }).selectOption({ index: 1 });
  await targets.getByLabel('简称', { exact: true }).fill('w');
  await targets.getByRole('button', { name: '添加目标' }).click();
  await targets.getByLabel('简称', { exact: true }).fill('m');
  await targets.getByRole('button', { name: '添加目标' }).click();
  await targets.getByRole('combobox', { name: '默认目标', exact: true }).selectOption('m');
  const save = settings.getByRole('button', { name: '保存通知配置' });
  const sendTest = settings.getByRole('button', { name: '发送测试通知' });
  await expect(sendTest).toBeDisabled();
  await save.click();
  await expect(sendTest).toBeEnabled();
  await browserPage.reload();
  await entry.click();
  await expect(settings.getByLabel('应用平台')).toHaveValue('feishu');
  await expect(settings.getByLabel('App ID', { exact: true })).toHaveValue('cli_e2e');
  await expect(settings.getByLabel('私聊接收人的 Open ID')).toHaveValue('ou_owner, ou_operator');
  await expect(settings.getByLabel('App Secret', { exact: true })).toHaveValue('');
  await expect(targets.getByRole('combobox', { name: '默认目标', exact: true })).toHaveValue('m');
  await expect(targets.getByRole('button', { name: '移除简称 w' })).toBeVisible();
  await expect(sendTest).toBeEnabled();
  await settings.getByLabel('私聊接收人的 Open ID').fill('');
  await expect(sendTest).toBeDisabled();
});
