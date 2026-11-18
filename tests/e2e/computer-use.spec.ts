import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ids } from '../fixture.js';
import { openSessionAction, sessionActions } from './session-action-helpers';
import { computerUseRecords, seedComputerUse } from '../computer-use-fixture.js';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
let restore: (() => void) | undefined;
let token = '';
test.beforeEach(async ({}, info) => {
  const home = path.join(root, 'codex'),
    hist = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  const file = path.join(home, 'sessions', `rollout-${ids.modern}.jsonl`),
    original = readFileSync(file);
  const previous = state
    .prepare('SELECT updated_at,updated_at_ms FROM threads WHERE id=?')
    .get(ids.modern)!;
  seedComputerUse(home, hist, info.title.includes('older') ? 105 : 3);
  state
    .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
    .run(Math.floor(Date.now() / 1000), Date.now(), ids.modern);
  restore = () => {
    hist
      .prepare("DELETE FROM thread_items WHERE thread_id=? AND item_id LIKE 'cu-%'")
      .run(ids.modern);
    writeFileSync(file, original);
    state
      .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
      .run(previous.updated_at!, previous.updated_at_ms!, ids.modern);
    hist.close();
    state.close();
  };
});
test.afterEach(() => {
  restore?.();
  restore = undefined;
});
async function enter(page: Page, request: APIRequestContext, session = ids.modern) {
  if (
    !token ||
    !(await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).ok()
  ) {
    const { configured } = await (await request.get('/api/auth/status')).json();
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
    token = (await response.json()).token;
  }
  await page.addInitScript((token) => localStorage.setItem('codex-monitor.auth.v1', token), token);
  await page.goto(`/?session=${session}`);
  await expect(page.getByRole('region', { name: '会话详情' })).toBeVisible();
}

test('Computer Use opens a lazy timeline, switches screenshots and zooms without closing history', async ({
  page,
  request,
}) => {
  const loads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/computer-use')) loads.push(request.url());
  });
  await enter(page, request);
  const trigger = sessionActions(page);
  await expect(trigger).toBeVisible();
  expect(loads).toHaveLength(0);
  await openSessionAction(page, '操作回放');
  const dialog = page.getByRole('dialog', { name: 'Computer Use 时间线', exact: true });
  await expect(dialog.getByRole('heading', { name: '查看查询结果', exact: true })).toBeVisible();
  const first = dialog.getByRole('img', { name: '查看查询结果 · 截图 1', exact: true });
  await expect.poll(() => first.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(32);
  await dialog.getByRole('button', { name: '截图 2', exact: true }).click();
  await expect
    .poll(() =>
      dialog
        .getByRole('img', { name: '查看查询结果 · 截图 2', exact: true })
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1);
  await dialog.getByRole('button', { name: '放大查看图片：查看查询结果 · 截图 2' }).click();
  const lightbox = page.getByRole('dialog', { name: '图片预览', exact: true });
  await expect(lightbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('navigation')
    .getByRole('button', { name: /填写查询条件/ })
    .click();
  await expect(dialog.getByText('这一步未记录完整截图')).toBeVisible();
  await dialog.getByTitle('上一个操作').click();
  await expect(dialog.getByRole('heading', { name: '打开业务页面', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      dialog
        .getByRole('img', { name: '打开业务页面 · 截图 1', exact: true })
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(32);
  expect(
    await dialog.evaluate((element) => element.getBoundingClientRect().left),
  ).toBeGreaterThanOrEqual(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({
    path: test.info().outputPath('computer-use-timeline.png'),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Computer Use updates live while preserving a historical selection and handles request errors', async ({
  page,
  request,
}) => {
  await enter(page, request);
  const route = `**/api/workspaces/local/sessions/${ids.modern}/computer-use`;
  await page.route(route, (route) =>
    route.fulfill({ status: 503, json: { error: '操作记录暂时不可读' } }),
  );
  await openSessionAction(page, '操作回放');
  const dialog = page.getByRole('dialog', { name: 'Computer Use 时间线', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('操作记录暂时不可读');
  await page.unroute(route);
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await dialog
    .getByRole('navigation')
    .getByRole('button', { name: /打开业务页面/ })
    .click();
  const row = computerUseRecords(3, 1, Date.now());
  appendFileSync(
    path.join(root, 'codex', 'sessions', `rollout-${ids.modern}.jsonl`),
    row.records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
  const state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite'));
  state
    .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
    .run(Math.floor(Date.now() / 1000), Date.now(), ids.modern);
  state.close();
  await expect(
    dialog.getByRole('navigation').getByRole('button', { name: /浏览操作 4/ }),
  ).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '打开业务页面', exact: true })).toBeVisible();
  await dialog.getByTitle('关闭操作时间线').click();
  await enter(page, request, ids.legacy);
  await sessionActions(page).click();
  await expect(page.getByRole('button', { name: '操作回放', exact: true })).toHaveCount(0);
});

test('Computer Use loads older operations and keeps the full timeline available', async ({
  page,
  request,
}) => {
  await enter(page, request);
  await openSessionAction(page, '操作回放');
  const dialog = page.getByRole('dialog', { name: 'Computer Use 时间线', exact: true });
  await expect(dialog.locator('.computer-use-step')).toHaveCount(100);
  await dialog.getByRole('button', { name: '加载更早操作', exact: true }).click();
  await expect(dialog.locator('.computer-use-step')).toHaveCount(105);
  const first = dialog.getByRole('navigation').getByRole('button', { name: /打开业务页面/ });
  await first.scrollIntoViewIfNeeded();
  await first.click();
  await expect(dialog.getByRole('heading', { name: '打开业务页面', exact: true })).toBeVisible();
  await expect(dialog.getByText('1 / 105', { exact: true })).toBeVisible();
  await dialog.getByTitle('下一个操作').click();
  await expect(dialog.getByText('这一步未记录完整截图')).toBeVisible();
});
