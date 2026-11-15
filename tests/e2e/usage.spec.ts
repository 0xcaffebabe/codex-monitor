import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('usage totals, filters, heatmap and session metrics work on desktop and mobile', async ({
  page,
  request,
}) => {
  const status = await (await request.get('/api/auth/status')).json();
  const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
  const auth = await request.post('/api/auth/' + (status.configured ? 'login' : 'setup'), {
    data: status.configured
      ? credentials
      : {
          ...credentials,
          setupKey: readFileSync(
            path.join(
              process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa'),
              'data',
              'setup-key.txt',
            ),
            'utf8',
          ).trim(),
        },
  });
  const { token } = await auth.json();
  await page.addInitScript((token) => localStorage.setItem('codex-monitor.auth.v1', token), token);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部会话', exact: true })).toBeVisible();
  if (test.info().project.name === 'mobile') await page.getByTitle('打开菜单').click();
  await page.getByRole('button', { name: '用量统计', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用量统计', exact: false })).toBeVisible();
  // Session tests restore their temporary usage records; rescan before checking totals.
  await page.getByRole('button', { name: '立即同步', exact: true }).click();
  await expect(page.locator('.usage-log tbody tr')).toHaveCount(2);
  await expect(page.locator('.usage-stat').nth(1).locator('strong')).toHaveText('2');
  await expect(page.locator('.usage-log tbody')).toContainText('≈40.0 tok/s');
  await expect(page.locator('.usage-log tbody')).toContainText('≈5.0s');
  await expect(page.locator('.usage-stat').first()).toContainText('$0.08');
  await page.reload();
  await expect(page.getByRole('heading', { name: '用量统计', exact: false })).toBeVisible();
  await page.getByLabel('统计时间范围').selectOption('all');
  await expect(page.getByRole('img', { name: '最近 53 周每日 Token 用量热力图' })).toBeVisible();
  await expect(page.locator('.usage-log tbody tr')).toHaveCount(2);
  await page.screenshot({
    path: `test-results/${test.info().project.name}-usage-all.png`,
    fullPage: true,
  });
  await page.getByLabel('包含子代理', { exact: true }).uncheck();
  await expect(page.locator('.usage-log tbody tr')).toHaveCount(1);
  await expect(page.locator('.usage-stat').nth(1).locator('strong')).toHaveText('1');
  await page.getByLabel('统计时间范围').selectOption('7d');
  await expect(page.getByRole('img', { name: '按日统计的 Token 趋势' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `test-results/${test.info().project.name}-usage-week.png`,
    fullPage: true,
  });
  await page.locator('.usage-session-link').first().click();
  await expect(page.locator('.detail-heading')).toContainText('开发 codex-monitor');
  await page.getByRole('button', { name: '会话信息', exact: true }).click();
  await page.getByRole('button', { name: /会话用量/ }).click();
  await expect(page.getByRole('region', { name: '会话用量' })).toContainText('≈5.0s');
});
