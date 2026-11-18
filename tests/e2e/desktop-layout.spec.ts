import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ids } from '../fixture.js';
import { openComposerMenu } from './composer-helpers';
import { openSessionAction, sessionActions } from './session-action-helpers';

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
      const prose = page.locator('.timeline .markdown').first();
      await expect(prose).toHaveCSS('font-size', width >= 1800 ? '17px' : '16px');
      expect((await prose.boundingBox())!.width).toBeLessThanOrEqual(880);
      await expect(page.getByLabel('搜索会话内容', { exact: true })).toHaveCount(0);
      expect((await page.locator('.detail-header').boundingBox())!.height).toBeLessThanOrEqual(76);
      await expect(sessionActions(page)).toHaveAttribute(
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
    await expect(page.getByRole('button', { name: '展开对话目录', exact: true })).toBeVisible();
    await expect(page.locator('.outline')).toHaveCount(0);
    await page.getByRole('button', { name: '展开对话目录', exact: true }).click();
    await expect(page.locator('.mobile-outline-scrim')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.mobile-outline')).toHaveCount(0);
    await expect(page.locator('.mobile-outline-scrim')).toHaveCount(0);
    await expect(page.locator('.sidebar')).toHaveCSS('width', '64px');
    await expect(page.locator('.session-panel')).toBeVisible();
    await expect(page.locator('.outline')).toBeVisible();
  });

  test('keeps a compact conversation rail floating on the left without header toggles', async ({
    page,
    request,
  }) => {
    await enter(page, request, 1440, 900);
    const readerWidth = (await page.locator('.timeline-column').boundingBox())!.width;
    await expect(page.locator('.outline')).toHaveCSS('position', 'absolute');
    await expect(page.locator('.outline-marker').first()).toBeVisible();
    await expect(page.locator('.outline-popover')).toHaveCount(0);
    for (const title of ['复制恢复命令', '导出 Markdown', '对话目录'])
      await expect(page.locator('.detail-header').getByTitle(title, { exact: true })).toHaveCount(
        0,
      );
    const outline = (await page.locator('.outline').boundingBox())!;
    expect(outline.width).toBeLessThan(50);
    const message = (await page.locator('.timeline .message').first().boundingBox())!;
    expect(outline.x + outline.width).toBeLessThan(message.x);
    expect((await page.locator('.timeline-column').boundingBox())!.width).toBe(readerWidth);
    await page.setViewportSize({ width: 1920, height: 960 });
    await expect(page.locator('.timeline-reader > .outline')).toBeVisible();
    await expect(page.locator('.outline')).toHaveCSS('position', 'absolute');
    await openSessionAction(page, '会话信息');
    await expect(page.getByRole('button', { name: /会话用量/ })).toBeVisible();
    await page.getByTitle('关闭会话信息').click();
    await expect(sessionActions(page)).toBeFocused();
    await page.getByRole('button', { name: '专注模式', exact: true }).click();
    await expect(page.locator('.outline')).toHaveCount(0);
    await page.getByTitle('退出专注模式（Esc）', { exact: true }).click();
    await expect(page.getByRole('button', { name: '专注模式', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.locator('.outline')).toBeVisible();
    await openComposerMenu(page, '快捷操作');
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

test('keeps the iPhone Pro Max conversation readable with tools outside the reader', async ({
  page,
  request,
  isMobile,
}) => {
  test.skip(!isMobile, 'Uses the mobile browsing context');
  await page.route('**/api/workspaces/local/sessions?status=running&limit=100&offset=0', (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: ids.modern,
            title: '测试进行中会话',
            cwd: '/test/project',
            project: 'project',
            status: 'running',
            updatedAt: Date.now(),
          },
        ],
        hasMore: false,
      },
    }),
  );
  await enter(page, request, 440, 763);
  await expect(page.locator('.timeline .markdown').first()).toHaveCSS('font-size', '16px');
  const outline = page.getByRole('button', { name: '展开对话目录', exact: true });
  const home = page.getByRole('button', { name: '返回任务动态', exact: true });
  const running = page.getByRole('button', { name: '查看运行中的会话', exact: true });
  await expect(running).toBeVisible();
  const reader = (await page.locator('.timeline-reader').boundingBox())!;
  for (const button of [outline, sessionActions(page)]) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(reader.y);
  }
  const runningBounds = (await running.boundingBox())!;
  expect(runningBounds.x).toBeGreaterThan(220);
  expect(runningBounds.y).toBeGreaterThan(reader.y + reader.height);
  const input = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true });
  await expect(input).toHaveCSS('font-size', '16px');
  await input.fill('移动端草稿');
  await input.press('Enter');
  await input.press('End');
  await input.press('A');
  await expect(input).toHaveValue('移动端草稿\nA');
  await outline.tap();
  await expect(page.getByRole('complementary', { name: '对话目录', exact: true })).toBeVisible();
  await page.getByTitle('收起对话目录', { exact: true }).tap();
  await expect(input).toHaveValue('移动端草稿\nA');
  await expect(outline).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(440);
  const refresh = page.getByTitle('刷新数据', { exact: true });
  for (const width of [320, 390, 440]) {
    await page.setViewportSize({ width, height: 763 });
    const bounds = (await refresh.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await page.screenshot({ path: test.info().outputPath('iphone-17-pro-max.png') });
  await page.getByTitle('返回会话列表', { exact: true }).tap();
  await expect(page.getByTestId('session-row').first()).toBeInViewport({ ratio: 0.5 });
  await home.tap();
  await expect(page.getByRole('heading', { name: '任务动态', exact: true })).toBeVisible();
});
