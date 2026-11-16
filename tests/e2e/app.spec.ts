import { test, expect, type Page, type APIRequestContext, type Locator, type Request } from '@playwright/test';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { ids } from '../fixture.js';
const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa'),
  username = 'owner',
  password = 'monitor-e2e-password!';
let cachedToken = '';
let restoreControlFixture: (() => void) | undefined;
const pendingMutations = new Set<Request>();
test.beforeEach(async ({ page }, info) => {
  if (info.title.startsWith('web controls'))
    await page.route('**/api/notifications/completions', (route) =>
      route.fulfill({ json: { generation: 'controls-test', revision: 0, notifications: [] } }),
    );
  pendingMutations.clear();
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/api/workspaces/')) pendingMutations.add(request); });
  page.on('requestfinished', (request) => pendingMutations.delete(request));
  page.on('requestfailed', (request) => pendingMutations.delete(request));
  if (
    !info.title.startsWith('web controls') &&
    !info.title.startsWith('a lost send') &&
    !info.title.startsWith('goal strip') &&
    !info.title.startsWith('common commands')
  )
    return;
  const hist = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  const state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite'));
  const items = hist.prepare('SELECT * FROM thread_items WHERE thread_id=?').all(ids.modern);
  const turns = hist.prepare('SELECT * FROM thread_turns WHERE thread_id=?').all(ids.modern);
  const threads = state
    .prepare('SELECT id FROM threads')
    .all()
    .map((row) => row.id);
  const previousModel = state
    .prepare('SELECT model FROM threads WHERE id=?')
    .get(ids.modern)?.model;
  restoreControlFixture = () => {
    if (previousModel !== undefined)
      state.prepare('UPDATE threads SET model=? WHERE id=?').run(previousModel, ids.modern);
    hist.prepare('DELETE FROM thread_items WHERE thread_id=?').run(ids.modern);
    hist.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(ids.modern);
    for (const row of items)
      hist.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(row));
    for (const row of turns)
      hist.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)').run(...Object.values(row));
    const created = state
      .prepare('SELECT id FROM threads')
      .all()
      .filter((row) => !threads.includes(row.id));
    for (const row of created) {
      hist.prepare('DELETE FROM thread_items WHERE thread_id=?').run(row.id!);
      hist.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(row.id!);
      state.prepare('DELETE FROM threads WHERE id=?').run(row.id!);
    }
    hist.close();
    state.close();
  };
});
test.afterEach(async () => {
  // The WebSocket hop can still be dispatching after a request-observation assertion.
  // Finish those operations before restoring fixture rows for the next test.
  await expect.poll(() => pendingMutations.size).toBe(0);
  restoreControlFixture?.();
  restoreControlFixture = undefined;
});
async function ownerToken(request: APIRequestContext) {
  if (
    cachedToken &&
    (
      await request.get('/api/auth/me', { headers: { Authorization: 'Bearer ' + cachedToken } })
    ).ok()
  )
    return cachedToken;
  const status = await (await request.get('/api/auth/status')).json();
  if (!status.configured) {
    const response = await request.post('/api/auth/setup', {
      data: {
        username,
        password,
        setupKey: readFileSync(path.join(root, 'data', 'setup-key.txt'), 'utf8').trim(),
      },
    });
    expect(response.status()).toBe(201);
    cachedToken = (await response.json()).token;
    return cachedToken;
  }
  const response = await request.post('/api/auth/login', { data: { username, password } });
  expect(response.ok()).toBeTruthy();
  cachedToken = (await response.json()).token;
  return cachedToken;
}
async function enter(page: Page, request: APIRequestContext) {
  const token = await ownerToken(request);
  const headers = { Authorization: 'Bearer ' + token };
  // Completions from another workspace must not cover the mobile list in the next test.
  const pending = await (await request.get('/api/notifications/completions', { headers })).json();
  if (pending.notifications.length)
    expect(
      (
        await request.post('/api/notifications/completions/dismiss', {
          headers,
          data: {
            generation: pending.generation,
            ids: pending.notifications.map((item: { id: number }) => item.id),
          },
        })
      ).ok(),
    ).toBeTruthy();
  await page.addInitScript((token) => localStorage.setItem('codex-monitor.auth.v1', token), token);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部会话', exact: true })).toBeVisible();
}

async function transferFiles(
  input: Locator,
  files: { name: string; type?: string; content?: string; base64?: string; size?: number }[],
  {
    itemsOnly = false,
    eventType = 'paste',
  }: {
    itemsOnly?: boolean;
    eventType?: 'paste' | 'dragenter' | 'dragover' | 'dragleave' | 'drop';
  } = {},
) {
  return input.evaluate(
    (element, { files, itemsOnly, eventType }) => {
      const clipboardData = new DataTransfer();
      for (const file of files) {
        const content = file.size
          ? new ArrayBuffer(file.size)
          : file.base64
            ? Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))
            : (file.content ?? '附件正文');
        clipboardData.items.add(
          new File([content], file.name, { type: file.type ?? 'text/plain' }),
        );
      }
      clipboardData.setData('text/plain', '复制的文件名，不应插入消息');
      if (itemsOnly) Object.defineProperty(clipboardData, 'files', { value: [] });
      const event =
        eventType === 'paste'
          ? new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
          : new DragEvent(eventType, {
              dataTransfer: clipboardData,
              bubbles: true,
              cancelable: true,
            });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { files, itemsOnly, eventType },
  );
}

async function copyImage(page: Page) {
  await page.evaluate(async () => {
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPwmJZHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEvsMEwbybntAAAAAElFTkSuQmCC',
      ),
      (char) => char.charCodeAt(0),
    );
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
    ]);
  });
}

test('web controls preserve delegated launch input in conversation, directory and export', async ({
  page,
  request,
}) => {
  const hist = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  const state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite'));
  const previous = state
    .prepare('SELECT updated_at,updated_at_ms FROM threads WHERE id=?')
    .get(ids.modern)!;
  const prompt = 'codex-monitor 这个项目都是读取 codex 的数据库吗，自己有没有数据库';
  try {
    hist.prepare('UPDATE thread_items SET item_json=? WHERE thread_id=? AND item_id=?').run(
      JSON.stringify({
        type: 'functionCallOutput',
        id: 'user-1',
        namespace: 'codex_app',
        name: 'create_thread',
        output: `<codex_delegation>\n  <source_thread_id>${ids.legacy}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`,
      }),
      ids.modern,
      'user-1',
    );
    state
      .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
      .run(Math.floor(Date.now() / 1000), Date.now(), ids.modern);
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const question = page.locator('.timeline .user-message').filter({ hasText: prompt });
    await expect(question).toHaveCount(1);
    await expect(question).toBeVisible();
    await expect(page.locator('.timeline')).not.toContainText('<codex_delegation>');
    if (!(await page.locator('.outline').isVisible()))
      await page.getByTitle('对话目录', { exact: true }).click();
    await expect(page.locator('.outline-question')).toHaveText(prompt);
    await expect(page.locator('.outline-entry').first()).toContainText('你 ·');
    await page.screenshot({
      path: test.info().outputPath('initial-message-directory.png'),
      fullPage: true,
    });
    await page.getByTitle('关闭目录').click();
    await question.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath('initial-message-conversation.png'),
      fullPage: true,
    });
    const downloading = page.waitForEvent('download');
    await page.getByTitle('导出 Markdown').click();
    const exported = readFileSync((await (await downloading).path())!, 'utf8');
    expect(exported).toContain(prompt);
    expect(exported).not.toContain('<codex_delegation>');
  } finally {
    state
      .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
      .run(previous.updated_at!, previous.updated_at_ms!, ids.modern);
    hist.close();
    state.close();
  }
});

test('web controls upload pictures and files, preserve attachment drafts and send server paths', async ({
  page,
  request,
}) => {
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
  const prompt = '请查看上传的资料 ' + test.info().project.name;
  const input = page.getByLabel('发送给 Codex 的消息');
  await input.fill(prompt);
  const image = {
    name: '截图.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPwmJZHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEvsMEwbybntAAAAAElFTkSuQmCC',
      'base64',
    ),
  };
  const uploadedDocument = {
    name: '需求说明.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('附件正文 中文\nsecond line'),
  };
  await page.getByLabel('上传图片或文件', { exact: true }).setInputFiles([image, uploadedDocument]);
  const attachments = page.getByRole('list', { name: '待发送附件' });
  await expect(attachments.getByRole('listitem')).toHaveCount(2);
  await expect(attachments.getByRole('img', { name: '截图.png' })).toBeVisible();
  await page.getByRole('button', { name: '移除附件 需求说明.txt' }).click();
  await expect(attachments.getByRole('listitem')).toHaveCount(1);
  await page.getByLabel('上传图片或文件', { exact: true }).setInputFiles(uploadedDocument);
  await expect(attachments.getByRole('listitem')).toHaveCount(2);
  await page.reload();
  await expect(input).toHaveValue(prompt);
  await expect(attachments.getByRole('listitem')).toHaveCount(2);
  await expect(attachments.getByRole('img', { name: '截图.png' })).toBeVisible();
  await expect(page.locator('.message-composer button[type="submit"]')).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({
    path: test.info().outputPath('attachment-draft.png'),
    fullPage: true,
  });
  await page.route(
    '**/api/workspaces/local/sessions/*/messages',
    (route) => route.fulfill({ status: 400, json: { error: '附件发送测试失败' } }),
    { times: 1 },
  );
  await page.locator('.message-composer button[type="submit"]').click();
  await expect(page.getByRole('alert')).toContainText('附件发送测试失败');
  await expect(input).toHaveValue(prompt);
  await expect(attachments.getByRole('listitem')).toHaveCount(2);
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/messages'),
  );
  await page.locator('.message-composer button[type="submit"]').click();
  const data = (await sent).postDataJSON();
  expect(data.prompt).toBe(prompt);
  expect(data.attachments).toHaveLength(2);
  await expect(input).toHaveValue('');
  await expect(attachments).toHaveCount(0);
  const message = page.locator('.timeline .user-message').last();
  await expect(message).toContainText(prompt);
  await expect(message).toContainText('附件（已上传到本机临时目录）：');
  await expect(message).toContainText('截图.png');
  await expect(message).toContainText('需求说明.txt');

  await page.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByLabel('新会话项目').selectOption({ label: 'work · D:/work' });
  await page.getByLabel('上传图片或文件', { exact: true }).setInputFiles(uploadedDocument);
  await expect(attachments.getByRole('listitem')).toHaveCount(1);
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: '创建并发送' })).toBeEnabled();
  await page.getByRole('button', { name: '创建并发送' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.timeline .user-message').last()).toContainText(
    '附件（已上传到本机临时目录）：',
  );
  await expect(page.locator('.timeline .user-message').last()).toContainText('需求说明.txt');
});

test('web controls paste clipboard images and files into continued and new conversations', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
  const input = page.getByLabel('发送给 Codex 的消息');
  const attachments = page.getByRole('list', { name: '待发送附件' });
  await input.fill('请查看：');
  await page.evaluate(() => navigator.clipboard.writeText('普通文字\n第二行'));
  await input.press('ControlOrMeta+V');
  await expect(input).toHaveValue('请查看：普通文字\n第二行');
  await expect(attachments).toHaveCount(0);

  await copyImage(page);
  await input.press('ControlOrMeta+V');
  await expect(attachments.getByRole('listitem')).toHaveCount(1);
  await expect(attachments.locator('img')).toBeVisible();
  expect(
    await transferFiles(input, [
      { name: '粘贴说明.txt', content: '从剪贴板粘贴的正文\n第二行' },
      { name: '粘贴资料.pdf', type: 'application/pdf', content: '%PDF-1.7\npasted document' },
    ]),
  ).toBe(true);
  await expect(attachments.getByRole('listitem')).toHaveCount(3);
  await expect(input).toHaveValue('请查看：普通文字\n第二行');
  await input.fill('');
  await page.reload();
  await expect(attachments.getByRole('listitem')).toHaveCount(3);
  await expect(attachments.locator('img')).toBeVisible();
  await expect(input).toHaveValue('');
  await page.screenshot({ path: test.info().outputPath('pasted-attachments.png'), fullPage: true });
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/messages'),
  );
  await page.locator('.message-composer button[type="submit"]').click();
  const data = (await sent).postDataJSON();
  expect(data.prompt).toBe('');
  expect(data.attachments).toHaveLength(3);
  await expect(attachments).toHaveCount(0);
  await expect(page.locator('.timeline .user-message').last()).toContainText('粘贴说明.txt');
  await expect(page.locator('.timeline .user-message').last()).toContainText('粘贴资料.pdf');

  await page.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const dialog = page.getByRole('region', { name: '新建会话', exact: true });
  const newInput = dialog.getByLabel('发送给 Codex 的消息');
  const newAttachments = dialog.getByRole('list', { name: '待发送附件' });
  await expect(dialog.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
  await copyImage(page);
  await newInput.press('ControlOrMeta+V');
  await expect(newAttachments.getByRole('listitem')).toHaveCount(1);
  await expect(newAttachments.locator('img')).toBeVisible();
  expect(await transferFiles(newInput, [{ name: '首条消息.txt' }], { itemsOnly: true })).toBe(true);
  await expect(newAttachments.getByRole('listitem')).toHaveCount(2);
  await page.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(newAttachments.getByRole('listitem')).toHaveCount(2);
  await expect(newInput).toHaveValue('');
  await page.screenshot({ path: test.info().outputPath('new-session-paste.png'), fullPage: true });
  const created = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/workspaces/local/sessions'),
  );
  await dialog.getByRole('button', { name: '创建并发送' }).click();
  expect((await created).postDataJSON().attachments).toHaveLength(2);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.timeline .user-message').last()).toContainText('首条消息.txt');
});

test('web controls drag images and files into continued and new conversations', async ({
  page,
  request,
}) => {
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
  const input = page.getByLabel('发送给 Codex 的消息');
  const form = page.locator('.message-composer .prompt-form');
  const attachments = page.getByRole('list', { name: '待发送附件' });
  const files = [
    {
      name: '拖入截图.png',
      type: 'image/png',
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPwmJZHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEvsMEwbybntAAAAAElFTkSuQmCC',
    },
    { name: '拖入说明.txt', content: '拖拽上传的文件正文' },
  ];
  await input.fill('请检查拖入的附件');
  await transferFiles(form, files, { eventType: 'dragenter' });
  await transferFiles(input, files, { eventType: 'dragenter' });
  await transferFiles(input, files, { eventType: 'dragleave' });
  await expect(form).toHaveClass(/is-file-dragging/);
  await transferFiles(form, files, { eventType: 'dragleave' });
  await expect(form).not.toHaveClass(/is-file-dragging/);
  await transferFiles(input, files, { eventType: 'dragenter' });
  await expect(
    page.getByRole('status').filter({ hasText: '松开即可添加图片或文件' }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('message-drop-zone.png'), fullPage: true });
  expect(await transferFiles(input, files, { eventType: 'dragover' })).toBe(true);
  expect(await transferFiles(input, files, { eventType: 'drop' })).toBe(true);
  await expect(form).not.toHaveClass(/is-file-dragging/);
  await expect(attachments.getByRole('listitem')).toHaveCount(2);
  await expect(attachments.getByRole('img', { name: '拖入截图.png', exact: true })).toBeVisible();
  await expect(input).toHaveValue('请检查拖入的附件');
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/messages'),
  );
  await page.locator('.message-composer button[type="submit"]').click();
  expect((await sent).postDataJSON().attachments).toHaveLength(2);
  await expect(attachments).toHaveCount(0);
  await expect(page.locator('.timeline .user-message').last()).toContainText('拖入说明.txt');

  await page.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const dialog = page.getByRole('region', { name: '新建会话', exact: true });
  await expect(dialog.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
  const newForm = dialog.locator('.prompt-form');
  await transferFiles(newForm, files, { eventType: 'dragenter' });
  await expect(newForm).toHaveClass(/is-file-dragging/);
  await page.screenshot({
    path: test.info().outputPath('new-session-drop-zone.png'),
    fullPage: true,
  });
  await transferFiles(newForm, files, { eventType: 'drop' });
  await expect(newForm).not.toHaveClass(/is-file-dragging/);
  await expect(dialog.getByRole('listitem')).toHaveCount(2);
  await expect(dialog.getByRole('img', { name: '拖入截图.png', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('发送给 Codex 的消息')).toHaveValue('');
  await dialog.getByRole('button', { name: '创建并发送' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.timeline .user-message').last()).toContainText('拖入说明.txt');
});

test('web controls queue successive pasted and dropped files, reserve slots and block early sends', async ({
  page,
  request,
}) => {
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
  const input = page.getByLabel('发送给 Codex 的消息');
  const attachments = page.getByRole('list', { name: '待发送附件' });
  const uploads: string[] = [];
  let sends = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/messages')) sends++;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/workspaces/local/uploads?*', async (route) => {
    uploads.push(new URL(route.request().url()).searchParams.get('name')!);
    if (uploads.length === 1) await gate;
    await route.continue();
  });
  try {
    await input.fill('上传期间保留这段消息');
    await transferFiles(input, [{ name: '慢速附件.txt' }]);
    await expect(
      page.getByRole('status').filter({ hasText: '正在上传 慢速附件.txt' }),
    ).toBeVisible();
    await expect(page.locator('.message-composer button[type="submit"]')).toBeDisabled();
    await input.press('Control+Enter');
    expect(sends).toBe(0);
    await transferFiles(input, [{ name: '随后拖入.txt' }], { eventType: 'drop' });
    await transferFiles(
      input,
      Array.from({ length: 9 }, (_, index) => ({ name: `超限-${index}.txt` })),
    );
    await expect(page.getByRole('alert')).toContainText('每条消息最多添加 10 个附件');
  } finally {
    release();
  }
  await expect(attachments.getByRole('listitem')).toHaveCount(2);
  expect(uploads).toEqual(['慢速附件.txt', '随后拖入.txt']);
  await expect(input).toHaveValue('上传期间保留这段消息');
  await transferFiles(input, [{ name: '超大附件.bin', size: 20 * 1024 * 1024 + 1 }], {
    eventType: 'drop',
  });
  await expect(page.getByRole('alert')).toContainText('单个附件不能超过 20 MB');
  expect(uploads).toHaveLength(2);
  await page.route(
    '**/api/workspaces/local/uploads?*',
    (route) => route.fulfill({ status: 500, json: { error: '粘贴附件上传失败，请重试' } }),
    { times: 1 },
  );
  await transferFiles(input, [{ name: '重试附件.txt' }]);
  await expect(page.getByRole('alert')).toContainText('粘贴附件上传失败，请重试');
  await expect(attachments.getByRole('listitem')).toHaveCount(2);
  await expect(page.locator('.message-composer button[type="submit"]')).toBeEnabled();
  await transferFiles(input, [{ name: '重试附件.txt' }]);
  await expect(attachments.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '移除附件 随后拖入.txt', exact: true }).click();
  await expect(attachments.getByRole('listitem')).toHaveCount(2);
});

test('web controls reject file transfers when unavailable and keep ordinary text drags unchanged', async ({
  page,
  request,
}) => {
  await page.route('**/api/workspaces/local/sessions/*/control', (route) =>
    route.fulfill({ json: { available: false, reason: 'Codex 暂不可用' } }),
  );
  let uploads = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/workspaces/local/uploads?')) uploads++;
  });
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeDisabled();
  const input = page.getByLabel('发送给 Codex 的消息');
  await input.fill('暂存消息');
  expect(await transferFiles(input, [{ name: '不可上传.txt' }])).toBe(false);
  await transferFiles(input, [{ name: '不可上传.txt' }], { eventType: 'dragenter' });
  await expect(page.locator('.message-composer .prompt-form')).not.toHaveClass(/is-file-dragging/);
  expect(await transferFiles(input, [{ name: '不可上传.txt' }], { eventType: 'drop' })).toBe(true);
  expect(
    await input.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', '拖拽的普通文字');
      const event = new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await expect(page.getByRole('list', { name: '待发送附件' })).toHaveCount(0);
  await expect(input).toHaveValue('暂存消息');
  expect(uploads).toBe(0);
});

test('web controls append to running sessions, continue idle sessions and create sessions', async ({
  page,
  request,
}) => {
  const hist = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  hist.prepare("UPDATE thread_turns SET status='inProgress' WHERE thread_id=?").run(ids.modern);
  hist.close();
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  const input = page.getByRole('textbox', { name: '发送给 Codex 的消息' });
  await expect(page.getByRole('button', { name: '追加消息', exact: true })).toBeDisabled();
  const first = 'browser append ' + test.info().project.name;
  await input.fill(first);
  const appended = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/messages'),
  );
  await page.getByRole('button', { name: '追加消息', exact: true }).click();
  expect((await (await appended).json()).mode).toBe('append');
  await expect(
    page.locator('.timeline').getByText('测试回复：' + first, { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue('');
  await input.fill('browser idle ' + test.info().project.name);
  const continued = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/messages'),
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  expect((await (await continued).json()).mode).toBe('start');
  await expect(
    page
      .locator('.timeline')
      .getByText('测试回复：browser idle ' + test.info().project.name, { exact: true }),
  ).toBeVisible();
  await page.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('region', { name: '新建会话', exact: true })).toBeVisible();
  await page.getByLabel('新会话项目').selectOption({ label: 'work · D:/work' });
  const prompt = 'browser new ' + test.info().project.name;
  await input.fill(prompt);
  await page.getByRole('button', { name: '创建并发送' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.locator('.timeline').getByText('测试回复：' + prompt, { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/session=[a-f\d-]{36}/);
});

test('web controls choose a model and reset unsupported thinking when switching models', async ({
  page,
  request,
}) => {
  await enter(page, request);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const model = page.getByLabel('新会话模型', { exact: true });
  const thinking = page.getByLabel('新会话思考级别', { exact: true });
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('');
  await expect(thinking).toBeDisabled();
  await model.selectOption('gpt-6.1-sol');
  await thinking.selectOption('ultra');
  await model.selectOption('gpt-6-luna');
  await expect(thinking).toHaveValue('');
  await expect(thinking.locator('option[value="ultra"]')).toHaveCount(0);
  await thinking.selectOption('high');
  await page.getByLabel('发送给 Codex 的消息').fill('new model ' + test.info().project.name);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('new-session-model.png'), fullPage: true });
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/workspaces/local/sessions'),
  );
  await page.getByRole('button', { name: '创建并发送' }).click();
  const response = await sent;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON()).toMatchObject({
    model: 'gpt-6-luna',
    thinking: 'high',
  });
  const receipt = await response.json();
  const token = await ownerToken(request);
  const detail = await (
    await request.get(`/api/workspaces/local/sessions/${receipt.threadId}`, {
      headers: { Authorization: 'Bearer ' + token },
    })
  ).json();
  expect(detail.session.model).toBe('gpt-6-luna');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.timeline')).toContainText('测试回复：new model');
  await expect(page.getByLabel('继续会话模型', { exact: true })).toHaveValue('');
});

test('web controls change models when continuing completed sessions and retain settings for active input', async ({
  page,
  request,
}) => {
  const hist = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  hist.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=?").run(ids.modern);
  try {
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const model = page.getByLabel('继续会话模型', { exact: true });
    const thinking = page.getByLabel('继续会话思考级别', { exact: true });
    await expect(model).toBeEnabled();
    await model.selectOption('gpt-6.1-sol');
    await thinking.selectOption('ultra');
    await model.selectOption('gpt-6-luna');
    await expect(thinking).toHaveValue('');
    await expect(thinking.locator('option[value="ultra"]')).toHaveCount(0);
    await thinking.selectOption('high');
    const input = page.getByLabel('发送给 Codex 的消息');
    await input.fill('continue using chosen model');
    await expect(page.locator('.session-model-settings label')).toHaveCount(0);
    const controls = await Promise.all([
      page.getByRole('button', { name: '添加附件', exact: true }).boundingBox(),
      model.boundingBox(),
      thinking.boundingBox(),
    ]);
    for (const bounds of controls) expect(bounds).not.toBeNull();
    const toolbarCenter = controls[0]!.y + controls[0]!.height / 2;
    for (const bounds of controls.slice(1))
      expect(Math.abs(bounds!.y + bounds!.height / 2 - toolbarCenter)).toBeLessThan(3);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await page.screenshot({
      path: test.info().outputPath('continue-session-model.png'),
      fullPage: true,
    });
    const sent = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/messages'),
    );
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const response = await sent;
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).mode).toBe('start');
    expect(response.request().postDataJSON()).toMatchObject({
      model: 'gpt-6-luna',
      thinking: 'high',
    });
    await expect(model).toHaveValue('');
    await expect(page.locator('.timeline')).toContainText('测试回复：continue using chosen model');
    const token = await ownerToken(request);
    const headers = { Authorization: 'Bearer ' + token };
    expect(
      (await (await request.get(`/api/workspaces/local/sessions/${ids.modern}`, { headers })).json()).session.model,
    ).toBe('gpt-6-luna');
    hist.prepare("UPDATE thread_turns SET status='inProgress' WHERE thread_id=?").run(ids.modern);
    const refresh = page.getByRole('button', { name: '刷新发送状态', exact: true });
    if (!(await refresh.isVisible()))
      await page.getByRole('button', { name: '更多会话操作' }).click();
    await refresh.click();
    await expect(model).toHaveCount(0);
    await input.fill('append while running');
    const appended = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/messages'),
    );
    await page.getByRole('button', { name: '追加消息', exact: true }).click();
    const payload = (await appended).postDataJSON();
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('thinking');
  } finally {
    hist.close();
  }
});

test('web controls can create with defaults when the model catalog is unavailable', async ({
  page,
  request,
}) => {
  await page.route('**/api/workspaces/local/control/models', (route) =>
    route.fulfill({
      json: {
        available: false,
        models: [],
        reason: '模型服务暂不可用',
      },
    }),
  );
  await enter(page, request);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(
    page.getByText('模型列表暂不可用，可使用默认设置创建。', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('新会话模型', { exact: true })).toBeDisabled();
  await page.getByLabel('发送给 Codex 的消息').fill('create with defaults');
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/workspaces/local/sessions'),
  );
  await page.getByRole('button', { name: '创建并发送' }).click();
  const payload = (await sent).postDataJSON();
  expect(payload).not.toHaveProperty('model');
  expect(payload).not.toHaveProperty('thinking');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.timeline')).toContainText('测试回复：create with defaults');
});

test('web controls stop the current turn beside send and preserve the draft', async ({
  page,
  request,
}) => {
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  const stop = page.getByRole('button', { name: '停止当前执行', exact: true });
  const send = page.getByRole('button', { name: '追加消息', exact: true });
  const input = page.getByLabel('发送给 Codex 的消息');
  await expect(stop).toBeEnabled();
  await input.fill('Keep this unsent draft');
  const sendBounds = await send.boundingBox();
  const stopBounds = await stop.boundingBox();
  expect(sendBounds).not.toBeNull();
  expect(stopBounds).not.toBeNull();
  expect(stopBounds!.x).toBeGreaterThanOrEqual(sendBounds!.x + sendBounds!.width);
  expect(Math.abs(stopBounds!.y - sendBounds!.y)).toBeLessThan(3);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('stop-next-to-send.png'), fullPage: true });
  const stopped = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/commands'),
  );
  await stop.click();
  const receipt = await stopped;
  expect(receipt.ok()).toBeTruthy();
  expect(receipt.request().postDataJSON()).toMatchObject({
    command: 'interrupt',
    turnId: 'turn-1',
  });
  expect((await receipt.json()).mode).toBe('interrupt');
  await expect(page.locator('.message-composer > .control-notice')).toHaveText('已停止当前执行。');
  await expect(stop).toBeDisabled();
  await expect(input).toHaveValue('Keep this unsent draft');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.locator('.detail-meta .status')).toContainText('已中断');
});

test('web controls recover a lost stop receipt without interrupting a new turn', async ({
  page,
  request,
}) => {
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  const stop = page.getByRole('button', { name: '停止当前执行', exact: true });
  await expect(stop).toBeEnabled();
  let stops = 0;
  await page.route('**/api/workspaces/local/sessions/*/commands', async (route) => {
    if (route.request().postDataJSON().command !== 'interrupt') return route.continue();
    stops++;
    await route.fetch();
    await route.abort('failed');
  });
  await stop.click();
  await expect(
    page.getByRole('button', { name: '查询停止当前执行结果', exact: true }),
  ).toBeEnabled();
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  try {
    history
      .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
      .run(ids.modern, 'turn-after-stop', 999, 'inProgress', Math.floor(Date.now() / 1000), null);
  } finally {
    history.close();
  }
  await page.reload();
  const query = page.getByRole('button', { name: '查询停止当前执行结果', exact: true });
  await expect(query).toBeEnabled();
  await query.click();
  await expect(stop).toBeEnabled();
  expect(stops).toBe(1);
  await expect(page.locator('.message-composer > .control-notice')).toHaveText('已停止当前执行。');
  const headers = { Authorization: 'Bearer ' + (await ownerToken(request)) };
  expect(
    await (await request.get(`/api/workspaces/local/sessions/${ids.modern}/control`, { headers })).json(),
  ).toMatchObject({ running: true, turnId: 'turn-after-stop' });
});

test('web controls queue input during compaction, survive reload and support cancellation', async ({
  page,
  request,
}) => {
  const hist = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  try {
    hist.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=?").run(ids.modern);
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const operations = page.getByRole('button', { name: '更多会话操作' });
    if (test.info().project.name === 'mobile') await operations.click();
    await page.getByTitle('刷新发送状态').click();
    await expect(page.getByRole('button', { name: '压缩上下文', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '压缩上下文', exact: true }).click();
    const input = page.getByLabel('发送给 Codex 的消息');
    const prompt = 'queued after compaction ' + test.info().project.name;
    await input.fill(prompt);
    const queued = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/messages'),
    );
    await page.getByRole('button', { name: '加入队列', exact: true }).click();
    const response = await queued;
    expect(response.status()).toBe(202);
    expect((await response.json()).state).toBe('queued');
    await expect(page.getByRole('button', { name: '取消排队', exact: true })).toBeVisible();
    await page.screenshot({
      path: `test-results/${test.info().project.name}-compaction-queue.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(input).toHaveValue(prompt);
    await expect(input).toBeDisabled();
    await expect(page.locator('.message-composer .control-notice')).toContainText(/排队|提交/);
    await expect(
      page.locator('.timeline').getByText('测试回复：' + prompt, { exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue('');
    expect(
      hist
        .prepare(
          "SELECT count(*) AS n FROM thread_items WHERE thread_id=? AND item_json LIKE '%userMessage%' AND item_json LIKE ?",
        )
        .get(ids.modern, '%' + prompt + '%')!.n,
    ).toBe(1);

    if (test.info().project.name === 'mobile') await operations.click();
    await page.getByTitle('刷新发送状态').click();
    await page.getByRole('button', { name: '压缩上下文', exact: true }).click();
    const cancelled = 'cancelled during compaction ' + test.info().project.name;
    await input.fill(cancelled);
    const receipt = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/messages'),
    );
    await page.getByRole('button', { name: '加入队列', exact: true }).click();
    const { requestId } = await (await receipt).json();
    await page.getByRole('button', { name: '取消排队', exact: true }).click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue(cancelled);
    await expect(page.locator('.message-composer .control-notice')).toContainText('已取消排队');
    const headers = { Authorization: 'Bearer ' + (await ownerToken(request)) };
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/workspaces/local/sessions/${ids.modern}/control`, { headers })).json())
            .compacting ?? false,
      )
      .toBe(false);
    expect(
      (await (await request.get(`/api/workspaces/local/control/requests/${requestId}`, { headers })).json()).state,
    ).toBe('cancelled');
    expect(
      hist
        .prepare(
          "SELECT count(*) AS n FROM thread_items WHERE thread_id=? AND item_json LIKE '%userMessage%' AND item_json LIKE ?",
        )
        .get(ids.modern, '%' + cancelled + '%')!.n,
    ).toBe(0);
  } finally {
    hist.close();
  }
});

test('a lost send receipt survives reload and can be queried without repeating the message', async ({
  page,
  request,
}) => {
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  const prompt = 'lost receipt ' + test.info().project.name;
  await page.getByLabel('发送给 Codex 的消息').fill(prompt);
  await page.route('**/api/workspaces/local/sessions/*/messages', async (route) => {
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: /^(发送消息|追加消息)$/, exact: true }).click();
  await expect(page.getByRole('button', { name: '查询发送结果' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('发送给 Codex 的消息')).toHaveValue(prompt);
  await expect(page.getByLabel('发送给 Codex 的消息')).toBeDisabled();
  await page.getByRole('button', { name: '查询发送结果' }).click();
  await expect(page.getByLabel('发送给 Codex 的消息')).toHaveValue('');
  await expect(
    page.locator('.timeline').getByText('测试回复：' + prompt, { exact: true }),
  ).toBeVisible();
  const hist = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'), {
    readOnly: true,
  });
  const count = hist
    .prepare(
      "SELECT count(*) AS n FROM thread_items WHERE thread_id=? AND item_json LIKE ? AND item_json LIKE '%userMessage%'",
    )
    .get(ids.modern, '%' + prompt + '%');
  hist.close();
  expect(count!.n).toBe(1);
});
test('common commands compact idle context and manage persistent goals', async ({
  page,
  request,
}) => {
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  if (test.info().project.name === 'mobile') {
    await expect(page.locator('.message-composer')).not.toHaveClass(/unavailable/);
    const operations = page.getByRole('button', { name: '更多会话操作' });
    await operations.click();
    await expect(operations).toHaveAttribute('aria-expanded', 'true');
  }
  await expect(page.getByRole('button', { name: '压缩上下文', exact: true })).toBeDisabled();
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  history.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=?").run(ids.modern);
  history.close();
  await page.getByTitle('刷新发送状态').click();
  const compaction = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/commands'),
  );
  await page.getByRole('button', { name: '压缩上下文', exact: true }).click();
  expect((await (await compaction).json()).mode).toBe('compact');
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`/api/workspaces/local/sessions/${ids.modern}/control`, {
              headers: { Authorization: 'Bearer ' + (await ownerToken(request)) },
            })
          ).json()
        ).compacting ?? false,
    )
    .toBe(false);
  await page.getByRole('button', { name: '目标', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '目标管理' });
  await expect(dialog.getByLabel('当前目标')).toContainText('尚未设置目标');
  await dialog
    .getByLabel('目标内容', { exact: true })
    .fill('browser goal ' + test.info().project.name);
  await dialog.getByRole('button', { name: '设置目标并执行' }).click();
  await expect(dialog.getByLabel('当前目标')).toContainText(
    'browser goal ' + test.info().project.name,
  );
  await dialog.getByRole('button', { name: '暂停目标', exact: true }).click();
  await expect(dialog.getByLabel('当前目标')).toContainText('已暂停');
  await dialog.getByRole('button', { name: '继续目标', exact: true }).click();
  await expect(dialog.getByLabel('当前目标')).toContainText('进行中');
  await dialog.getByRole('button', { name: '清除目标', exact: true }).click();
  await expect(dialog.getByLabel('当前目标')).toContainText('尚未设置目标');
  await dialog.getByTitle('关闭目标管理').click();
  await page.getByLabel('发送给 Codex 的消息').fill('/help');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message-composer')).toContainText('可用指令：/compact');
});

test('goal strip stays above the input and supports editing, pausing, resuming and stopping', async ({
  page,
  request,
}) => {
  const token = await ownerToken(request),
    headers = { Authorization: 'Bearer ' + token },
    route = `/api/workspaces/local/sessions/${ids.modern}/commands`,
    objective = '审查项目的安全性、可维护性和性能，修复问题并验证桌面与手机的完整流程。'.repeat(5),
    updated = '修改后的目标：完成登录、授权、实时同步和移动端操作的验证。'.repeat(4);
  const command = async (name: string, prompt?: string) => {
    const result = await request.post(route, {
      headers,
      data: { command: name, prompt, requestId: crypto.randomUUID() },
    });
    expect(result.ok()).toBeTruthy();
    return result.json();
  };
  await command('goal.set', objective);
  try {
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const strip = page.getByLabel('会话目标', { exact: true });
    await expect(strip.locator('.goal-objective')).toHaveText(objective);
    await expect(strip).toHaveAttribute('data-status', 'active');
    const layout = await strip.locator('.goal-objective').evaluate((node) => {
      const style = getComputedStyle(node),
        strip = node.closest('.session-goal-strip')!.getBoundingClientRect(),
        input = document.querySelector('.message-composer textarea')!.getBoundingClientRect();
      return {
        singleLine: style.whiteSpace === 'nowrap',
        ellipsis: style.textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth,
        aboveInput: strip.bottom <= input.top,
        inViewport: strip.left >= 0 && strip.right <= innerWidth && input.bottom <= innerHeight,
      };
    });
    expect(layout).toEqual({
      singleLine: true,
      ellipsis: true,
      aboveInput: true,
      inViewport: true,
    });
    await strip.getByRole('button', { name: '修改目标', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '目标管理' });
    await expect(dialog.getByLabel('目标内容', { exact: true })).toHaveValue(objective);
    await dialog.getByLabel('目标内容', { exact: true }).fill(updated);
    await dialog.getByRole('button', { name: '保存修改并执行', exact: true }).click();
    await expect(dialog.getByLabel('当前目标')).toContainText(updated);
    await dialog.getByTitle('关闭目标管理').click();
    await expect(strip.locator('.goal-objective')).toHaveText(updated);
    await page.reload();
    await expect(strip.locator('.goal-objective')).toHaveText(updated);
    await strip.getByRole('button', { name: '修改目标', exact: true }).click();
    await expect(dialog.getByLabel('目标内容', { exact: true })).toHaveValue(updated);
    await dialog.getByTitle('关闭目标管理').click();
    await strip.getByRole('button', { name: '暂停目标', exact: true }).click();
    await expect(strip).toHaveAttribute('data-status', 'paused');
    await expect(strip.locator('.goal-objective')).toHaveText(updated);
    await strip.getByRole('button', { name: '继续目标', exact: true }).click();
    await expect(strip).toHaveAttribute('data-status', 'active');
    await page.route('**/api/workspaces/local/sessions/*/commands', (route) =>
      route.fulfill({ status: 403, json: { error: '停止目标被拒绝（测试）' } }),
    );
    await strip.getByRole('button', { name: '停止目标', exact: true }).click();
    await expect(page.locator('.goal-strip-notice')).toContainText('停止目标被拒绝');
    await expect(strip).toBeVisible();
    await page.unroute('**/api/workspaces/local/sessions/*/commands');
    await strip.getByRole('button', { name: '停止目标', exact: true }).click();
    await expect(strip).toHaveCount(0);
    expect(
      (await (await request.get(`/api/workspaces/local/sessions/${ids.modern}/goal`, { headers })).json()).goal,
    ).toBeNull();
  } finally {
    await command('goal.clear');
  }
});

test('goal strip shows accumulated execution time and refreshes it without crowding the controls', async ({
  page,
  request,
}) => {
  const token = await ownerToken(request),
    headers = { Authorization: 'Bearer ' + token },
    commandUrl = `/api/workspaces/local/sessions/${ids.modern}/commands`;
  let seconds: number | undefined = 65,
    status = 'active',
    reads = 0;
  const set = await request.post(commandUrl, {
    headers,
    data: {
      command: 'goal.set',
      prompt: '持续执行目标，保持手机端单行显示。'.repeat(12),
      requestId: crypto.randomUUID(),
    },
  });
  expect(set.ok()).toBeTruthy();
  try {
    await page.route('**/api/workspaces/local/sessions/*/goal', async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      if (body.goal) body.goal = { ...body.goal, status, timeUsedSeconds: seconds };
      reads++;
      await route.fulfill({ response, json: body });
    });
    await page.clock.install();
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const strip = page.getByLabel('会话目标', { exact: true }),
      duration = strip.locator('.goal-duration');
    await expect(duration).toHaveText('已执行 1分5秒');
    const refresh = async () => {
      const previousReads = reads;
      await page.clock.fastForward(10000);
      await expect.poll(() => reads).toBeGreaterThan(previousReads);
    };
    seconds = 3661;
    await refresh();
    await expect(duration).toHaveText('已执行 1时1分1秒');
    status = 'paused';
    await refresh();
    await expect(strip).toHaveAttribute('data-status', 'paused');
    await expect(duration).toHaveText('已执行 1时1分1秒');
    await expect(strip.getByRole('button', { name: '继续目标', exact: true })).toBeVisible();
    seconds = undefined;
    await refresh();
    await expect(duration).toHaveText('已执行 —');
    seconds = 0;
    await refresh();
    await expect(duration).toHaveText('已执行 0秒');
    seconds = 90061;
    await refresh();
    await expect(duration).toHaveText('已执行 25时1分1秒');
    if (test.info().project.name === 'mobile')
      await page.setViewportSize({ width: 320, height: 844 });
    const fits = await strip.evaluate((node) => {
      const bounds = node.getBoundingClientRect(),
        time = node.querySelector('.goal-duration')!.getBoundingClientRect(),
        actions = node.querySelector('.goal-strip-actions')!.getBoundingClientRect();
      return (
        bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        time.right <= actions.left &&
        time.top >= bounds.top &&
        time.bottom <= bounds.bottom &&
        actions.right <= bounds.right &&
        actions.top >= bounds.top &&
        actions.bottom <= bounds.bottom &&
        document.documentElement.scrollWidth <= innerWidth
      );
    });
    expect(fits).toBeTruthy();
    await strip.getByRole('button', { name: '修改目标', exact: true }).click();
    await expect(page.getByLabel('当前目标')).toContainText('已执行 25时1分1秒');
  } finally {
    await request.post(commandUrl, {
      headers,
      data: { command: 'goal.clear', requestId: crypto.randomUUID() },
    });
  }
});

test('password login persists after reload, and logout invalidates access', async ({
  page,
  request,
}) => {
  await ownerToken(request);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '连接工作空间' })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByRole('alert')).toContainText('用户名或密码错误');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByRole('heading', { name: '全部会话', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '全部会话', exact: true })).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('codex-monitor.auth.v1'));
  if (test.info().project.name === 'mobile') await page.getByTitle('打开菜单').click();
  await page.getByTitle('退出登录').click();
  await expect(page.getByRole('heading', { name: '连接工作空间' })).toBeVisible();
  expect(
    (
      await request.get('/api/workspaces/local/sessions', { headers: { Authorization: 'Bearer ' + token } })
    ).status(),
  ).toBe(401);
});
test('search, archived sessions and legacy tool results work', async ({ page, request }) => {
  await enter(page, request);
  await page.getByLabel('搜索会话', { exact: true }).fill('旧版本');
  await expect(page.getByTestId('session-row')).toHaveCount(2);
  await page.getByTestId('session-row').filter({ hasText: '本机工作空间' }).click();
  await expect(page.getByRole('region', { name: '会话详情' })).toBeVisible();
  await page.locator('.activity-summary').click();
  await page.getByText('exec_command', { exact: true }).click();
  await expect(
    page.locator('.tool-card').filter({ hasText: 'npm test' }).locator('.tool-body pre'),
  ).toContainText('npm test');
  await expect(page.getByText('执行结果', { exact: true })).toHaveCount(0);
  await page.getByTitle('返回会话列表').click();
  await page.getByTitle('清除搜索').click();
  await page.locator('.filter-tabs').getByRole('button', { name: '已归档', exact: true }).click();
  await expect(page.getByTestId('session-row')).toHaveCount(2);
  await expect(page.getByTestId('session-row').filter({ hasText: '本机工作空间' })).toContainText(
    '已归档的历史会话',
  );
});
test('conversation keeps messages visible, folds activity, searches details and exports history', async ({
  page,
  request,
}) => {
  await enter(page, request);
  let tracker = false;
  page.on('request', (r) => {
    if (r.url().includes('tracker.png')) tracker = true;
  });
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.locator('.detail-heading')).toContainText('开发 codex-monitor');
  await expect(page.locator('.timeline table')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(tracker).toBe(false);
  await expect(page.locator('.conversation-label')).toContainText('会话');
  await expect(
    page.locator('.conversation-toolbar button', { hasText: /全部|对话|工具|思考/ }),
  ).toHaveCount(0);
  await expect(page.locator('[id="event-user-1"]')).toHaveCount(1);
  await expect(page.locator('[id="event-agent-1"]')).toHaveCount(1);
  const messageCount = await page.locator('.timeline .message').count();
  const activity = page.locator('.activity-group');
  await expect(activity).toHaveCount(1);
  await expect(activity.locator('.activity-summary')).toContainText('2 次工具调用');
  await expect(activity.locator('.activity-summary')).toContainText('1 项失败');
  await expect(activity).not.toHaveAttribute('open', '');
  await expect(page.locator('.tool-card summary').first()).not.toBeVisible();
  await activity.locator('.activity-summary').focus();
  await page.keyboard.press('Enter');
  await expect(activity).toHaveAttribute('open', '');
  await expect(page.locator('.tool-card').first()).not.toHaveAttribute('open', '');
  await page.locator('.tool-card').filter({ hasText: 'npm test' }).locator('summary').click();
  await expect(
    page.locator('.tool-card').filter({ hasText: 'npm test' }).locator('.tool-body pre'),
  ).toContainText('npm test');
  await expect(page.getByText('执行结果', { exact: true })).toHaveCount(0);
  await expect(page.locator('.tool-error')).toHaveCount(1);
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith(`/api/workspaces/local/sessions/${ids.modern}`),
  );
  await page.getByTitle('刷新数据', { exact: true }).click();
  await refreshed;
  await expect(activity).toHaveAttribute('open', '');
  await expect(page.locator('.tool-body pre').first()).toBeVisible();
  await page.getByLabel('搜索会话内容', { exact: true }).fill('npm test');
  await expect(page.locator('.tool-card')).toHaveCount(1);
  await expect(page.locator('.tool-body pre')).toBeVisible();
  await page.getByLabel('搜索会话内容', { exact: true }).fill('检查权限边界');
  await expect(page.locator('.reasoning-card .markdown')).toBeVisible();
  await page.getByTitle('清除内容搜索', { exact: true }).click();
  await expect(page.locator('.timeline .message')).toHaveCount(messageCount);
  await expect(activity).not.toHaveAttribute('open', '');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTitle('导出 Markdown').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  if (!(await page.locator('.outline').isVisible()))
    await page.getByTitle('对话目录', { exact: true }).click();
  await expect(page.locator('.outline')).toBeVisible();
  await page.getByTitle('关闭目录').click();
  await expect(page.locator('.outline')).toHaveCount(0);
  await page.locator('.activity-summary').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/${test.info().project.name}-timeline.png`,
    fullPage: true,
  });
  await activity.locator('.activity-summary').click();
  await expect(page.locator('.tool-body pre').first()).not.toBeVisible();
  await page.screenshot({
    path: `test-results/${test.info().project.name}-activity-expanded.png`,
    fullPage: true,
  });
});
test('semantic tool titles appear in folded activity, update live and remain searchable on mobile', async ({
  page,
  request,
}) => {
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite')),
    state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite')),
    itemId = 'semantic-browser-title',
    title = '读取源查询结果并继续同期商品核查，核对各门店销售金额和退货数量',
    updatedTitle = '修正查询截取并继续同期商品页，核对各门店销售金额和退货数量',
    stamp = Date.now(),
    ordinal =
      Number(history.prepare('SELECT MAX(rollout_ordinal) AS n FROM thread_items').get()!.n) + 1;
  const item = {
    type: 'mcpToolCall',
    server: 'cua_repl',
    tool: 'js',
    arguments: { code: 'x'.repeat(4000), title, context: 'y'.repeat(4000) },
    status: 'inProgress',
  };
  function touch() {
    const now = Date.now();
    state
      .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
      .run(Math.floor(now / 1000), now, ids.modern);
  }
  try {
    history
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(ids.modern, 'turn-1', itemId, ordinal, stamp, JSON.stringify(item), stamp, null);
    touch();
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const activity = page.locator('.activity-group'),
      card = page.locator(`#event-${itemId}`);
    await expect(activity).not.toHaveAttribute('open', '');
    await expect(activity.locator('.activity-label')).toHaveText(title);
    await expect(activity.locator('.activity-summary')).toContainText('3 次工具调用');
    item.arguments.title = updatedTitle;
    item.status = 'completed';
    history
      .prepare('UPDATE thread_items SET item_json=?,completed_at_ms=? WHERE item_id=?')
      .run(JSON.stringify(item), stamp + 2000, itemId);
    touch();
    await expect(activity.locator('.activity-label')).toHaveText(updatedTitle);
    await expect(activity).not.toHaveAttribute('open', '');
    await activity.locator('.activity-summary').click();
    await expect(card.locator('summary strong')).toHaveText(updatedTitle);
    await expect(card.locator('.tool-preview')).toHaveCount(0);
    await expect(page.locator('#event-tool-1 summary strong')).toHaveText('终端命令');
    await expect(page.locator('#event-tool-1 .tool-preview')).toContainText('npm test');
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('summary strong')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath('semantic-tool-titles.png'),
      fullPage: true,
    });
    await page.getByLabel('搜索会话内容', { exact: true }).fill(updatedTitle);
    await expect(page.locator('.tool-card')).toHaveCount(1);
    await expect(card.locator('.tool-body pre')).toBeVisible();
    await expect(card.locator('.tool-body pre')).not.toContainText(updatedTitle);
    await expect(card.locator('.code-label')).toContainText('js · 调用参数');
    const downloading = page.waitForEvent('download');
    await page.getByTitle('导出 Markdown').click();
    const exported = readFileSync((await (await downloading).path())!, 'utf8');
    expect(exported).toContain(`## ${updatedTitle} ·`);
  } finally {
    history.prepare('DELETE FROM thread_items WHERE item_id=?').run(itemId);
    touch();
    history.close();
    state.close();
  }
});

test('folded activity shows the latest tool time and updates without opening or using reasoning time', async ({
  page,
  request,
}) => {
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  const rollout = path.join(root, 'codex', 'sessions', `rollout-${ids.modern}.jsonl`);
  const stamp = Date.now(),
    ordinal = Number(
      history.prepare('SELECT MAX(rollout_ordinal) AS n FROM thread_items').get()!.n,
    ),
    generated: string[] = [];
  function append(item: Record<string, unknown>, timestamp: number) {
    generated.push(String(item.id));
    history
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(
        ids.modern,
        'turn-1',
        String(item.id),
        ordinal + generated.length,
        timestamp,
        JSON.stringify(item),
        timestamp,
        timestamp,
      );
    appendFileSync(rollout, '\n');
  }
  try {
    append(
      {
        type: 'commandExecution',
        id: 'tool-time-first',
        command: 'inspect first',
        status: 'completed',
      },
      stamp,
    );
    append(
      { type: 'reasoning', id: 'tool-time-thought', summary: ['这条思考记录比工具调用更新。'] },
      stamp + 1000,
    );
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const activity = page.locator('.activity-group').last(),
      latest = activity.locator('.activity-time');
    await expect(latest).toHaveAttribute('datetime', new Date(stamp).toISOString());
    await expect(latest).toContainText(/\d{2}:\d{2}:\d{2}/);
    await expect(latest).toHaveAttribute('title', /^最新工具调用：/);
    await expect(activity).not.toHaveAttribute('open', '');
    append(
      {
        type: 'commandExecution',
        id: 'tool-time-latest',
        command: 'inspect latest',
        status: 'completed',
      },
      stamp + 2000,
    );
    await expect(latest).toHaveAttribute('datetime', new Date(stamp + 2000).toISOString());
    await expect(activity).not.toHaveAttribute('open', '');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    for (const id of generated) history.prepare('DELETE FROM thread_items WHERE item_id=?').run(id);
    appendFileSync(rollout, '\n');
    history.close();
  }
});

test('real source changes stream into the open timeline and reconnect after offline', async ({
  page,
  request,
  context,
}) => {
  const rollout = path.join(root, 'codex', 'sessions', `rollout-${ids.modern}.jsonl`);
  const originalRollout = readFileSync(rollout);
  const inserted: string[] = [];
  await enter(page, request);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page.locator('.connection')).toContainText('实时同步');
  function append(text: string) {
    const db = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
    const n = Number(db.prepare('SELECT MAX(rollout_ordinal) AS n FROM thread_items').get()!.n) + 1;
    const now = Date.now(),
      id = 'e2e-live-' + n;
    db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(
      ids.modern,
      'turn-1',
      id,
      n,
      now,
      JSON.stringify({ type: 'agentMessage', id, text, phase: 'commentary' }),
      now,
      now,
    );
    inserted.push(id);
    db.close();
    appendFileSync(
      path.join(root, 'codex', 'sessions', `rollout-${ids.modern}.jsonl`),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }) + '\n',
    );
  }
  try {
    const first = `实时输出验证 ${test.info().project.name} ${Date.now()}`;
    append(first);
    await expect(page.locator('.timeline').getByText(first, { exact: true })).toBeVisible({
      timeout: 12000,
    });
    await context.setOffline(true);
    await page.waitForTimeout(500);
    await context.setOffline(false);
    const second = `重连后的输出 ${Date.now()}`;
    append(second);
    await expect(page.locator('.timeline').getByText(second, { exact: true })).toBeVisible({
      timeout: 18000,
    });
  } finally {
    const db = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
    for (const id of inserted)
      db.prepare('DELETE FROM thread_items WHERE thread_id=? AND item_id=?').run(ids.modern, id);
    db.close();
    writeFileSync(rollout, originalRollout);
  }
});
test('responsive layout, navigation and access settings remain usable', async ({
  page,
  request,
}) => {
  await enter(page, request);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `test-results/${test.info().project.name}-overview.png`,
    fullPage: true,
  });
  if (test.info().project.name === 'mobile') await page.getByTitle('打开菜单').click();
  await page.getByRole('button', { name: /设置与访问管理/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: '已授权设备', exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: '访问账户', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('loaded history pages remain available during live and manual refresh', async ({
  page,
  request,
}) => {
  const state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite'));
  const generated: string[] = [];
  try {
    const base = state.prepare('SELECT * FROM threads WHERE id=?').get(ids.legacy)!;
    for (let i = 0; i < 125; i++) {
      const id = `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`;
      generated.push(id);
      state
        .prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          `分页验证 ${i}`,
          base.cwd!,
          base.rollout_path!,
          base.created_at!,
          base.updated_at!,
          Number(base.updated_at_ms) - 60000,
          0,
          123,
          'vscode',
          'gpt-6.1-sol',
          '分页测试',
          '分页测试',
          null,
          'legacy',
        );
    }
    await enter(page, request);
    await expect(page.getByTestId('session-row')).toHaveCount(60);
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
    await expect(page.getByTestId('session-row')).toHaveCount(120);
    await page.getByTitle('刷新数据', { exact: true }).click();
    await expect(page.getByTestId('session-row')).toHaveCount(120);
    const response = page.waitForResponse(
      (r) => r.url().includes('/api/workspaces/local/sessions?') && r.url().includes('offset=100'),
    );
    const now = Date.now();
    state
      .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
      .run(Math.floor(now / 1000), now, ids.modern);
    await response;
    await expect(page.getByTestId('session-row')).toHaveCount(120);
  } finally {
    for (const id of generated) state.prepare('DELETE FROM threads WHERE id=?').run(id);
    state.close();
  }
});

test('slow session responses render while realtime updates continue without overlapping requests', async ({
  page,
  request,
}) => {
  await enter(page, request);
  let active = 0,
    maximum = 0;
  await page.route(new RegExp(`/api/workspaces/local/sessions/${ids.modern}(?:\\?.*)?$`), async (route) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.fulfill({ response });
    } catch {
    } finally {
      active--;
    }
  });
  const state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite'));
  const timer = setInterval(
    () =>
      state
        .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
        .run(Math.floor(Date.now() / 1000), Date.now(), ids.modern),
    200,
  );
  try {
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    await expect(page.locator('.detail-heading')).toContainText('开发 codex-monitor 实时监控', {
      timeout: 6500,
    });
    await expect(page.locator('.timeline .tool-card')).toHaveCount(2);
    expect(maximum).toBe(1);
  } finally {
    clearInterval(timer);
    state.close();
  }
});

function historyPages(readable = true) {
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  const generated: string[] = [];
  const now = Date.now();
  const rollout = path.join(root, 'codex', 'sessions', `rollout-${ids.modern}.jsonl`);
  for (let index = 0; index < 150; index++) {
    const id = 'auto-history-' + index;
    generated.push(id);
    history
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(
        ids.modern,
        'turn-1',
        id,
        100 + index,
        now + index * 1000,
        JSON.stringify(
          readable || index === 0
            ? { type: 'agentMessage', id, text: `历史消息 ${index}\n\n验证自动分页与阅读位置。` }
            : { type: 'reasoning', id, summary: [] },
        ),
        now,
        now,
      );
  }
  appendFileSync(rollout, '\n');
  return () => {
    for (const id of generated) history.prepare('DELETE FROM thread_items WHERE item_id=?').run(id);
    appendFileSync(rollout, '\n');
    history.close();
  };
}

function foldedHistoryPages() {
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  const now = Date.now();
  for (let index = 0; index < 150; index++) {
    const id = 'folded-tool-' + index;
    history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(
      ids.modern,
      'turn-1',
      id,
      100 + index,
      now + index,
      JSON.stringify({
        type: 'commandExecution',
        id,
        command: `inspect ${index}`,
        status: 'completed',
        exitCode: 0,
      }),
      now,
      now,
    );
  }
  return () => {
    history.prepare("DELETE FROM thread_items WHERE item_id LIKE 'folded-tool-%'").run();
    history.close();
  };
}

test('folded activity pages stay lazy until history is requested', async ({ page, request }) => {
  const cleanup = foldedHistoryPages();
  const cursors: string[] = [];
  try {
    await page.route(`**/api/workspaces/local/sessions/${ids.modern}?before=*`, async (route) => {
      cursors.push(new URL(route.request().url()).searchParams.get('before')!);
      await route.continue();
    });
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    await expect(page.locator('.tool-card')).toHaveCount(70);
    await expect(page.locator('.activity-group')).toHaveCount(1);
    await expect(page.locator('.activity-group[open]')).toHaveCount(0);
    const refreshed = page.waitForResponse((response) =>
      response.url().endsWith(`/api/workspaces/local/sessions/${ids.modern}`),
    );
    await page.getByTitle('刷新数据', { exact: true }).click();
    await refreshed;
    expect(cursors).toHaveLength(0);
    await page.locator('.load-earlier').click();
    await expect(page.locator('[id="event-user-1"]')).toHaveCount(1);
    await expect(page.locator('.tool-card')).toHaveCount(152);
    expect(cursors).toHaveLength(2);
    await expect(page.locator('.activity-group[open]')).toHaveCount(0);
  } finally {
    cleanup();
  }
});

for (const input of ['wheel', 'keyboard', 'touch'] as const) {
  test(`upward ${input} loads folded history with less than 140 pixels to scroll`, async ({
    page,
    request,
    isMobile,
  }) => {
    test.skip(input === 'touch' && !isMobile, 'Touch gestures use the mobile browser.');
    const cleanup = foldedHistoryPages();
    const cursors: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      await page.route(`**/api/workspaces/local/sessions/${ids.modern}?before=*`, async (route) => {
        cursors.push(new URL(route.request().url()).searchParams.get('before')!);
        if (cursors.length === 1) await gate;
        await route.continue();
      });
      await enter(page, request);
      await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
      const timeline = page.locator('.timeline-scroll');
      await expect(page.locator('.tool-card')).toHaveCount(70);
      const size = await timeline.evaluate((el) => ({
        content: el.firstElementChild!.getBoundingClientRect().height,
        height: el.clientHeight,
      }));
      const viewport = page.viewportSize()!;
      const overflow = input === 'keyboard' ? 60 : -80;
      await page.setViewportSize({
        ...viewport,
        height: viewport.height + size.content - size.height - overflow,
      });
      await expect
        .poll(() => timeline.evaluate((el) => el.scrollHeight - el.clientHeight))
        .toBeLessThan(140);
      if (input !== 'keyboard')
        await expect
          .poll(() => timeline.evaluate((el) => el.scrollHeight - el.clientHeight))
          .toBe(0);
      else
        await expect
          .poll(() => timeline.evaluate((el) => el.scrollHeight - el.clientHeight))
          .toBeGreaterThan(0);
      expect(cursors).toHaveLength(0);
      const box = (await timeline.boundingBox())!;
      if (input === 'wheel') {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 200);
        expect(cursors).toHaveLength(0);
        await page.mouse.wheel(0, -200);
      } else if (input === 'keyboard') {
        await timeline.focus();
        await page.keyboard.press('Home');
      } else {
        const cdp = await page.context().newCDPSession(page);
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...point, y: point.y + 40 }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      }
      await expect(page.locator('.load-earlier')).toBeDisabled();
      await expect.poll(() => cursors.length).toBe(1);
      for (let index = 0; index < 5; index++)
        await timeline.dispatchEvent('wheel', { deltaY: -100 });
      expect(cursors).toHaveLength(1);
      release();
      await expect(page.locator('[id="event-user-1"]')).toHaveCount(1);
      await expect(page.locator('.load-earlier')).toHaveCount(0);
      expect(cursors).toHaveLength(2);
      expect(new Set(cursors).size).toBe(2);
      await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
    } finally {
      release();
      cleanup();
    }
  });
}

test('scrolling to the top loads history once per page and preserves the reading position', async ({
  page,
  request,
}) => {
  const cleanup = historyPages();
  const cursors: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    await page.route(`**/api/workspaces/local/sessions/${ids.modern}?before=*`, async (route) => {
      cursors.push(new URL(route.request().url()).searchParams.get('before')!);
      if (cursors.length === 1) await gate;
      await route.continue();
    });
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const timeline = page.locator('.timeline-scroll');
    const messages = page.locator('[id^="event-auto-history-"]');
    await expect(messages).toHaveCount(70);
    await expect.poll(() => timeline.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
    expect(cursors).toHaveLength(0);
    await timeline.evaluate((el) => (el.scrollTop = 0));
    await expect(page.locator('.load-earlier')).toBeDisabled();
    const position = await timeline.evaluate((el) => {
      el.scrollTop = 42;
      for (let index = 0; index < 10; index++) el.dispatchEvent(new Event('scroll'));
      const top = el.getBoundingClientRect().top;
      const anchor = [...el.querySelectorAll<HTMLElement>('[id^="event-"]')].find(
        (event) => event.getBoundingClientRect().bottom > top,
      )!;
      return { id: anchor.id, offset: anchor.getBoundingClientRect().top - top };
    });
    await expect.poll(() => cursors.length).toBe(1);
    release();
    await expect(messages).toHaveCount(140);
    await expect
      .poll(() =>
        timeline.evaluate((el, position) => {
          const anchor = document.getElementById(position.id)!;
          return Math.abs(
            anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - position.offset,
          );
        }, position),
      )
      .toBeLessThan(2);
    await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
    await page.screenshot({
      path: `test-results/${test.info().project.name}-auto-history.png`,
      fullPage: true,
    });
    await timeline.evaluate((el) => (el.scrollTop = 0));
    await expect(messages).toHaveCount(150);
    await expect(page.locator('.load-earlier')).toHaveCount(0);
    expect(cursors).toHaveLength(2);
    expect(new Set(cursors).size).toBe(2);
    await page.getByTitle('刷新数据', { exact: true }).click();
    await expect(messages).toHaveCount(150);
    await timeline.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    expect(cursors).toHaveLength(2);
  } finally {
    release();
    cleanup();
  }
});

test('automatic history loading retries failures and continues through invisible records', async ({
  page,
  request,
}) => {
  const cleanup = historyPages(false);
  let attempts = 0;
  try {
    await page.route(`**/api/workspaces/local/sessions/${ids.modern}?before=*`, async (route) => {
      if (++attempts === 1)
        await route.fulfill({ status: 503, json: { error: '历史读取暂不可用' } });
      else await route.continue();
    });
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const retry = page.getByRole('button', { name: /重试加载更早的记录/ });
    await expect(retry).toBeVisible();
    const refreshed = page.waitForResponse((response) =>
      response.url().endsWith(`/api/workspaces/local/sessions/${ids.modern}`),
    );
    await page.getByTitle('刷新数据', { exact: true }).click();
    await refreshed;
    await expect(retry).toBeVisible();
    expect(attempts).toBe(1);
    await retry.click();
    await expect(page.locator('[id="event-auto-history-0"]')).toHaveCount(1);
    await expect(page.locator('[id="event-user-1"]')).toHaveCount(1);
    await expect(page.locator('.load-earlier')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(attempts).toBe(3);
  } finally {
    cleanup();
  }
});

test('full conversation directory stays docked on desktop and locates unloaded history', async ({
  page,
  request,
}) => {
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  const rollout = path.join(root, 'codex', 'sessions', `rollout-${ids.modern}.jsonl`);
  const generated: string[] = [];
  const now = Date.now();
  try {
    for (let index = 0; index < 80; index++) {
      const id = 'outline-test-tool-' + index;
      generated.push(id);
      history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(
        ids.modern,
        'turn-1',
        id,
        100 + index,
        now + index,
        JSON.stringify({
          type: 'commandExecution',
          id,
          command: 'echo history step ' + index,
          status: 'completed',
          aggregatedOutput: 'ok',
        }),
        now,
        now,
      );
    }
    const userId = 'outline-test-user',
      agentId = 'outline-test-agent';
    generated.push(userId, agentId);
    history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(
      ids.modern,
      'turn-1',
      userId,
      181,
      now + 81,
      JSON.stringify({
        type: 'userMessage',
        id: userId,
        content: [{ type: 'text', text: '第二轮：验证右侧对话目录' }],
      }),
      now,
      now,
    );
    history
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(
        ids.modern,
        'turn-1',
        agentId,
        182,
        now + 82,
        JSON.stringify({ type: 'agentMessage', id: agentId, text: '目录第二轮验证完成。' }),
        now,
        now,
      );
    // Real Codex writes also update the rollout, which invalidates the outline cache.
    appendFileSync(rollout, '\n');
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    await expect(page.locator('.detail-heading')).toContainText('开发 codex-monitor');
    if (!(await page.locator('.outline').isVisible()))
      await page.getByTitle('对话目录', { exact: true }).click();
    await expect(page.locator('.outline')).toBeVisible();
    await expect(page.locator('.outline-entry')).toHaveCount(2);
    await expect(page.locator('.outline')).toContainText('82 次调用');
    await expect(page.locator('.outline')).toContainText('目录第二轮验证完成。');
    await expect(page.locator('[id="event-user-1"]')).toHaveCount(0);
    await page.getByRole('button', { name: '定位第 1 次提问', exact: true }).click();
    await expect(page.locator('[id="event-user-1"]')).toBeInViewport();
    if (
      test.info().project.name === 'desktop' &&
      (await page.locator('.detail-panel').boundingBox())!.width > 1120
    )
      await expect(page.locator('.outline')).toBeVisible();
    else await expect(page.locator('.outline')).toHaveCount(0);
    await page.screenshot({
      path: `test-results/${test.info().project.name}-directory.png`,
      fullPage: true,
    });
  } finally {
    for (const id of generated) history.prepare('DELETE FROM thread_items WHERE item_id=?').run(id);
    appendFileSync(rollout, '\n');
    history.close();
  }
});

test('mobile fixed shortcuts switch running conversations and can collapse', async ({
  page,
  request,
}) => {
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  history
    .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
    .run(ids.legacy, 'quick-switch-test', 999, 'inProgress', Math.floor(Date.now() / 1000), null);
  try {
    await enter(page, request);
    const shortcuts = page.getByRole('navigation', { name: '正在进行的会话快捷切换' });
    if (test.info().project.name === 'desktop') {
      await expect(shortcuts).not.toBeVisible();
      return;
    }
    await expect(shortcuts).toBeVisible();
    await page.getByTitle('展开正在进行的会话').click();
    await shortcuts
      .getByRole('button', { name: '切换到正在进行的会话：检查旧版本会话解析', exact: true })
      .click();
    await expect(page.locator('.detail-heading')).toContainText('检查旧版本会话解析');
    await page.getByTitle('展开正在进行的会话').click();
    await expect(
      shortcuts.getByRole('button', {
        name: '切换到正在进行的会话：检查旧版本会话解析',
        exact: true,
      }),
    ).toHaveAttribute('aria-current', 'page');
    await shortcuts
      .getByRole('button', {
        name: '切换到正在进行的会话：开发 codex-monitor 实时监控',
        exact: true,
      })
      .click();
    await expect(page.locator('.detail-heading')).toContainText('开发 codex-monitor 实时监控');
    await page.getByTitle('展开正在进行的会话').click();
    await page.getByTitle('收起进行中会话快捷栏').click();
    await expect(shortcuts.getByRole('button', { name: /^切换到/ })).toHaveCount(0);
    await page.getByTitle('展开正在进行的会话').click();
    await expect(
      shortcuts
        .getByRole('region', { name: '本机工作空间的进行中会话' })
        .getByRole('button', { name: /^切换到/ }),
    ).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/mobile-running-switcher.png', fullPage: true });
  } finally {
    history.prepare('DELETE FROM thread_turns WHERE turn_id=?').run('quick-switch-test');
    history.close();
  }
});

test.describe('mobile switcher mouse states', () => {
  // Use a mouse at mobile widths to verify hover/active; the touch workflow is covered separately.
  test.use({ isMobile: false, hasTouch: false });
  for (const theme of ['light', 'dark']) {
    test(`mobile running switcher preserves the ${theme} page behind its backdrop`, async ({
      page,
      request,
    }) => {
      test.skip(test.info().project.name !== 'mobile', 'The running switcher is mobile only');
      await page.addInitScript(
        (theme) => localStorage.setItem('codex-monitor.theme', theme),
        theme,
      );
      await enter(page, request);
      const shortcuts = page.getByRole('navigation', { name: '正在进行的会话快捷切换' });
      const backdrop = page.getByRole('button', { name: '关闭运行会话列表', exact: true });
      for (const view of ['list', 'detail']) {
        await page.getByTitle('展开正在进行的会话').click();
        await expect(backdrop).toBeVisible();
        const background = await backdrop.evaluate(
          (node) => getComputedStyle(node).backgroundColor,
        );
        expect(background).toMatch(/^rgba\(.+,\s0\.\d+\)$/);
        // Move away first so a previous touch cannot suppress a mouse move to identical coordinates.
        await shortcuts.getByTitle('收起进行中会话快捷栏').hover();
        await backdrop.hover({ position: { x: 10, y: 10 } });
        await expect.poll(() => backdrop.evaluate((node) => node.matches(':hover'))).toBe(true);
        await backdrop.evaluate((node) =>
          Promise.all(node.getAnimations().map((animation) => animation.finished)),
        );
        await page.screenshot({ path: test.info().outputPath(`${view}-backdrop-hover.png`) });
        await expect(backdrop).toHaveCSS('background-color', background);
        await page.mouse.down();
        await expect.poll(() => backdrop.evaluate((node) => node.matches(':active'))).toBe(true);
        await backdrop.evaluate((node) =>
          Promise.all(node.getAnimations().map((animation) => animation.finished)),
        );
        await expect(backdrop).toHaveCSS('background-color', background);
        await page.mouse.up();
        await expect(backdrop).toHaveCount(0);
        if (view === 'list') {
          await expect(page.getByRole('heading', { name: '全部会话', exact: true })).toBeVisible();
          await page.getByTitle('展开正在进行的会话').click();
          await shortcuts
            .getByRole('button', {
              name: '切换到正在进行的会话：开发 codex-monitor 实时监控',
              exact: true,
            })
            .click();
        }
        await expect(page.locator('.detail-heading')).toContainText('开发 codex-monitor 实时监控');
        await expect(shortcuts).toHaveClass(/collapsed/);
      }
    });
  }
});

test('mobile drawer sorts recent sessions by activity across statuses and follows updates', async ({
  page,
  request,
}) => {
  if (test.info().project.name === 'desktop') {
    await enter(page, request);
    await expect(page.getByRole('navigation', { name: '最近会话', exact: true })).toBeHidden();
    return;
  }
  const state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite'));
  const saved = state
    .prepare('SELECT id,updated_at,updated_at_ms FROM threads WHERE id IN (?,?,?)')
    .all(ids.modern, ids.legacy, ids.archived);
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  try {
    const now = Date.now();
    history
      .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
      .run(
        ids.legacy,
        'drawer-completed-test',
        999,
        'completed',
        Math.floor(now / 1000) - 60,
        Math.floor(now / 1000),
      );
    const update = state.prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?');
    update.run(Math.floor(now / 1000), now, ids.modern);
    update.run(Math.floor((now + 1000) / 1000), now + 1000, ids.archived);
    update.run(Math.floor((now + 2000) / 1000), now + 2000, ids.legacy);
    await enter(page, request);
    await page.getByTitle('打开菜单').click();
    const recent = page.getByRole('navigation', { name: '最近会话', exact: true });
    await expect(recent).toBeVisible();
    await expect(recent.locator('.sidebar-session').first()).toHaveAttribute(
      'aria-label',
      '打开会话：检查旧版本会话解析',
    );
    await expect(recent.locator('.status.running')).toBeVisible();
    await expect(recent.locator('.status.completed').first()).toBeVisible();
    await expect(recent).toContainText('已归档');
    await page.screenshot({ path: 'test-results/mobile-recent-drawer.png', fullPage: true });
    await recent.getByRole('button', { name: '打开会话：检查旧版本会话解析', exact: true }).click();
    await expect(page.locator('.detail-heading')).toContainText('检查旧版本会话解析');
    await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
    await page.getByTitle('打开菜单').click();
    await expect(
      recent.getByRole('button', { name: '打开会话：检查旧版本会话解析', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await page
      .locator('.sidebar-section-tabs')
      .getByRole('button', { name: '项目', exact: true })
      .click();
    await expect(page.locator('.projects-nav')).toBeVisible();
    await expect(recent).toBeHidden();
    await page
      .locator('.sidebar-section-tabs')
      .getByRole('button', { name: '最近会话', exact: true })
      .click();
    update.run(Math.floor((now + 3000) / 1000), now + 3000, ids.archived);
    await expect(recent.locator('.sidebar-session').first()).toHaveAttribute(
      'aria-label',
      '打开会话：已归档的历史会话',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    history.prepare('DELETE FROM thread_turns WHERE turn_id=?').run('drawer-completed-test');
    history.close();
    for (const row of saved)
      state
        .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
        .run(row.updated_at!, row.updated_at_ms!, row.id!);
    state.close();
  }
});

test('recorded image operations display thumbnails and authenticated full previews', async ({
  page,
  request,
}) => {
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  const data = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPwmJZHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEvsMEwbybntAAAAAElFTkSuQmCC',
    'base64',
  );
  const file = path.join(root, 'image-preview.png');
  writeFileSync(file, data);
  const now = Date.now();
  try {
    for (let index = 0; index < 2; index++) {
      const id = 'image-preview-' + index;
      history
        .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
        .run(
          ids.modern,
          'turn-1',
          id,
          300 + index,
          now + index,
          JSON.stringify({ type: 'imageView', id, path: file }),
          now,
          now,
        );
    }
    appendFileSync(
      path.join(root, 'codex', 'sessions', `rollout-${ids.modern}.jsonl`),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }) + '\n',
    );
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    await expect(page.locator('.image-event-heading')).toHaveText('已查看 2 张图片');
    const thumbnails = page.getByRole('button', {
      name: '放大查看图片：image-preview.png',
      exact: true,
    });
    await expect(thumbnails).toHaveCount(2);
    await expect(page.locator('.image-thumbnail img').first()).toHaveJSProperty('naturalWidth', 32);
    await thumbnails.first().click();
    await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible();
    await page.getByTitle('关闭图片预览').click();
    await expect(page.getByRole('dialog', { name: '图片预览' })).toHaveCount(0);
    expect((await request.get(`/api/workspaces/local/sessions/${ids.modern}/images/image-preview-0`)).status()).toBe(
      401,
    );
  } finally {
    history.prepare("DELETE FROM thread_items WHERE item_id LIKE 'image-preview-%'").run();
    history.close();
  }
});

test('message Markdown shows local images inline, opens previews and handles missing images', async ({
  page,
  request,
}) => {
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  const file = path.join(root, '月同期对比 preview.png');
  writeFileSync(
    file,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPwmJZHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEvsMEwbybntAAAAAElFTkSuQmCC',
      'base64',
    ),
  );
  const now = Date.now(),
    remoteRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('example.invalid')) remoteRequests.push(request.url());
  });
  try {
    history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(
      ids.modern,
      'turn-1',
      'inline-images',
      300,
      now,
      JSON.stringify({
        type: 'agentMessage',
        text: [
          '已保存并发布到看板。',
          `![已发布的月同期对比](<${file.replaceAll('\\', '/')}>)`,
          '![文件地址图片][preview]',
          `[preview]: ${pathToFileURL(file).href}`,
          `![已清理的图片](${pathToFileURL(path.join(root, 'missing.png')).href})`,
          '![远程图片](https://example.invalid/tracker.png)',
        ].join('\n\n'),
      }),
      now,
      now,
    );
    appendFileSync(
      path.join(root, 'codex', 'sessions', `rollout-${ids.modern}.jsonl`),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }) + '\n',
    );
    await enter(page, request);
    await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
    const message = page.locator('#event-inline-images'),
      preview = message.getByRole('button', {
        name: '放大查看图片：已发布的月同期对比',
        exact: true,
      });
    await message.locator('.inline-session-image').first().scrollIntoViewIfNeeded();
    await expect(preview).toBeVisible();
    await expect(preview.locator('img')).toHaveJSProperty('naturalWidth', 32);
    await expect(
      message.getByRole('button', { name: '放大查看图片：文件地址图片', exact: true }),
    ).toBeVisible();
    await expect(message).toContainText('图片文件不存在或已移动');
    await expect(message.locator('.image-placeholder')).toHaveText('远程图片');
    const imageUrl = await preview.locator('img').getAttribute('src');
    history
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(
        ids.modern,
        'turn-1',
        'inline-image-refresh',
        301,
        now + 1,
        JSON.stringify({ type: 'agentMessage', text: '图片预览刷新完成' }),
        now + 1,
        now + 1,
      );
    await page.getByTitle('刷新数据', { exact: true }).click();
    await expect(page.locator('#event-inline-image-refresh')).toContainText('图片预览刷新完成');
    await expect(preview.locator('img')).toHaveAttribute('src', imageUrl!);
    await preview.click();
    const lightbox = page.getByRole('dialog', { name: '图片预览' });
    await expect(lightbox).toBeVisible();
    await expect(lightbox.locator('img')).toHaveJSProperty('naturalWidth', 32);
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    await preview.click();
    await page.getByTitle('关闭图片预览').click();
    await expect(lightbox).toHaveCount(0);
    expect(remoteRequests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath('inline-message-images.png'),
      fullPage: true,
    });
  } finally {
    history
      .prepare("DELETE FROM thread_items WHERE item_id IN ('inline-images','inline-image-refresh')")
      .run();
    history.close();
  }
});

test('session details show recent context tokens and usage percentage', async ({
  page,
  request,
}) => {
  const file = path.join(root, 'codex', 'sessions', `rollout-${ids.legacy}.jsonl`),
    original = readFileSync(file);
  try {
    appendFileSync(
      file,
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date().toISOString(),
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 9000000 },
            last_token_usage: { input_tokens: 90000, output_tokens: 10000, total_tokens: 100000 },
            model_context_window: 200000,
          },
        },
      }) + '\n',
    );
    await enter(page, request);
    await page
      .getByTestId('session-row')
      .filter({ hasText: '检查旧版本会话解析' })
      .filter({ hasText: '本机工作空间' })
      .click();
    await expect(page.locator('.context-meter')).toContainText('100K / 200K');
    await expect(page.locator('.context-meter')).toContainText('50.0%');
    if (test.info().project.name === 'desktop')
      await expect(page.getByRole('meter', { name: '上下文使用率' })).toHaveAttribute(
        'aria-valuenow',
        '50',
      );
  } finally {
    writeFileSync(file, original);
  }
});
