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
