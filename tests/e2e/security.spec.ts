import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ids } from '../fixture.js';

test.afterEach(async ({ page }) => {
  // Realtime detail refreshes can still be intercepted when the assertions finish.
  await page.unrouteAll({ behavior: 'wait' });
});

test('untrusted conversation Markdown cannot execute HTML, unsafe links or remote image requests', async ({
  page,
  request,
}) => {
  const status = await (await request.get('/api/auth/status')).json();
  const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
  const root =
    process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
  const login = await request.post(status.configured ? '/api/auth/login' : '/api/auth/setup', {
    data: status.configured
      ? credentials
      : {
          ...credentials,
          setupKey: readFileSync(path.join(root, 'data', 'setup-key.txt'), 'utf8').trim(),
        },
  });
  expect(login.ok()).toBeTruthy();
  const token = (await login.json()).token;
  await page.addInitScript((token) => {
    localStorage.setItem('codex-monitor.auth.v1', token);
    (window as unknown as { monitorXss: number }).monitorXss = 0;
  }, token);
  const remoteRequests: string[] = [];
  page.on('request', (event) => {
    const url = new URL(event.url());
    if (/^https?:$/.test(url.protocol) && url.hostname === 'attacker.invalid')
      remoteRequests.push(url.href);
  });
  await page.route(`**/api/workspaces/local/sessions/${ids.modern}*`, async (route) => {
    if (new URL(route.request().url()).pathname !== `/api/workspaces/local/sessions/${ids.modern}`)
      return route.continue();
    const response = await route.fetch(),
      body = await response.json();
    body.events.push({
      id: 'security-probe',
      kind: 'assistant',
      phase: 'final',
      timestamp: Date.now() + 1,
      text: [
        'SAFE_MESSAGE',
        '<script>window.monitorXss = 1</script>',
        '<img src="https://attacker.invalid/html-image" onerror="window.monitorXss = 2">',
        '<iframe src="https://attacker.invalid/frame"></iframe>',
        '[unsafe](javascript:alert%281%29)',
        '[data](data:text/html;base64,PHNjcmlwdD4=)',
        '![external](https://attacker.invalid/image)',
        '[safe](https://attacker.invalid/safe)',
      ].join('\n\n'),
    });
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/?session=${ids.modern}`);
  const message = page.locator('.timeline .markdown').filter({ hasText: 'SAFE_MESSAGE' });
  await expect(message).toBeVisible();
  await expect(message.locator('script,iframe,img,[onerror],[onload]')).toHaveCount(0);
  await expect(message.locator('a[href^="javascript:"],a[href^="data:"]')).toHaveCount(0);
  await expect(message.getByRole('link', { name: 'safe', exact: true })).toHaveAttribute(
    'rel',
    'noreferrer noopener',
  );
  expect(await page.evaluate(() => (window as unknown as { monitorXss: number }).monitorXss)).toBe(
    0,
  );
  expect(remoteRequests).toEqual([]);
});
