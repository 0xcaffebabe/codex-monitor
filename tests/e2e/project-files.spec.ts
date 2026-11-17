import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, ids } from '../fixture.js';
import { FixtureDesktop, projectId } from '../control-fixture.js';
import { createMonitorServer } from '../../server/server-app.js';
import { MonitorClient } from '../../server/client/connection.js';
import { requestGuard } from '../../server/http/security.js';

const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherProjectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const portable = (value: string) => realpathSync(value).split(path.sep).join('/');

async function fileWorkspace() {
  const local = fixture();
  const remote = fixture(path.join(local.root, 'client-b'));
  const makeProject = (f: ReturnType<typeof fixture>, name: string) => {
    const root = path.join(f.root, '项目 files');
    for (const folder of ['src/deep', 'docs', '__proto__'])
      mkdirSync(path.join(root, folder), { recursive: true });
    for (const file of [
      'README.md',
      'src/common.ts',
      'docs/common.ts',
      'src/deep/needle 服务.ts',
      'docs/NEEDLE.md',
      '__proto__/prototype.ts',
      `${name}-only.ts`,
    ])
      writeFileSync(path.join(root, file), 'FILE_CONTENT_SHOULD_NOT_BE_SENT');
    f.state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(root, ids.modern);
    return root;
  };
  const roots = [makeProject(local, 'local'), makeProject(remote, 'remote')];
  const other = path.join(local.root, '另一个项目');
  mkdirSync(other);
  writeFileSync(path.join(other, 'other-project.ts'), 'other');
  class FilesDesktop extends FixtureDesktop {
    constructor(
      f: ReturnType<typeof fixture>,
      private directory: string,
    ) {
      super(f);
    }
    override async projects() {
      return [
        { id: projectId, name: '文件选择测试', path: this.directory },
        { id: otherProjectId, name: '另一个项目', path: other },
      ];
    }
  }
  const service = createMonitorServer(local.config, {
    publicDir: process.env.MONITOR_TEST_PUBLIC_DIR,
  });
  const server = createServer(service.app);
  service.gateway.attach(server, requestGuard(local.config));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: MonitorClient[] = [];
  for (const [index, id] of ['local', secondId].entries()) {
    const registration = service.gateway.store.create(index ? '远程文件测试' : '本机文件测试', id);
    const f = index ? remote : local;
    clients.push(
      await MonitorClient.start({
        config: f.config,
        serverUrl: url,
        workspaceId: id,
        key: registration.key,
        services: { control: new FilesDesktop(f, roots[index]) },
      }),
    );
  }
  const owner = await service.auth.setup('owner', 'project-files-e2e-password!');
  const token = service.auth.issue(owner, 'project files').token;
  return {
    url,
    token,
    roots: roots.map(portable),
    other: portable(other),
    close: async () => {
      for (const client of clients) await client.close();
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      remote.close();
      local.close();
      rmSync(local.root, { recursive: true, force: true });
    },
  };
}

let workspace: Awaited<ReturnType<typeof fileWorkspace>>;
test.beforeEach(async ({ page }) => {
  workspace = await fileWorkspace();
  await page.addInitScript(
    (token) => localStorage.setItem('codex-monitor.auth.v1', token),
    workspace.token,
  );
  await page.route('**/api/notifications/completions', (route) =>
    route.fulfill({ json: { generation: 'project-files', revision: 0, notifications: [] } }),
  );
});
test.afterEach(async () => {
  await workspace.close();
});

async function openPicker(page: Page) {
  await page.getByRole('button', { name: '选择项目文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择项目文件', exact: true });
  await expect(dialog.getByRole('button', { name: '插入路径', exact: true })).toBeDisabled();
  return dialog;
}

test('project tree and filename search keep multi-selection and insert paths into an appended message', async ({
  page,
}) => {
  await page.goto(`${workspace.url}/?workspace=local&session=${ids.modern}`);
  const prompt = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true });
  await prompt.fill('请检查以下项目文件');
  const dialog = await openPicker(page);
  await expect(dialog.locator('.project-file-root')).toHaveText(workspace.roots[0]);
  await dialog.getByRole('button', { name: '目录 __proto__', exact: true }).click();
  await expect(
    dialog.getByRole('checkbox', { name: '选择文件 __proto__/prototype.ts', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '目录 __proto__', exact: true }).click();
  await dialog.getByRole('button', { name: '目录 src', exact: true }).click();
  await dialog.getByRole('button', { name: '目录 src/deep', exact: true }).click();
  await dialog
    .getByRole('checkbox', { name: '选择文件 src/deep/needle 服务.ts', exact: true })
    .check();
  const search = dialog.getByRole('textbox', { name: '搜索项目文件名', exact: true });
  await search.fill('readme');
  await dialog.getByRole('checkbox', { name: '选择文件 README.md', exact: true }).check();
  await search.fill('NEEDLE');
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await expect(
    dialog.getByRole('checkbox', { name: '选择文件 src/deep/needle 服务.ts', exact: true }),
  ).toBeChecked();
  await search.fill('nothing-matches');
  await expect(dialog.getByText('没有找到匹配的文件', { exact: true })).toBeVisible();
  await expect(dialog.getByText('已选 2 个文件', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '清除文件搜索', exact: true }).click();
  await expect(
    dialog.getByRole('checkbox', { name: '选择文件 src/deep/needle 服务.ts', exact: true }),
  ).toBeChecked();
  await page.screenshot({ path: test.info().outputPath('project-file-tree.png'), fullPage: true });
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await dialog.getByRole('button', { name: '插入路径', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const expected = `请检查以下项目文件\n\n${workspace.roots[0]}/src/deep/needle 服务.ts\n${workspace.roots[0]}/README.md`;
  await expect(prompt).toHaveValue(expected);
  await expect(page.getByRole('button', { name: '选择项目文件', exact: true })).toBeFocused();
  const reopened = await openPicker(page);
  await reopened.getByRole('checkbox', { name: '选择文件 README.md', exact: true }).check();
  await reopened.getByRole('button', { name: '插入路径', exact: true }).click();
  await expect(prompt).toHaveValue(expected);
  await page.reload();
  await expect(prompt).toHaveValue(expected);
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/api/workspaces/local/sessions/${ids.modern}/messages`),
  );
  await page.getByRole('button', { name: '追加消息', exact: true }).click();
  const response = await sent;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON().prompt).toBe(expected);
  expect(response.request().postData()).not.toContain('FILE_CONTENT_SHOULD_NOT_BE_SENT');
});

test('new sessions search duplicate filenames, follow the selected project and guard the prompt limit', async ({
  page,
}) => {
  await page.goto(`${workspace.url}/?workspace=local&view=new`);
  const prompt = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true });
  await prompt.fill('x'.repeat(11990));
  let dialog = await openPicker(page);
  await dialog.getByRole('checkbox', { name: '选择文件 README.md', exact: true }).check();
  await dialog.getByRole('button', { name: '插入路径', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('超过 12000 字符');
  await dialog.getByRole('button', { name: '关闭项目文件', exact: true }).click();
  await expect(prompt).toHaveValue('x'.repeat(11990));
  const goal = page.getByRole('checkbox', { name: '将首条消息设为目标', exact: true });
  await goal.check();
  await page.getByRole('textbox', { name: '目标内容', exact: true }).fill('x'.repeat(3990));
  dialog = await openPicker(page);
  await dialog.getByRole('checkbox', { name: '选择文件 README.md', exact: true }).check();
  await dialog.getByRole('button', { name: '插入路径', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('超过 4000 字符');
  await dialog.getByRole('button', { name: '关闭项目文件', exact: true }).click();
  await goal.uncheck();
  const project = page.getByRole('combobox', { name: '新会话项目', exact: true });
  await project.selectOption(otherProjectId);
  dialog = await openPicker(page);
  await expect(dialog.locator('.project-file-root')).toHaveText(workspace.other);
  await expect(
    dialog.getByRole('checkbox', { name: '选择文件 other-project.ts', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('checkbox', { name: '选择文件 README.md', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await project.selectOption(projectId);
  await prompt.fill('检查同名文件');
  dialog = await openPicker(page);
  await dialog.getByRole('textbox', { name: '搜索项目文件名', exact: true }).fill('COMMON');
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await expect(dialog.locator('.project-file-name small')).toHaveText([
    'docs/common.ts',
    'src/common.ts',
  ]);
  await dialog.getByRole('checkbox', { name: '选择文件 docs/common.ts', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '选择文件 src/common.ts', exact: true }).check();
  await page.screenshot({
    path: test.info().outputPath('project-file-search.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: '插入路径', exact: true }).click();
  const expected = `检查同名文件\n\n${workspace.roots[0]}/docs/common.ts\n${workspace.roots[0]}/src/common.ts`;
  await expect(prompt).toHaveValue(expected);
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/workspaces/local/sessions'),
  );
  await page.getByRole('button', { name: '创建并发送', exact: true }).click();
  const response = await sent;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON()).toMatchObject({ projectId, prompt: expected });
});

test('project filename searches run on the selected workspace client', async ({ page }) => {
  for (const [index, id] of ['local', secondId].entries()) {
    await page.goto(`${workspace.url}/?workspace=${id}&session=${ids.modern}`);
    const dialog = await openPicker(page);
    await expect(dialog.locator('.project-file-root')).toHaveText(workspace.roots[index]);
    await dialog.getByRole('textbox', { name: '搜索项目文件名', exact: true }).fill('-only.ts');
    const filename = index ? 'remote-only.ts' : 'local-only.ts';
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);
    await dialog.getByRole('checkbox', { name: `选择文件 ${filename}`, exact: true }).check();
    await dialog.getByRole('button', { name: '插入路径', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true }),
    ).toHaveValue(`${workspace.roots[index]}/${filename}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('file selection recovers from read errors and ignores an outdated search response', async ({
  page,
}) => {
  let failRoot = true;
  await page.route(`**/api/workspaces/local/sessions/${ids.modern}/files?path=`, async (route) => {
    if (failRoot) {
      failRoot = false;
      await route.fulfill({ status: 503, json: { error: '目录暂时不可用' } });
    } else await route.continue();
  });
  await page.goto(`${workspace.url}/?workspace=local&session=${ids.modern}`);
  const prompt = page.getByRole('textbox', { name: '发送给 Codex 的消息', exact: true });
  await prompt.fill('保留当前草稿');
  const dialog = await openPicker(page);
  await expect(dialog.getByRole('alert')).toContainText('目录暂时不可用');
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '选择文件 README.md', exact: true }).check();
  let release!: () => void;
  let finish!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route(
    `**/api/workspaces/local/sessions/${ids.modern}/files?search=needle`,
    async (route) => {
      const response = await route.fetch();
      await hold;
      await route.fulfill({ response }).catch(() => {});
      finish();
    },
  );
  const requested = page.waitForRequest((request) =>
    request.url().endsWith('/files?search=needle'),
  );
  const search = dialog.getByRole('textbox', { name: '搜索项目文件名', exact: true });
  await search.fill('needle');
  await requested;
  await search.fill('common');
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  release();
  await finished;
  await expect(dialog.locator('.project-file-name small')).toHaveText([
    'docs/common.ts',
    'src/common.ts',
  ]);
  await expect(dialog.getByText('已选 1 个文件', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '清空选择', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '插入路径', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(prompt).toHaveValue('保留当前草稿');
});
