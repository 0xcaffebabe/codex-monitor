import { sub2ApiAdminKey, sub2ApiFixture } from '../sub2api-fixture.js';
import { expect, test } from './monitor.js';


test('the overview usage dialog reuses Sub2API configuration and reports', async ({
  signedIn: { browserPage: page },
}) => {
  const upstream = await sub2ApiFixture();
  try {
    await page.goto('/overview?workspace=local&view=all');
    const overviewUrl = page.url();
    const overview = page.getByRole('dialog', { name: '任务全览' });
    await overview.getByRole('button', { name: '用量统计', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '用量统计', exact: true });
    const relay = dialog.getByRole('region', { name: 'Sub2API 用量', exact: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole('button', { name: 'Sub2API', exact: true }).click();
    await expect(relay.getByRole('heading', { name: 'Sub2API 用量' })).toBeInViewport();
    await relay.getByRole('button', { name: '配置 Sub2API', exact: true }).click();
    await relay.getByLabel('Sub2API 站点地址').fill(upstream.baseUrl);
    await relay.getByLabel('管理员 Key', { exact: true }).fill(sub2ApiAdminKey);
    await relay.getByRole('button', { name: '保存 Sub2API 配置' }).click();

    const subscription = relay.getByRole('row').filter({ hasText: 'Codex Plus' });
    await expect(subscription.getByText('1250.50 点')).toBeVisible();
    await relay.getByRole('button', { name: 'API Key', exact: true }).click();
    await expect(relay.getByRole('row').filter({ hasText: 'CI runner' })).toContainText('1K');
    await relay.getByRole('button', { name: '调用记录', exact: true }).click();
    const filters = relay.getByRole('form', { name: '筛选 Sub2API 调用记录' });
    await filters.getByLabel('开始日期').fill('2026-11-20');
    await filters.getByLabel('结束日期').fill('2026-11-20');
    await filters.getByRole('button', { name: '查询记录', exact: true }).click();
    await expect(relay.getByRole('table', { name: 'Sub2API 调用记录' })).toContainText('CI runner');
    await expect(dialog.getByLabel('统计工作空间')).toBeInViewport();
    await expect(page).toHaveURL(overviewUrl);
  } finally {
    await upstream.close();
  }
});

test('configure Sub2API and query subscription accounts and API keys', async ({
  signedIn: { usage },
  page,
}) => {
  const upstream = await sub2ApiFixture();
  try {
    await usage.open();
    await usage.configureSub2Api(`${upstream.baseUrl}/v1`, sub2ApiAdminKey);
    await expect(usage.relayAdminKey).toHaveValue('');
    await expect(usage.relayAddress).toHaveValue(upstream.baseUrl);
    await usage.closeSettings();

    const plus = usage.subscriptionAccount('Codex Plus');
    const backup = usage.subscriptionAccount('Codex backup');
    const claudeOAuth = usage.subscriptionAccount('Claude OAuth');
    const plusBalance = plus.getByRole('status', { name: '点数余额' });
    const backupBalance = backup.getByRole('status', { name: '点数余额' });
    const plusResets = plus.getByRole('status', { name: '重置卡' });
    const claudeResets = claudeOAuth.getByRole('status', { name: '重置卡' });
    await expect(plus).toContainText('18.5%');
    await expect(plus.getByTitle('9,354,344 Token')).toHaveText('178 次 · 9.35M Token');
    await expect(plus.getByTitle('2,530,953,480 Token')).toHaveText('19,548 次 · 2.53B Token');
    await expect(backup).toContainText('额度暂不可用');
    await expect(plusBalance).toHaveText('1250.50 点');
    await expect(backupBalance).toHaveText('0 点');
    await expect(plusResets).toHaveText('重置卡可用 2 次');
    await expect(backup.getByRole('status', { name: '重置卡' })).toHaveText('重置卡可用 0 次');
    await expect(claudeResets).toHaveText('重置卡剩余 3 次 · 当前可用 1 次');
    await expect(usage.subscriptions.getByRole('button')).toHaveCount(0);

    upstream.behavior.rejectCredits = true;
    upstream.behavior.legacyClaudeReset = true;
    await usage.refreshSub2Api();
    await expect(plus.getByRole('alert')).toHaveText(
      'Sub2API 拒绝查询，请检查管理员 Key 的读取权限',
    );
    await expect(backupBalance).toHaveText('0 点');
    await expect(claudeOAuth.getByRole('alert')).toHaveText(
      'Sub2API 接口不可用，请检查站点地址和版本',
    );

    upstream.behavior.rejectCredits = false;
    upstream.behavior.legacyClaudeReset = false;
    await page.setViewportSize({ width: 390, height: 844 });
    await usage.refreshSub2Api();
    await expect(plusBalance).toHaveText('1250.50 点');
    await expect(backupBalance).toHaveText('0 点');
    await expect(plusResets).toHaveText('重置卡可用 2 次');
    await expect(claudeResets).toHaveText('重置卡剩余 3 次 · 当前可用 1 次');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await usage.selectSubscriptionType('setup-token');
    const claude = usage.subscriptionAccount('Claude subscription');
    await expect(claude).toContainText('未知');
    await expect(claude.getByRole('status')).toHaveCount(0);
    expect(upstream.calls.some(({ path }) => path === '/accounts/43/claude/reset-credits')).toBe(
      false,
    );

    await usage.showApiKeys();
    const runner = usage.apiKey('CI runner');
    await expect(runner.getByRole('cell').nth(1)).toHaveText('9');
    await expect(runner.getByRole('cell').nth(2)).toHaveText('1K');
    await expect(runner.getByRole('cell').nth(2)).toHaveAttribute('title', '1,000');
    await expect(runner.getByRole('cell').nth(3)).toHaveText('$0.1234');
    await usage.selectKeyPeriod('30');
    await usage.searchKey('#99');
    await expect(usage.apiKey('#99')).toContainText('$0.0000');

    await expect(usage.apiKey('#99')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await upstream.close();
  }
});

test('query Sub2API call records by date, API Key and model', async ({
  signedIn: { usage },
  page,
}) => {
  const upstream = await sub2ApiFixture();
  try {
    await usage.open();
    await usage.configureSub2Api(upstream.baseUrl, sub2ApiAdminKey);
    await usage.closeSettings();

    await usage.showCallRecords();
    await expect.poll(() => upstream.calls.some(({ path }) => path === '/usage')).toBe(true);
    const startDate = usage.callFilters.getByLabel('开始日期');
    const endDate = usage.callFilters.getByLabel('结束日期');
    const today = await startDate.inputValue();
    await startDate.fill('2026-11-20');
    await endDate.fill('2026-11-19');
    await usage.queryCallRecords();
    await expect(usage.callFilters.getByRole('alert')).toContainText('结束日期不能早于开始日期');
    await endDate.fill('2026-11-20');
    await usage.queryCallRecords();

    const first = usage.callRecords.getByRole('row').nth(1);
    await expect(first).toContainText('CI runner #7');
    await expect(first).toContainText('gpt-6.1-sol');
    await expect(first).toContainText('缓存读取 82,400');
    await expect(first).toContainText('$0.034981');
    await expect(first).toContainText('首字 2.48s');
    await expect(first).toContainText('192.0.2.21');

    await usage.sub2api.getByRole('button', { name: 'Sub2API 下一页', exact: true }).click();
    await expect(first).toContainText('Editor #8');
    await expect(first).toContainText('$0.000000');

    await page.setViewportSize({ width: 390, height: 844 });
    await usage.callFilters
      .getByRole('searchbox', { name: 'API Key', exact: true })
      .fill('CI runner');
    const model = usage.callFilters.getByRole('searchbox', { name: '模型', exact: true });
    await model.fill('gpt-6.2-sol');
    await usage.callFilters.getByText('更多筛选', { exact: true }).click();
    await usage.callFilters.getByLabel('请求类型').selectOption('stream');
    await usage.queryCallRecords();
    await expect(usage.callRecords.getByRole('row')).toHaveCount(11);
    await expect(usage.callRecords.getByText('Editor #8')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await usage.callRecords.evaluate((el) => {
        const container = el.parentElement!;
        return container.scrollWidth > container.clientWidth;
      }),
    ).toBe(true);

    await model.fill('missing-model');
    await usage.queryCallRecords();
    await expect(usage.sub2api.getByText('所选条件下暂无调用记录')).toBeVisible();
    await usage.callFilters.getByRole('button', { name: '重置调用记录筛选' }).click();
    await expect(startDate).toHaveValue(today);
    await expect(model).toHaveValue('');
    await expect(usage.callFilters.getByLabel('请求类型')).toHaveValue('');
  } finally {
    await upstream.close();
  }
});
