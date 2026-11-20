import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMonitorServer } from '../server/server-app.js';
import { sub2ApiAdminKey, sub2ApiFixture, upstreamCredential } from './sub2api-fixture.js';

test('Sub2API uses saved server credentials and exposes only admin usage fields', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-sub2api-'));
  const upstream = await sub2ApiFixture();
  const monitor = createMonitorServer({
    mode: 'server',
    dataDir: root,
    codexHome: root,
    host: '127.0.0.1',
    port: 0,
    origins: [],
    sessionDays: 90,
    pollMs: 60000,
    secure: false,
  });
  const server = createServer(monitor.app).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await monitor.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = await monitor.auth.setup('owner', 'sub2api-test-password');
  const headers = {
    Authorization: `Bearer ${monitor.auth.issue(owner, 'test').token}`,
    'Content-Type': 'application/json',
  };
  await fetch(`${base}/api/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'viewer', password: 'sub2api-viewer-password' }),
  });
  const viewer = await monitor.auth.login('viewer', 'sub2api-viewer-password');
  assert.ok(viewer);
  const viewerHeaders = { Authorization: `Bearer ${monitor.auth.issue(viewer, 'test').token}` };
  const request = (route: string, options?: RequestInit) =>
    fetch(`${base}/api/sub2api/${route}`, { headers, ...options });
  const save = (baseUrl: string, adminKey?: string) =>
    request('settings', { method: 'PUT', body: JSON.stringify({ baseUrl, adminKey }) });
  const range = 'startDate=2026-11-18&endDate=2026-11-20&timezone=Asia%2FHong_Kong';

  assert.equal((await request('settings', { headers: {} })).status, 401);
  for (const route of ['settings', 'accounts', 'account-credits?accountId=41', `keys?${range}`]) {
    assert.equal((await request(route, { headers: viewerHeaders })).status, 403);
  }
  assert.equal((await request('accounts')).status, 409);
  assert.equal((await save('file:///etc/passwd', sub2ApiAdminKey)).status, 400);
  const config = await save(`${upstream.baseUrl}/api/v1/`, sub2ApiAdminKey);
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), { configured: true, baseUrl: upstream.baseUrl });
  assert.deepEqual(await (await request('settings')).json(), {
    configured: true,
    baseUrl: upstream.baseUrl,
  });
  assert.equal((await save(upstream.baseUrl)).status, 200);
  assert.equal((await save(`${upstream.baseUrl}/different`)).status, 400);
  assert.equal((await request('accounts?type=apikey')).status, 400);
  assert.equal(upstream.calls.length, 0);

  const accounts = await request('accounts');
  assert.equal(accounts.status, 200);
  const accountData = await accounts.text();
  assert.ok(!accountData.includes(upstreamCredential));
  const { items: accountItems } = JSON.parse(accountData);
  assert.equal(accountItems[0].quotas[0].usedPercent, 18.5);
  assert.equal(accountItems[0].quotas[1].usedPercent, 0);
  assert.equal(accountItems[1].quotaUnavailable, true);
  assert.deepEqual(
    upstream.calls.slice(0, 2).map(({ method, path }) => [method, path]),
    [
      ['GET', '/accounts'],
      ['POST', '/accounts/usage/batch'],
    ],
  );
  assert.equal(
    (await (await request('accounts?type=setup-token')).json()).items[0].quotas[0].usedPercent,
    null,
  );
  upstream.behavior.legacyBatch = true;
  assert.equal(
    (await (await request('accounts?search=Plus')).json()).items[0].quotas[0].usedPercent,
    18.5,
  );

  const credits = (accountId: number) => request(`account-credits?accountId=${accountId}`);
  assert.equal((await credits(0)).status, 400);
  for (const [accountId, expected] of [
    [41, { balance: '1250.50', hasCredits: true, unlimited: false }],
    [42, { balance: '0', hasCredits: false, unlimited: false }],
    [44, { balance: null, hasCredits: true, unlimited: true }],
    [45, null],
  ] as const) {
    const result = await credits(accountId);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), expected);
    assert.equal(upstream.calls.at(-1)?.method, 'GET');
  }
  upstream.behavior.rejectCredits = true;
  const deniedCredits = await credits(41);
  assert.equal(deniedCredits.status, 502);
  assert.deepEqual(await deniedCredits.json(), {
    error: 'Sub2API 拒绝查询，请检查管理员 Key 的读取权限',
  });
  assert.equal((await request('accounts')).status, 200);

  const keys = await request(`keys?${range}`);
  assert.equal(keys.status, 200);
  const keyData = await keys.text();
  assert.ok(!keyData.includes(upstreamCredential));
  assert.deepEqual(JSON.parse(keyData).items[0], {
    id: 7,
    name: 'CI runner',
    requests: 9,
    tokens: 1000,
    actualCost: 0.1234,
  });
  const trend = upstream.calls.find(({ path }) => path === '/dashboard/api-keys-trend')!;
  assert.equal(trend.query.get('start_date'), '2026-11-18');
  assert.equal(trend.query.get('end_date'), '2026-11-20');
  assert.equal(trend.query.get('timezone'), 'Asia/Hong_Kong');
  const inactive = await (await request(`keys?${range}&search=%2399`)).json();
  assert.deepEqual(inactive.items, [{ id: 99, name: '', requests: 0, tokens: 0, actualCost: 0 }]);
  upstream.behavior.rejectCost = true;
  const partial = await (await request(`keys?${range}`)).json();
  assert.equal(partial.items[0].tokens, 1000);
  assert.equal(partial.items[0].actualCost, null);
  assert.match(partial.warning, /读取权限/);

  upstream.behavior.redirect = true;
  assert.equal((await request('accounts')).status, 502);
  assert.ok(!upstream.calls.some(({ path }) => path === '/unexpected-redirect'));
  await save(upstream.baseUrl, 'wrong-key');
  const unauthorized = await request('accounts');
  assert.equal(unauthorized.status, 502);
  assert.match(await unauthorized.text(), /管理员 Key 无效/);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers })).status, 200);
  assert.deepEqual(await (await request('settings', { method: 'DELETE' })).json(), {
    configured: false,
    baseUrl: '',
  });
});
