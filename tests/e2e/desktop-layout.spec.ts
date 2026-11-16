import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ids } from '../fixture.js';

let token = '';
async function enter(page: Page, request: APIRequestContext, width = 1440, height = 900) {
  if (
    !token ||
    !(
      await request.get('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).ok()
  ) {
    const status = await (await request.get('/api/auth/status')).json();
    const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
    const response = await request.post(`/api/auth/${status.configured ? 'login' : 'setup'}`, {
      data: status.configured
        ? credentials
        : {
            ...credentials,
            setupKey: readFileSync(
              path.join(
                process.env.MONITOR_TEST_ROOT ||
                  path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa'),
                'data/setup-key.txt',
              ),
              'utf8',
            ).trim(),
          },
    });
    expect(response.ok()).toBeTruthy();
    token = (await response.json()).token;
  }
  await page.addInitScript((value) => localStorage.setItem('codex-monitor.auth.v1', value), token);
  await page.setViewportSize({ width, height });
  await page.goto(`/?session=${ids.modern}`);
  await expect(page.locator('.timeline .message').first()).toBeVisible();
  await expect(page.locator('.message-composer')).not.toHaveClass(/unavailable/);
}

test.describe('PC layout', () => {
  test.skip(
    ({ isMobile }) => isMobile,
    'Desktop-specific layout; mobile has its own regression suite',
  );

  for (const [width, height] of [
    [1024, 768],
    [1280, 720],
    [1366, 768],
    [1440, 900],
    [1920, 960],
    [2560, 1440],
  ]) {
    test(`gives the conversation priority at ${width}x${height}`, async ({ page, request }) => {
      await enter(page, request, width, height);
      const reader = await page.locator('.timeline-scroll').boundingBox();
      const column = await page.locator('.timeline-column').boundingBox();
      expect(reader!.height).toBeGreaterThan(height * 0.52);
      expect(column!.width).toBeGreaterThan(width * 0.64);
      await expect(page.getByLabel('搜索会话内容', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '会话信息', exact: true })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await expect(page.locator('.outline')).toBeVisible();
      expect(
        await page.evaluate(() => ({
          overflowX: document.documentElement.scrollWidth > innerWidth,
          overflowY: document.documentElement.scrollHeight > innerHeight,
        })),
      ).toEqual({ overflowX: false, overflowY: false });
      await page.screenshot({ path: test.info().outputPath(`pc-${width}x${height}.png`) });
    });
  }

  test('restores panel preferences and preserves drafts through focus mode', async ({
    page,
    request,
  }) => {
    await enter(page, request);
    const navigation = page.getByRole('button', { name: '切换导航', exact: true });
    const sessions = page.getByRole('button', { name: '切换会话列表', exact: true });
    const input = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true });
    await input.fill('PC 布局草稿，保留但不发送');
    await navigation.click();
    await sessions.click();
    await expect(page.locator('.sidebar')).toHaveCSS('width', '216px');
    await expect(page.locator('.session-panel')).toBeHidden();
    await page.getByRole('button', { name: '专注模式', exact: true }).click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.outline')).toHaveCount(0);
    await input.blur();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.session-panel')).toBeHidden();
    await expect(input).toHaveValue('PC 布局草稿，保留但不发送');
    await page.reload();
    await expect(page.locator('.sidebar')).toHaveCSS('width', '216px');
    await expect(page.locator('.session-panel')).toBeHidden();
    await expect(input).toHaveValue('PC 布局草稿，保留但不发送');
    await page.keyboard.press('/');
    await expect(page.getByRole('textbox', { name: '搜索会话', exact: true })).toBeFocused();
    await page.getByTitle('恢复自动布局').click();
    await expect(page.locator('.sidebar')).toHaveCSS('width', '64px');
    await expect(page.locator('.session-panel')).toBeVisible();
  });

  test('uses a dismissible session drawer in narrow windows and survives resizing', async ({
    page,
    request,
  }) => {
    await enter(page, request, 1024, 768);
    const widthBefore = (await page.locator('.timeline-column').boundingBox())!.width;
    await expect(page.locator('.session-panel')).toBeHidden();
    await page.getByRole('button', { name: '切换会话列表', exact: true }).click();
    await expect(page.locator('.session-panel')).toBeVisible();
    expect((await page.locator('.timeline-column').boundingBox())!.width).toBe(widthBefore);
    await page
      .getByRole('button', { name: '关闭会话列表', exact: true })
      .click({ position: { x: 600, y: 100 } });
    await expect(page.locator('.session-panel')).toBeHidden();
    await page.keyboard.press('/');
    await expect(page.getByRole('textbox', { name: '搜索会话', exact: true })).toBeFocused();
    await page
      .getByTestId('session-row')
      .filter({ hasText: '检查旧版本会话解析' })
      .filter({ hasText: '本机工作空间' })
      .click();
    await expect(page.locator('.detail-heading')).toContainText('检查旧版本会话解析');
    await expect(page.locator('.session-panel')).toBeHidden();
    await page.setViewportSize({ width: 1920, height: 960 });
    await expect(page.locator('.session-panel')).toBeVisible();
    await expect(page.locator('.outline')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTitle('打开菜单', { exact: true })).toBeVisible();
    await expect(page.locator('.desktop-panel-controls')).toBeHidden();
    await expect(page.locator('.session-panel')).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.sidebar')).toHaveCSS('width', '64px');
    await expect(page.locator('.session-panel')).toBeVisible();
    await expect(page.locator('.outline')).toBeVisible();
  });

  test('keeps the conversation rail within the reader without changing its width', async ({
    page,
    request,
  }) => {
    await enter(page, request, 1440, 900);
    const readerWidth = (await page.locator('.timeline-column').boundingBox())!.width;
    await page.getByTitle('对话目录', { exact: true }).click();
    await expect(page.locator('.outline')).toHaveCount(0);
    expect((await page.locator('.timeline-column').boundingBox())!.width).toBe(readerWidth);
    await page.getByTitle('对话目录', { exact: true }).click();
    await expect(page.locator('.outline')).toHaveCSS('position', 'absolute');
    expect((await page.locator('.timeline-column').boundingBox())!.width).toBe(readerWidth);
    await page.setViewportSize({ width: 1920, height: 960 });
    await expect(page.locator('.timeline-reader > .outline')).toBeVisible();
    await expect(page.locator('.outline')).toHaveCSS('position', 'absolute');
    await page.getByRole('button', { name: '会话信息', exact: true }).click();
    await expect(page.getByRole('button', { name: /会话用量/ })).toBeVisible();
    await page.getByRole('button', { name: '会话信息', exact: true }).click();
    await page.getByRole('button', { name: '专注模式', exact: true }).click();
    await expect(page.locator('.outline')).toHaveCount(0);
    await page.getByTitle('对话目录', { exact: true }).click();
    await expect(page.getByRole('button', { name: '专注模式', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.locator('.outline')).toBeVisible();
    await page.getByRole('button', { name: '目标', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.locator('.modal-backdrop').boundingBox()).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 960,
    });
    await page.getByTitle('关闭目标管理', { exact: true }).click();
  });
});
