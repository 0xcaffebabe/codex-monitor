import { test, expect } from './monitor.js';

test('server maintenance action confirms the update and shows its status after a disconnect', async ({
  signedIn: { browserPage: page },
}) => {
  let status: 'restarting' | 'succeeded' | undefined;
  let disconnected = false;
  await page.route('**/api/workspaces', async (route) => {
    if (disconnected) return route.fulfill({ status: 503 });
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, serverUpdateSupported: true, serverUpdate: status && { phase: status } },
    });
  });
  await page.route('**/api/server/update', async (route) => {
    expect(route.request().method()).toBe('POST');
    status = 'restarting';
    await route.fulfill({ status: 202, json: { ok: true } });
  });
  await page.getByRole('button', { name: '管理工作空间' }).click();
  const dialog = page.getByRole('dialog', { name: '管理工作空间' });
  const button = dialog.getByRole('button', { name: '更新并重启服务端' });
  await button.click();
  expect(status).toBeUndefined();
  await dialog.getByRole('button', { name: '确认更新服务端' }).click();
  await expect(button).toBeDisabled();
  await expect(dialog.getByRole('status')).toContainText('正在重启');

  disconnected = true;
  await expect(dialog.getByRole('alert')).toBeVisible();
  disconnected = false;
  status = 'succeeded';
  await expect(dialog.getByRole('status')).toHaveText('服务端更新完成');
  await expect(button).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(button).toBeInViewport();
});
