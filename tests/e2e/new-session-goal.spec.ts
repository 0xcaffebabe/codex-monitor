import { openComposerMenu, closeComposerMenu } from './composer-helpers';
import { test, expect, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ids } from '../fixture.js';
import { projectId } from '../control-fixture.js';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
const secondWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const extraProject = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  name: 'extra',
  path: 'D:/project/codex-monitor',
};
let previousIds: unknown[] = [];
let authToken: string | undefined;
const mutations = new Set<Request>();

test.beforeEach(async ({ page }) => {
  await page.route('**/api/notifications/completions', (route) =>
    route.fulfill({ json: { generation: 'new-session-test', revision: 0, notifications: [] } }),
  );
  const state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite'));
  previousIds = state
    .prepare('SELECT id FROM threads')
    .all()
    .map((row) => row.id);
  state.close();
  mutations.clear();
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/workspaces/'))
      mutations.add(request);
  });
  page.on('requestfinished', (request) => mutations.delete(request));
  page.on('requestfailed', (request) => mutations.delete(request));
});

test.afterEach(async () => {
  await expect.poll(() => mutations.size).toBe(0);
  const state = new DatabaseSync(path.join(root, 'codex', 'state_5.sqlite'));
  const history = new DatabaseSync(path.join(root, 'codex', 'thread_history_1.sqlite'));
  for (const row of state.prepare('SELECT id FROM threads').all()) {
    if (previousIds.includes(row.id)) continue;
    history.prepare('DELETE FROM thread_items WHERE thread_id=?').run(row.id!);
    history.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(row.id!);
    state.prepare('DELETE FROM threads WHERE id=?').run(row.id!);
  }
  state.close();
  history.close();
});

async function signIn(request: APIRequestContext): Promise<string> {
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
  const { token } = await response.json();
  return token;
}

async function enter(page: Page, request: APIRequestContext) {
  const token = (authToken ??= await signIn(request));
  await page.addInitScript((value) => localStorage.setItem('codex-monitor.auth.v1', value), token);
  await page.goto('/?view=all');
  await expect(page.getByRole('heading', { name: '全部会话', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  return page.getByRole('region', { name: '新建会话', exact: true });
}

async function restoreLegacyDesktopSelection(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(
      (key) => key.startsWith('codex-monitor.draft.') && key.endsWith('.new'),
    );
    if (!key) throw new Error('Missing new-session draft');
    const draft = JSON.parse(sessionStorage.getItem(key)!);
    sessionStorage.setItem(key, JSON.stringify({ ...draft, desktopChannel: true }));
    return draft.requestId as string | undefined;
  });
}

test('new sessions use the detail page and preserve separate drafts while navigating', async ({
  page,
  request,
  isMobile,
}) => {
  let creates = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/workspaces/local/sessions')) creates++;
  });
  const newSession = await enter(page, request);
  await expect(newSession).toHaveClass(/detail-panel/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(newSession.getByRole('heading', { name: '新建会话', exact: true })).toBeVisible();
  await expect(newSession.locator('.timeline')).toHaveCount(0);
  await expect(newSession.getByTitle('复制恢复命令')).toHaveCount(0);
  await expect(newSession.getByLabel('新会话项目')).not.toHaveValue('');
  await expect(newSession.getByRole('button', { name: '创建并发送', exact: true })).toBeDisabled();
  await expect(page.locator('.app-shell')).toHaveClass(/has-detail/);
  await expect(page.locator('.session-panel .tokens')).toHaveCount(0);
  if (isMobile) await expect(page.locator('.session-panel')).toBeHidden();
  else await expect(newSession.getByLabel('发送给 Codex 的消息')).toBeFocused();
  await newSession.getByLabel('发送给 Codex 的消息').fill('新会话的独立草稿');
  await page.screenshot({ path: test.info().outputPath('new-session-detail.png'), fullPage: true });
  expect(
    await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > innerWidth,
      overflowY: document.documentElement.scrollHeight > innerHeight,
    })),
  ).toEqual({ overflowX: false, overflowY: false });
  await newSession.getByTitle('返回会话列表').click();
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(page).toHaveURL(new RegExp(`session=${ids.modern}`));
  const existingInput = page.getByLabel('发送给 Codex 的消息');
  await expect(existingInput).toBeEmpty();
  await existingInput.fill('已有会话的独立草稿');
  if (isMobile) await page.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(newSession.getByLabel('发送给 Codex 的消息')).toHaveValue('新会话的独立草稿');
  await expect(newSession.locator('.timeline')).toHaveCount(0);
  await expect(page).not.toHaveURL(/session=/);
  if (isMobile) await page.getByTitle('打开菜单', { exact: true }).click();
  await page.getByRole('button', { name: '全部会话', exact: true }).click();
  await expect(newSession).toHaveCount(0);
  await page.getByTestId('session-row').filter({ hasText: '开发 codex-monitor' }).click();
  await expect(existingInput).toHaveValue('已有会话的独立草稿');
  expect(creates).toBe(0);
});

test('new sessions discard legacy desktop selections and remember explicit permissions', async ({
  page,
  request,
  isMobile,
}) => {
  await page.route('**/api/workspaces/local/control', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, creationPermissions: true, desktopChannel: true } });
  });
  await page.route('**/api/workspaces/local/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    // Adapt only the fixture call; the browser request must retain its explicit permission.
    const payload = route.request().postDataJSON();
    delete payload.permissionMode;
    await route.fulfill({ response: await route.fetch({ postData: payload }) });
  });
  const newSession = await enter(page, request);
  const desktop = newSession.getByRole('checkbox', { name: '桌面通道', exact: true, includeHidden: true });
  const input = newSession.getByLabel('发送给 Codex 的消息');
  const permission = newSession.getByLabel('新会话权限');
  await expect(desktop).toHaveCount(0);
  await expect(permission).toHaveValue('inherit');
  await permission.selectOption('read-only');
  await input.fill('native first message ' + test.info().project.name);
  await restoreLegacyDesktopSelection(page);
  await page.reload();
  await expect(desktop).toHaveCount(0);
  await expect(input).toHaveValue('native first message ' + test.info().project.name);
  await expect(permission).toHaveValue('read-only');
  await expect(newSession.getByRole('alert')).toHaveCount(0);
  await expect(newSession).not.toContainText('审批在桌面端处理');
  await openComposerMenu(page, '发送设置');
  await newSession.getByLabel('新会话模型').selectOption('gpt-6.1-sol');
  await newSession.getByLabel('新会话思考级别').selectOption('high');
  await closeComposerMenu(page, '发送设置');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('new-session-default-channel.png'),
    fullPage: true,
  });
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/workspaces/local/sessions'),
  );
  await newSession.getByRole('button', { name: '创建并发送', exact: true }).click();
  const response = await sent;
  expect(response.ok()).toBeTruthy();
  const payload = response.request().postDataJSON();
  expect(payload).toMatchObject({
    permissionMode: 'read-only',
    model: 'gpt-6.1-sol',
    thinking: 'high',
  });
  expect(payload).not.toHaveProperty('channel');
  expect(payload).not.toHaveProperty('desktopChannel');
  await expect(page.locator('.timeline')).toContainText('测试回复：native first message');
  await expect(page.getByRole('checkbox', { name: '桌面通道', exact: true, includeHidden: true })).not.toBeChecked();
  if (isMobile) await page.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(permission).toHaveValue('read-only');
  await expect(input).toBeEmpty();
});

test('new session permissions are remembered separately for each workspace', async ({
  page,
  request,
}) => {
  await page.route('**/api/workspaces/*/control', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), creationPermissions: true } });
  });
  const newSession = await enter(page, request);
  const workspace = newSession.getByLabel('新会话工作空间');
  const permission = newSession.getByLabel('新会话权限');
  await permission.selectOption('danger-full-access');
  await workspace.selectOption(secondWorkspace);
  await expect(permission).toHaveValue('inherit');
  await permission.selectOption('workspace-write');
  await workspace.selectOption('local');
  await expect(permission).toHaveValue('danger-full-access');
  await permission.selectOption('inherit');
  await page.reload();
  await expect(permission).toHaveValue('inherit');
  await workspace.selectOption(secondWorkspace);
  await expect(permission).toHaveValue('workspace-write');
});

test('new sessions restore the last workspace and its project', async ({ page, request }) => {
  await page.route('**/api/workspaces/*/control', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: { ...body, projects: [...body.projects, extraProject], creationPermissions: true },
    });
  });
  const newSession = await enter(page, request);
  const workspace = newSession.getByLabel('新会话工作空间');
  const project = newSession.getByLabel('新会话项目');
  const permission = newSession.getByLabel('新会话权限');
  await expect(project).toHaveValue(projectId);
  await workspace.selectOption(secondWorkspace);
  await expect(workspace).toHaveValue(secondWorkspace);
  await project.selectOption(extraProject.id);
  await permission.selectOption('workspace-write');
  await page.reload();
  await expect(project).toHaveValue(extraProject.id);

  await page.goto('/?view=all&workspace=local');
  await expect(page.getByLabel('切换工作空间')).toHaveValue('local');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(workspace).toHaveValue(secondWorkspace);
  await expect(project).toHaveValue(extraProject.id);
  await expect(permission).toHaveValue('workspace-write');

  await page.goto('/?view=new');
  await expect(workspace).toHaveValue(secondWorkspace);
  await expect(project).toHaveValue(extraProject.id);
  await page.goto('/?view=new&workspace=local');
  await expect(workspace).toHaveValue('local');
  await expect(project).toHaveValue(projectId);
  await page.goto(`/?view=all&workspace=local&project=${encodeURIComponent(extraProject.path)}`);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(workspace).toHaveValue('local');
  await expect(project).toHaveValue(extraProject.id);
});

test('new sessions fall back when the saved workspace or project is unavailable', async ({
  page,
  request,
}) => {
  let offline = false;
  let projectAvailable = true;
  await page.route('**/api/workspaces', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (offline) {
      body.workspaces.find((workspace: { id: string }) => workspace.id === secondWorkspace).online =
        false;
    }
    await route.fulfill({ json: body });
  });
  await page.route(`**/api/workspaces/${secondWorkspace}/control`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (projectAvailable) body.projects.push(extraProject);
    await route.fulfill({ json: body });
  });
  const newSession = await enter(page, request);
  const workspace = newSession.getByLabel('新会话工作空间');
  const project = newSession.getByLabel('新会话项目');
  await workspace.selectOption(secondWorkspace);
  await project.selectOption(extraProject.id);
  projectAvailable = false;
  await page.reload();
  await expect(workspace).toHaveValue(secondWorkspace);
  await expect(project).toHaveValue(projectId);

  offline = true;
  await page.goto('/?view=all&workspace=local');
  const create = page.getByRole('button', { name: '新建会话', exact: true });
  await create.click();
  await expect(workspace).toHaveValue('local');
  await expect(project).toHaveValue(projectId);

  offline = false;
  projectAvailable = true;
  await page.goto('/?view=all&workspace=local');
  await create.click();
  await expect(workspace).toHaveValue(secondWorkspace);
  await expect(project).toHaveValue(extraProject.id);
});

test('ordinary creation omits unsupported fields even with a saved permission', async ({
  page,
  request,
}) => {
  let creates = 0;
  let creationPermissions = true;
  await page.route('**/api/workspaces/local/control', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), creationPermissions } });
  });
  await page.route('**/api/workspaces/local/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creates++;
    const payload = route.request().postDataJSON();
    // The old client strictly rejected new fields, even when the checkbox was off.
    if ('asGoal' in payload || 'permissionMode' in payload)
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: '请选择项目，并输入最多 12000 字符的消息或上传附件。' }),
      });
    return route.continue();
  });
  const newSession = await enter(page, request);
  const permission = newSession.getByLabel('新会话权限');
  await permission.selectOption('read-only');
  creationPermissions = false;
  await page.reload();
  await expect(newSession.getByLabel('新会话项目')).not.toHaveValue('');
  await expect(permission).toHaveCount(0);
  await expect(newSession.getByRole('checkbox', { name: '将首条消息设为目标' })).not.toBeChecked();
  const prompt = '现在任务推送webhook的流程什么样的 ' + test.info().project.name;
  await newSession.getByLabel('发送给 Codex 的消息').fill(prompt);
  await newSession.getByRole('button', { name: '创建并发送', exact: true }).click();
  await expect(newSession).toHaveCount(0);
  await expect(page.locator('.timeline').getByText(prompt, { exact: true })).toBeVisible();
  expect(creates).toBe(1);
});

test('a goal mode draft survives reopening and creates one native goal with attachments', async ({
  page,
  request,
}) => {
  let creates = 0,
    extraMessages = 0;
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    if (req.url().endsWith('/api/workspaces/local/sessions')) creates++;
    if (/\/sessions\/[^/]+\/(messages|commands)$/.test(req.url())) extraMessages++;
  });
  const newSession = await enter(page, request);
  const toggle = newSession.getByRole('checkbox', { name: '将首条消息设为目标' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const objective = 'goal-first attachment ' + test.info().project.name;
  await newSession.getByLabel('目标内容', { exact: true }).fill(objective);
  await newSession.locator('input[type=file]').setInputFiles({
    name: 'goal-spec.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Finish the attached requirements'),
  });
  await expect(newSession.getByText('goal-spec.txt', { exact: true })).toBeVisible();
  await newSession.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(newSession.getByLabel('目标内容', { exact: true })).toHaveValue(objective);
  await expect(newSession.getByText('goal-spec.txt', { exact: true })).toBeVisible();
  await expect(newSession.getByRole('button', { name: '创建并执行目标' })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('new-session-goal.png'), fullPage: true });
  const response = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' && res.url().endsWith('/api/workspaces/local/sessions'),
  );
  await newSession.getByRole('button', { name: '创建并执行目标' }).click();
  const receipt = await (await response).json();
  expect(receipt.goalState).toBe('saved');
  expect(receipt.goal.objective).toContain(objective);
  expect(receipt.goal.objective).toContain('附件（已上传到本机临时目录）');
  await expect(newSession).toHaveCount(0);
  await expect(page.getByLabel('会话目标').locator('.goal-objective')).toContainText(objective);
  await expect(page.locator('.timeline .user-message')).toContainText(`/goal ${objective}`);
  expect(creates).toBe(1);
  expect(extraMessages).toBe(0);
});

test('goal validation keeps long drafts and a first /goal command uses the goal mode', async ({
  page,
  request,
}) => {
  const newSession = await enter(page, request);
  await newSession.getByLabel('发送给 Codex 的消息').fill('x'.repeat(4001));
  await newSession.getByRole('checkbox', { name: '将首条消息设为目标' }).check();
  await expect(newSession.getByLabel('目标内容', { exact: true })).toHaveValue('x'.repeat(4001));
  await expect(newSession.getByRole('button', { name: '创建并执行目标' })).toBeDisabled();
  await expect(newSession.getByRole('alert')).toContainText('目标最多 4000 字符');
  await newSession.getByRole('checkbox', { name: '将首条消息设为目标' }).uncheck();
  const objective = 'goal-first slash ' + test.info().project.name;
  await newSession.getByLabel('发送给 Codex 的消息').fill(`/goal ${objective}`);
  await expect(newSession.getByRole('checkbox', { name: '将首条消息设为目标' })).toBeChecked();
  await expect(newSession.getByRole('alert')).toHaveCount(0);
  await newSession.getByRole('button', { name: '创建并执行目标' }).click();
  await expect(newSession).toHaveCount(0);
  await expect(page.getByLabel('会话目标').locator('.goal-objective')).toHaveText(objective);
});

test('a lost goal creation receipt survives reload and is queried without another create', async ({
  page,
  request,
}) => {
  let creates = 0;
  await page.route('**/api/workspaces/local/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creates++;
    await route.fetch();
    await route.abort('failed');
  });
  const newSession = await enter(page, request);
  await newSession.getByRole('checkbox', { name: '将首条消息设为目标' }).check();
  const objective = 'goal-first lost response ' + test.info().project.name;
  await newSession.getByLabel('目标内容', { exact: true }).fill(objective);
  await newSession.getByRole('button', { name: '创建并执行目标' }).click();
  await expect(newSession.getByRole('button', { name: '查询发送结果' })).toBeVisible();
  await expect(
    newSession.getByRole('checkbox', { name: '将首条消息设为目标', exact: true }),
  ).toBeDisabled();
  await expect(newSession.getByRole('checkbox', { name: '桌面通道', exact: true, includeHidden: true })).toHaveCount(0);
  const requestId = await restoreLegacyDesktopSelection(page);
  expect(requestId).toBeTruthy();
  await page.reload();
  await expect(newSession).toBeVisible();
  await expect(newSession.getByRole('checkbox', { name: '将首条消息设为目标' })).toBeChecked();
  await expect(newSession.getByLabel('目标内容', { exact: true })).toHaveValue(objective);
  await expect(newSession.getByRole('checkbox', { name: '桌面通道', exact: true, includeHidden: true })).toHaveCount(0);
  const checked = page.waitForResponse((response) =>
    response.url().endsWith('/control/requests/' + requestId),
  );
  await newSession.getByRole('button', { name: '查询发送结果' }).click();
  expect((await checked).ok()).toBeTruthy();
  await expect(newSession).toHaveCount(0);
  await expect(page.getByLabel('会话目标').locator('.goal-objective')).toHaveText(objective);
  expect(creates).toBe(1);
});

test('a partial goal receipt keeps its thread and offers recovery after leaving the new session page', async ({
  page,
  request,
}) => {
  let creates = 0,
    retries = 0;
  await page.route('**/api/workspaces/local/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creates++;
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        goalState: 'unknown',
        goalError: '目标保存状态待确认',
        message: '会话已创建并发送，请确认目标保存结果。',
      },
    });
  });
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/control\/requests\/[^/]+\/goal$/.test(req.url())) retries++;
  });
  const newSession = await enter(page, request);
  await newSession.getByRole('checkbox', { name: '将首条消息设为目标' }).check();
  const objective = 'goal-first recovery ' + test.info().project.name;
  await newSession.getByLabel('目标内容', { exact: true }).fill(objective);
  await newSession.getByRole('button', { name: '创建并执行目标' }).click();
  await expect(newSession.getByRole('button', { name: '打开已创建会话' })).toBeVisible();
  await expect(newSession.getByRole('button', { name: '创建并执行目标' })).toHaveCount(0);
  await newSession.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(newSession.getByRole('alert')).toContainText('目标保存状态待确认');
  await page.route(/\/control\/requests\/[^/]+$/, (route) =>
    route.fulfill({ status: 404, json: { error: '找不到该发送请求' } }),
  );
  await newSession.getByRole('button', { name: '查询发送结果' }).click();
  await expect(newSession.getByRole('alert')).toContainText('请打开已创建会话核对目标');
  await expect(newSession.getByRole('button', { name: '创建并执行目标' })).toHaveCount(0);
  await newSession.getByRole('button', { name: '打开已创建会话' }).click();
  await expect(newSession).toHaveCount(0);
  await expect(page.getByLabel('会话目标').locator('.goal-objective')).toHaveText(objective);
  await page.getByTitle('返回会话列表').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(newSession.getByRole('button', { name: '重试保存目标' })).toBeVisible();
  await newSession.getByRole('button', { name: '重试保存目标' }).click();
  await expect(newSession).toHaveCount(0);
  await expect(page.getByLabel('会话目标').locator('.goal-objective')).toHaveText(objective);
  expect(creates).toBe(1);
  expect(retries).toBe(1);
});
