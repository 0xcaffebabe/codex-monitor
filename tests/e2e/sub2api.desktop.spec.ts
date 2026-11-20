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
    expect(upstream.calls.some(({ path }) => path.endsWith('/quota'))).toBe(false);
    await usage.creditsButton('Codex Plus', '查询点数').click();
    await expect(plus.getByRole('status')).toHaveText('1250.50 点');
    await usage.creditsButton('Codex backup', '查询点数').click();
    await expect(backup.getByRole('status')).toHaveText('0 点');
    await usage.creditsButton('Codex Plus', '刷新点数').click();
    await expect(usage.creditsButton('Codex Plus', '刷新点数')).toBeEnabled();

    await usage.selectSubscriptionType('setup-token');
    await expect(usage.subscriptionAccount('Claude subscription')).toContainText('未知');

    await usage.showApiKeys();
    const runner = usage.apiKey('CI runner');
    await expect(runner.getByRole('cell').nth(1)).toHaveText('9');
    await expect(runner.getByRole('cell').nth(2)).toHaveText('1,000');
    await expect(runner.getByRole('cell').nth(3)).toHaveText('$0.1234');
    await usage.selectKeyPeriod('30');
    await usage.searchKey('#99');
    await expect(usage.apiKey('#99')).toContainText('$0.0000');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(usage.apiKey('#99')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await upstream.close();
  }
});
