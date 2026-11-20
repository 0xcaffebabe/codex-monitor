import { sub2ApiAdminKey, sub2ApiFixture } from '../sub2api-fixture.js';
import { expect, test } from './monitor.js';

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
    await expect(plus).toContainText('18.5%');
    await expect(backup).toContainText('额度暂不可用');
    await expect(plus.getByRole('status')).toHaveText('1250.50 点');
    await expect(backup.getByRole('status')).toHaveText('0 点');
    await expect(usage.subscriptions.getByRole('button')).toHaveCount(0);

    upstream.behavior.rejectCredits = true;
    await usage.refreshSub2Api();
    await expect(plus.getByRole('alert')).toHaveText(
      'Sub2API 拒绝查询，请检查管理员 Key 的读取权限',
    );
    await expect(backup.getByRole('status')).toHaveText('0 点');

    upstream.behavior.rejectCredits = false;
    await page.setViewportSize({ width: 390, height: 844 });
    await usage.refreshSub2Api();
    await expect(plus.getByRole('status')).toHaveText('1250.50 点');
    await expect(backup.getByRole('status')).toHaveText('0 点');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await usage.selectSubscriptionType('setup-token');
    const claude = usage.subscriptionAccount('Claude subscription');
    await expect(claude).toContainText('未知');
    await expect(claude.getByRole('status')).toHaveCount(0);

    await usage.showApiKeys();
    const runner = usage.apiKey('CI runner');
    await expect(runner.getByRole('cell').nth(1)).toHaveText('9');
    await expect(runner.getByRole('cell').nth(2)).toHaveText('1,000');
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
