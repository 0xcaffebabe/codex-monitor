import { test, expect, type APIRequestContext } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ids } from '../fixture.js';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
const webhook =
  'https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
async function login(request: APIRequestContext) {
  const status = await (await request.get('/api/auth/status')).json();
  const credentials = { username: 'owner', password: 'monitor-e2e-password!' };
  const response = await request.post(status.configured ? '/api/auth/login' : '/api/auth/setup', {
    data: status.configured
      ? credentials
      : {
          ...credentials,
          setupKey: readFileSync(path.join(root, 'data', 'setup-key.txt'), 'utf8').trim(),
        },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token as string;
}
function captured() {
  const file = path.join(root, 'webhook-messages.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

test('admins configure Lark, send a test, complete a chat and see background delivery on desktop and mobile', async ({
  page,
  request,
}, testInfo) => {
  const token = await login(request),
    headers = { Authorization: `Bearer ${token}` };
  await request.put('/api/notifications', {
    headers,
    data: { enabled: false, provider: 'lark', publicUrl: '' },
  });
  // Desktop and mobile share the server; old completion cards can cover the mobile composer.
  const pending = await (await request.get('/api/notifications/completions', { headers })).json();
  if (pending.notifications.length) {
    const dismissed = await request.post('/api/notifications/completions/dismiss', {
      headers,
      data: {
        generation: pending.generation,
        ids: pending.notifications.map((notice: { id: number }) => notice.id),
      },
    });
    expect(dismissed.ok()).toBeTruthy();
  }
  const before = captured().length;
  const questionId = randomUUID();
  try {
    await page.addInitScript(
      (token) => localStorage.setItem('codex-monitor.auth.v1', token),
      token,
    );
    await page.goto('/');
    if (testInfo.project.name === 'mobile') await page.getByTitle('打开菜单').click();
    await page.getByRole('button', { name: '设置与访问管理' }).click();
    const settings = page.getByRole('dialog');
    const section = settings.locator('.notification-settings');
    await expect(section.getByLabel('启用 Webhook 通知')).toBeEnabled();
    await section.getByLabel('飞书 / Lark Webhook', { exact: true }).fill(webhook);
    await section.getByLabel('启用 Webhook 通知').check();
    await section.getByLabel('成功轮次通知').selectOption('all');
    await section.getByLabel('监控台访问地址（可选）').fill('https://monitor.example.com/');
    await expect(section.getByRole('button', { name: '发送测试通知', exact: true })).toBeDisabled();
    await section.getByRole('button', { name: '保存通知配置' }).click();
    await expect(section.getByRole('button', { name: '发送测试通知', exact: true })).toBeEnabled();
    await expect(section.getByLabel('飞书 / Lark Webhook', { exact: true })).toHaveValue('');
    // Both projects also share the test-notification rate limit; retry a throttled UI request.
    await expect(async () => {
      const result = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/notifications/test') &&
          response.request().method() === 'POST',
      );
      await section.getByRole('button', { name: '发送测试通知', exact: true }).click();
      expect((await result).status()).toBe(200);
    }).toPass({ intervals: [1000], timeout: 10000 });
    await expect(section.getByText('已发送', { exact: true }).first()).toBeVisible();
    await expect.poll(() => captured().length).toBe(before + 1);
    expect(captured().at(-1).msg_type).toBe('interactive');
    expect(captured().at(-1).card.schema).toBe('2.0');
    expect(captured().at(-1).card.body.elements[0].tag).toBe('markdown');
    await section.screenshot({ path: testInfo.outputPath('notification-settings.png') });
    expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await settings.getByRole('button', { name: '关闭设置' }).click();
    await page.goto(`/?session=${ids.legacy}`);
    const prompt = `通知全链路测试-${Date.now()}`;
    await page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true }).fill(prompt);
    const receipt = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/workspaces/local/sessions/${ids.legacy}/messages`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    expect((await receipt).ok()).toBeTruthy();
    // Remove the viewer and its SSE connection; the outbox must continue running.
    await page.goto('about:blank');
    await expect.poll(() => captured().length).toBe(before + 2);
    expect(captured().at(-1).msg_type).toBe('interactive');
    expect(captured().at(-1).card.body.elements[0].content).toContain(prompt);
    expect(captured().at(-1).card.body.elements[0].content).toContain(`?session=${ids.legacy}`);
    const state = await (await request.get('/api/notifications', { headers })).json();
    expect(state.deliveries[0].status).toBe('sent');
    expect(JSON.stringify(state)).not.toContain(webhook);
    const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
    try {
      const turn = history
        .prepare(
          'SELECT turn_id FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1',
        )
        .get(ids.legacy)!;
      const ordinal = Number(
        history
          .prepare('SELECT MAX(rollout_ordinal)+1 AS n FROM thread_items WHERE thread_id=?')
          .get(ids.legacy)!.n,
      );
      history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(
        ids.legacy,
        turn.turn_id!,
        questionId,
        ordinal,
        Date.now(),
        JSON.stringify({
          type: 'agentMessage',
          id: questionId,
          phase: 'final_answer',
          delivery: 'async',
          text: '请回答这个测试问题',
          questions: [{ title: '输入提醒全链路测试', options: ['继续验证', '结束验证'] }],
        }),
        null,
        null,
      );
    } finally {
      history.close();
    }
    await expect.poll(() => captured().length).toBe(before + 3);
    expect(captured().at(-1).msg_type).toBe('interactive');
    expect(captured().at(-1).card.body.elements[0].content).toContain('需要你选择或回答');
    expect(captured().at(-1).card.body.elements[0].content).toContain('继续验证');
    await page.goto('/');
    if (testInfo.project.name === 'mobile') await page.getByTitle('打开菜单').click();
    await page.getByRole('button', { name: '设置与访问管理' }).click();
    await expect(page.getByLabel('启用 Webhook 通知')).toBeChecked();
    await expect(page.getByRole('button', { name: '发送测试通知', exact: true })).toBeEnabled();
    await expect(
      page
        .getByRole('dialog')
        .getByText(/需要回复 ·/)
        .first(),
    ).toBeVisible();
  } finally {
    await request.put('/api/notifications', {
      headers,
      data: { enabled: false, provider: 'lark', publicUrl: '' },
    });
    const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
    try {
      history.prepare('DELETE FROM thread_items WHERE item_id=?').run(questionId);
    } finally {
      history.close();
    }
  }
});
