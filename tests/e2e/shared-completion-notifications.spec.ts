import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fixture, ids } from '../fixture.js';
import { createMonitorServer } from '../../server/server-app.js';
import type { CompletionNotificationSnapshot } from '../../src/types.js';

const endpoint = '/api/notifications/completions';
const remote = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test.setTimeout(45000);

async function setup(request: APIRequestContext) {
  const root =
    process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
  const configured = (await (await request.get('/api/auth/status')).json()).configured;
  const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
  const login = await request.post(configured ? '/api/auth/login' : '/api/auth/setup', {
    data: configured
      ? credentials
      : {
          ...credentials,
          setupKey: readFileSync(path.join(root, 'data', 'setup-key.txt'), 'utf8').trim(),
        },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const userId = (await (await request.get('/api/auth/me', { headers })).json()).user.id as string;
  expect(
    (
      await request.put('/api/notifications', {
        headers,
        data: { enabled: false, provider: 'lark', publicUrl: '' },
      })
    ).ok(),
  ).toBeTruthy();
  const pending = (await (
    await request.get(endpoint, { headers })
  ).json()) as CompletionNotificationSnapshot;
  if (pending.notifications.length)
    expect(
      (
        await request.post(endpoint + '/dismiss', {
          headers,
          data: {
            generation: pending.generation,
            ids: pending.notifications.map((item) => item.id),
          },
        })
      ).ok(),
    ).toBeTruthy();
  return { token: token as string, headers, userId };
}
async function open(page: Page, token: string) {
  await page.addInitScript((token) => localStorage.setItem('codex-monitor.auth.v1', token), token);
  const loaded = page.waitForResponse(
    (response) => response.url().endsWith(endpoint) && response.ok(),
  );
  await page.goto('/?workspace=local');
  await loaded;
}
async function peer(browser: Browser, page: Page, token: string) {
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const other = await context.newPage();
  await open(other, token);
  return { context, page: other };
}
async function closePeer(other: Awaited<ReturnType<typeof peer>>) {
  // End the peer's authenticated SSE stream before the browser context is torn down.
  await other.page.goto('about:blank');
  await other.context.close();
}
async function send(
  request: APIRequestContext,
  headers: Record<string, string>,
  workspace = 'local',
) {
  const response = await request.post(
    `/api/workspaces/${workspace}/sessions/${ids.modern}/messages`,
    {
      headers,
      data: { requestId: randomUUID(), prompt: `共享通知验收-${Date.now()}` },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
}
const notices = (page: Page) => page.getByRole('region', { name: '任务完成通知', exact: true });
const cards = (page: Page) => notices(page).locator('article');
const closeOne = (page: Page) =>
  notices(page)
    .getByRole('button', { name: /^关闭通知：/ })
    .first();

test('single close is shared across independent contexts; fresh pages ignore legacy inboxes and a new turn still notifies', async ({
  browser,
  page,
  request,
}, info) => {
  const auth = await setup(request);
  await open(page, auth.token);
  await send(request, auth.headers);
  await expect(cards(page)).toHaveCount(1);
  const stale = await (await request.get(endpoint, { headers: auth.headers })).json();
  const other = await peer(browser, page, auth.token); // First open must show the already pending notice.
  try {
    await expect(cards(other.page)).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('shared-single-before.png') });
    await closeOne(page).click();
    await expect(cards(page)).toHaveCount(0);
    await expect(cards(other.page)).toHaveCount(0, { timeout: 6500 });
    await page.reload();
    await expect(cards(page)).toHaveCount(0);
    await other.page.addInitScript(
      ({ userId, notifications }) =>
        sessionStorage.setItem(
          `codex-monitor.completion-notifications.v1.${userId}`,
          JSON.stringify({ cursor: 0, notifications }),
        ),
      { userId: auth.userId, notifications: stale.notifications },
    );
    await other.page.reload();
    await expect(cards(other.page)).toHaveCount(0);
    expect(
      (await (await request.get(endpoint, { headers: auth.headers })).json()).notifications,
    ).toHaveLength(0);
    await send(request, auth.headers);
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(other.page)).toHaveCount(1);
    // Ordinary session navigation keeps the notice until a close/notification action is confirmed.
    await page.goto(`/?workspace=local&session=${ids.modern}`);
    await expect(cards(page)).toHaveCount(1);
    await closeOne(other.page).click();
    await expect(cards(page)).toHaveCount(0, { timeout: 6500 });
    await other.page.screenshot({ path: info.outputPath('shared-single-after.png') });
  } finally {
    await closePeer(other);
  }
});

test('close all deletes the observed set on both contexts while preserving a concurrent new completion', async ({
  browser,
  page,
  request,
}, info) => {
  const auth = await setup(request);
  await open(page, auth.token);
  const other = await peer(browser, page, auth.token);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let body!: { generation: string; ids: number[] };
  try {
    await send(request, auth.headers);
    await send(request, auth.headers);
    await expect(cards(page)).toHaveCount(2);
    await expect(cards(other.page)).toHaveCount(2);
    await page.route('**/api/notifications/completions/dismiss', async (route) => {
      body = route.request().postDataJSON();
      entered();
      await gate;
      await route.continue();
    });
    await notices(page).getByRole('button', { name: '全部关闭', exact: true }).click();
    await started;
    expect(body.ids).toHaveLength(2);
    await send(request, auth.headers);
    await expect(cards(other.page)).toHaveCount(3);
    release();
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(other.page)).toHaveCount(1, { timeout: 6500 });
    const surviving = await (await request.get(endpoint, { headers: auth.headers })).json();
    expect(body.ids).not.toContain(surviving.notifications[0].id);
    expect(
      (await request.post(endpoint + '/dismiss', { headers: auth.headers, data: body })).ok(),
    ).toBeTruthy();
    expect(
      (await (await request.get(endpoint, { headers: auth.headers })).json()).notifications,
    ).toHaveLength(1);
    await page.reload();
    await expect(cards(page)).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('shared-close-all-new-turn-survives.png') });
    await closeOne(page).click();
    await expect(cards(other.page)).toHaveCount(0, { timeout: 6500 });
  } finally {
    release();
    await closePeer(other);
  }
});

test('failed single-close and navigation preserve notices; successful navigation waits for deletion and clears the peer', async ({
  browser,
  page,
  request,
}, info) => {
  const auth = await setup(request);
  await open(page, auth.token);
  const other = await peer(browser, page, auth.token);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let attempts = 0;
  try {
    await send(request, auth.headers, remote);
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(other.page)).toHaveCount(1);
    await page.route('**/api/notifications/completions/dismiss', async (route) => {
      if (++attempts <= 2) return route.fulfill({ status: 503, json: { error: '模拟关闭失败' } });
      entered();
      await gate;
      await route.continue();
    });
    await closeOne(page).click();
    await expect(notices(page).getByRole('alert')).toContainText('关闭通知失败');
    await expect(cards(page)).toHaveCount(1);
    // Another device may finish the failed action; a later turn must not inherit the old error.
    await closeOne(other.page).click();
    await expect(cards(page)).toHaveCount(0, { timeout: 6500 });
    await send(request, auth.headers, remote);
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(other.page)).toHaveCount(1);
    await expect(notices(page).getByRole('alert')).toHaveCount(0);
    const link = notices(page).getByRole('link', {
      name: '查看已完成会话：第二台电脑的独立会话',
      exact: true,
    });
    await link.click();
    await expect.poll(() => attempts).toBe(2);
    await expect(notices(page).getByRole('alert')).toContainText('关闭通知失败');
    await expect(page).toHaveURL(/workspace=local$/);
    await expect(cards(other.page)).toHaveCount(1);
    expect(
      (await (await request.get(endpoint, { headers: auth.headers })).json()).notifications,
    ).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('shared-close-failure.png') });
    await link.click();
    await started;
    await expect(closeOne(page)).toBeDisabled();
    await expect(page).toHaveURL(/workspace=local$/);
    release();
    await expect(page).toHaveURL(new RegExp(`workspace=${remote}&session=${ids.modern}`));
    await expect(page.locator('.detail-header')).toContainText('第二台电脑的独立会话');
    await expect(cards(other.page)).toHaveCount(0, { timeout: 6500 });
  } finally {
    release();
    await closePeer(other);
  }
});

test('a late snapshot from before a confirmed deletion cannot restore a closed card', async ({
  page,
  request,
}) => {
  const auth = await setup(request);
  await open(page, auth.token);
  await send(request, auth.headers);
  await expect(cards(page)).toHaveCount(1);
  const stale = await (await request.get(endpoint, { headers: auth.headers })).json();
  let armed = false,
    staleReplies = 0;
  await page.route('**/api/notifications/completions', async (route) => {
    if (armed && staleReplies === 0) {
      staleReplies++;
      await route.fulfill({ json: stale });
    } else await route.continue();
  });
  await page.route('**/api/notifications/completions/dismiss', async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    armed = true;
    await route.fulfill({ response });
  });
  await closeOne(page).click();
  await expect(cards(page)).toHaveCount(0);
  await expect.poll(() => staleReplies).toBe(1);
  await page.waitForResponse((response) => response.url().endsWith(endpoint) && response.ok());
  await expect(cards(page)).toHaveCount(0);
  expect(
    (await (await request.get(endpoint, { headers: auth.headers })).json()).notifications,
  ).toHaveLength(0);
});

test('an old page cannot dismiss new Server notifications after restart and safely resynchronizes', async ({
  browser,
}) => {
  const f = fixture();
  const config = { ...f.config, pollMs: 60000 };
  const publicDir = process.env.MONITOR_TEST_PUBLIC_DIR || path.resolve('dist/public');
  let service = createMonitorServer(config, { publicDir });
  let server = createServer(service.app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const baseURL = `http://127.0.0.1:${port}`;
  const user = await service.auth.setup('owner', 'shared-restart-test-password');
  const token = service.auth.issue(user, 'browser restart test').token;
  const context = await browser.newContext({ baseURL });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stop = async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const notify = (title: string) =>
    service.notifications.receive(
      { id: 'local', name: '测试工作空间' },
      {
        revision: service.notifications.policy().revision,
        events: [],
        monitorError: '',
        completions: [
          {
            kind: 'session.completed',
            sessionId: ids.modern,
            title,
            project: 'test',
            turnId: randomUUID(),
            occurredAt: Date.now(),
            summary: '',
          },
        ],
      },
    );
  try {
    const page = await context.newPage();
    await open(page, token);
    notify('重启前的通知');
    await expect(cards(page)).toHaveCount(1);
    await page.route('**/api/notifications/completions/dismiss', async (route) => {
      entered();
      await gate;
      await route.continue();
    });
    await closeOne(page).click();
    await started;
    await stop();
    service = createMonitorServer(config, { publicDir });
    server = createServer(service.app);
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    expect(service.notifications.completions.snapshot().notifications).toHaveLength(0);
    notify('重启后的新通知');
    const rejected = page.waitForResponse((response) =>
      response.url().endsWith(endpoint + '/dismiss'),
    );
    release();
    expect((await rejected).status()).toBe(409);
    await expect(notices(page)).toContainText('重启后的新通知');
    await expect(notices(page)).not.toContainText('重启前的通知');
    expect(service.notifications.completions.snapshot().notifications).toHaveLength(1);
    await closeOne(page).click();
    await expect(cards(page)).toHaveCount(0);
    expect(service.notifications.completions.snapshot().notifications).toHaveLength(0);
  } finally {
    release();
    await context.close();
    await stop();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
