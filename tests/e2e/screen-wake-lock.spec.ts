import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ids } from '../fixture.js';

type MockLock = EventTarget & { released: boolean; release: () => Promise<void> };
type MockWakeLock = {
  requests: string[];
  locks: MockLock[];
  pending: (() => void)[];
  defer: boolean;
  reject: boolean;
  visibility: DocumentVisibilityState;
};
declare global {
  interface Window {
    testWakeLock: MockWakeLock;
  }
}

let cachedToken = '';
async function enter(page: Page, request: APIRequestContext, session?: string) {
  if (
    !cachedToken ||
    !(
      await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${cachedToken}` } })
    ).ok()
  ) {
    const { configured } = await (await request.get('/api/auth/status')).json();
    const root =
      process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
    const response = await request.post(`/api/auth/${configured ? 'login' : 'setup'}`, {
      data: {
        username: 'owner',
        password: 'monitor-e2e-password!',
        ...(!configured && {
          setupKey: readFileSync(path.join(root, 'data', 'setup-key.txt'), 'utf8').trim(),
        }),
      },
    });
    expect(response.ok()).toBeTruthy();
    cachedToken = (await response.json()).token;
  }
  await page.addInitScript(
    (token) => localStorage.setItem('codex-monitor.auth.v1', token),
    cachedToken,
  );
  await page.goto(session ? `/?session=${session}` : '/');
  await expect(
    session
      ? page.getByRole('region', { name: '会话详情' })
      : page.getByRole('heading', { name: '全部会话', exact: true }),
  ).toBeVisible();
}

async function mockWakeLock(
  page: Page,
  options: { supported?: boolean; secure?: boolean; defer?: boolean; reject?: boolean } = {},
) {
  await page.addInitScript((options) => {
    const mock: MockWakeLock = {
      requests: [],
      locks: [],
      pending: [],
      defer: !!options.defer,
      reject: !!options.reject,
      visibility: 'visible',
    };
    window.testWakeLock = mock;
    Object.defineProperty(document, 'visibilityState', { get: () => mock.visibility });
    if (options.secure === false)
      Object.defineProperty(window, 'isSecureContext', { value: false });
    Object.defineProperty(navigator, 'wakeLock', {
      value:
        options.supported === false
          ? undefined
          : {
              async request(type: string) {
                mock.requests.push(type);
                if (mock.defer) await new Promise<void>((resolve) => mock.pending.push(resolve));
                if (mock.reject)
                  throw new DOMException('System refused wake lock', 'NotAllowedError');
                const lock = new EventTarget() as MockLock;
                lock.released = false;
                lock.release = async () => {
                  if (lock.released) return;
                  lock.released = true;
                  lock.dispatchEvent(new Event('release'));
                };
                mock.locks.push(lock);
                return lock;
              },
            },
    });
  }, options);
}

const state = (page: Page) =>
  page.evaluate(() => ({
    requests: window.testWakeLock.requests.length,
    held: window.testWakeLock.locks.filter((lock) => !lock.released).length,
    pending: window.testWakeLock.pending.length,
  }));
const indicator = (page: Page) => page.locator('.screen-wake-lock');
async function visibility(page: Page, value: DocumentVisibilityState) {
  await page.evaluate((value) => {
    window.testWakeLock.visibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

test('iOS details keep the screen awake through refresh and rotation, and release on back and logout', async ({
  page,
  request,
  isMobile,
}) => {
  await mockWakeLock(page);
  await enter(page, request);
  expect(await state(page)).toEqual({ requests: 0, held: 0, pending: 0 });
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  if (!isMobile) {
    await expect(page.locator('.timeline .user-message')).toBeVisible();
    await expect(indicator(page)).toHaveCount(0);
    expect(await state(page)).toEqual({ requests: 0, held: 0, pending: 0 });
    return;
  }
  await expect(indicator(page)).toHaveText('屏幕常亮');
  expect(await state(page)).toEqual({ requests: 1, held: 1, pending: 0 });
  expect(await page.evaluate(() => window.testWakeLock.requests)).toEqual(['screen']);
  await page.getByTitle('刷新数据').click();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(indicator(page)).toHaveText('屏幕常亮');
  expect(await state(page)).toEqual({ requests: 1, held: 1, pending: 0 });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('ios-screen-awake.png'), fullPage: true });
  await page.getByTitle('返回会话列表').click();
  await expect.poll(() => state(page)).toEqual({ requests: 1, held: 0, pending: 0 });
  await page.getByTestId('session-row').filter({ hasText: '检查旧版本会话解析' }).click();
  await expect(indicator(page)).toHaveText('屏幕常亮');
  expect(await state(page)).toEqual({ requests: 2, held: 1, pending: 0 });
  await page.getByTitle('打开菜单').click();
  await page.getByTitle('退出登录').click();
  await expect(page.getByRole('button', { name: '进入工作空间' })).toBeVisible();
  await expect.poll(() => state(page)).toEqual({ requests: 2, held: 0, pending: 0 });
  await visibility(page, 'hidden');
  await visibility(page, 'visible');
  expect(await state(page)).toEqual({ requests: 2, held: 0, pending: 0 });
});

test('iOS details release in the background and reacquire after visibility and page restoration', async ({
  page,
  request,
  isMobile,
}) => {
  test.skip(!isMobile, 'iOS lifecycle');
  await mockWakeLock(page);
  await enter(page, request, ids.legacy);
  await expect(indicator(page)).toHaveText('屏幕常亮');
  await visibility(page, 'hidden');
  await expect.poll(() => state(page)).toEqual({ requests: 1, held: 0, pending: 0 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerdown')));
  expect(await state(page)).toEqual({ requests: 1, held: 0, pending: 0 });
  await visibility(page, 'visible');
  await expect(indicator(page)).toHaveText('屏幕常亮');
  await expect.poll(() => state(page)).toEqual({ requests: 2, held: 1, pending: 0 });
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  );
  await expect.poll(() => state(page)).toEqual({ requests: 2, held: 0, pending: 0 });
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(indicator(page)).toHaveText('屏幕常亮');
  await expect.poll(() => state(page)).toEqual({ requests: 3, held: 1, pending: 0 });
});

test('iOS details show system refusals and releases and allow a gesture to retry', async ({
  page,
  request,
  isMobile,
}) => {
  test.skip(!isMobile, 'iOS lifecycle');
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await mockWakeLock(page, { reject: true });
  await enter(page, request, ids.modern);
  await expect(indicator(page)).toHaveText('重试常亮');
  expect(await state(page)).toEqual({ requests: 1, held: 0, pending: 0 });
  await page.evaluate(() => {
    window.testWakeLock.reject = false;
  });
  await indicator(page).getByRole('button').click();
  await expect(indicator(page)).toHaveText('屏幕常亮');
  expect(await state(page)).toEqual({ requests: 2, held: 1, pending: 0 });
  await page.evaluate(() => window.testWakeLock.locks.at(-1)!.release());
  await expect(indicator(page)).toHaveText('重试常亮');
  expect(await state(page)).toEqual({ requests: 2, held: 0, pending: 0 });
  await page.getByLabel('发送给 Codex 的消息').click();
  await expect(indicator(page)).toHaveText('屏幕常亮');
  expect(await state(page)).toEqual({ requests: 3, held: 1, pending: 0 });
  expect(errors).toEqual([]);
});

test('late iOS wake lock requests cannot outlive hidden or closed session details', async ({
  page,
  request,
  isMobile,
}) => {
  test.skip(!isMobile, 'iOS lifecycle');
  await mockWakeLock(page, { defer: true });
  await enter(page, request, ids.modern);
  await expect.poll(() => state(page)).toEqual({ requests: 1, held: 0, pending: 1 });
  await visibility(page, 'hidden');
  await visibility(page, 'visible');
  expect(await state(page)).toEqual({ requests: 1, held: 0, pending: 1 });
  await page.evaluate(() => window.testWakeLock.pending.shift()!());
  await expect.poll(() => state(page)).toEqual({ requests: 2, held: 0, pending: 1 });
  await page.evaluate(() => window.testWakeLock.pending.shift()!());
  await expect(indicator(page)).toHaveText('屏幕常亮');
  expect(await state(page)).toEqual({ requests: 2, held: 1, pending: 0 });
  await page.getByTitle('返回会话列表').click();
  await expect.poll(() => state(page)).toEqual({ requests: 2, held: 0, pending: 0 });
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect.poll(() => state(page)).toEqual({ requests: 3, held: 0, pending: 1 });
  await page.getByTitle('返回会话列表').click();
  await page.evaluate(() => window.testWakeLock.pending.shift()!());
  await expect.poll(() => state(page)).toEqual({ requests: 3, held: 0, pending: 0 });
});

for (const scenario of [
  { name: 'HTTP access', options: { secure: false }, label: '常亮需 HTTPS' },
  { name: 'an unsupported browser', options: { supported: false }, label: '常亮不可用' },
]) {
  test(`iOS details explain ${scenario.name} without interrupting the conversation`, async ({
    page,
    request,
    isMobile,
  }) => {
    test.skip(!isMobile, 'iOS capability hints');
    await mockWakeLock(page, scenario.options);
    await enter(page, request, ids.modern);
    await expect(indicator(page)).toHaveText(scenario.label);
    await expect(page.locator('.timeline .user-message')).toBeVisible();
    await page.getByLabel('发送给 Codex 的消息').fill('仍可阅读和输入');
    expect(await state(page)).toEqual({ requests: 0, held: 0, pending: 0 });
    await page.setViewportSize({ width: 320, height: 700 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  });
}

test('iPadOS desktop mode can keep session details awake', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'Desktop user agent with iPad touch capabilities');
  await mockWakeLock(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.4 Safari/605.1.15',
    });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
  });
  await enter(page, request, ids.legacy);
  await expect(indicator(page)).toHaveText('屏幕常亮');
  expect(await state(page)).toEqual({ requests: 1, held: 1, pending: 0 });
  await page.getByTitle('返回会话列表').click();
  await expect.poll(() => state(page)).toEqual({ requests: 1, held: 0, pending: 0 });
});
