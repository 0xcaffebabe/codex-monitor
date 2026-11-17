import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { ids } from '../fixture.js';

const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let token = '';
let projects: { repo: string; db: DatabaseSync; restore: () => void }[] = [];
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
const write = (repo: string, file: string, text: string | Buffer) =>
  writeFileSync(path.join(repo, file), text);

test.beforeEach(() => {
  projects = [root, path.join(root, 'client-b')].map((folder, index) => {
    const repo = path.join(folder, 'git review 中文 ' + randomUUID());
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-b', 'review-test');
    git(repo, 'config', 'user.name', 'Review test');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    write(repo, 'src/review.ts', 'export const value = "original";\n');
    write(repo, 'removed.ts', 'export const removed = true;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');
    write(repo, 'src/review.ts', 'export const value = "staged";\n');
    git(repo, 'add', 'src/review.ts');
    write(repo, 'src/review.ts', `export const value = "${index ? 'second' : 'local'}-working";\n`);
    write(repo, '新增 文件.ts', 'export const fresh = true;\n');
    write(repo, 'picture.bin', Buffer.from([0, 1, 2]));
    const db = new DatabaseSync(path.join(folder, 'codex/state_5.sqlite'));
    const previous = db
      .prepare('SELECT cwd,updated_at,updated_at_ms FROM threads WHERE id=?')
      .get(ids.modern)!;
    const history = new DatabaseSync(path.join(folder, 'codex/thread_history_1.sqlite'));
    const items = history.prepare('SELECT * FROM thread_items WHERE thread_id=?').all(ids.modern);
    const turns = history.prepare('SELECT * FROM thread_turns WHERE thread_id=?').all(ids.modern);
    db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(repo, ids.modern);
    return {
      repo,
      db,
      restore: () => {
        // A review is a real message. Restore the conversation as well as its directory.
        history.exec('BEGIN');
        history.prepare('DELETE FROM thread_items WHERE thread_id=?').run(ids.modern);
        history.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(ids.modern);
        for (const item of items)
          history
            .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
            .run(...Object.values(item));
        for (const turn of turns)
          history
            .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
            .run(...Object.values(turn));
        history.exec('COMMIT');
        db.prepare('UPDATE threads SET cwd=?,updated_at=?,updated_at_ms=? WHERE id=?').run(
          previous.cwd!,
          previous.updated_at!,
          previous.updated_at_ms!,
          ids.modern,
        );
        history.close();
        db.close();
      },
    };
  });
});
test.afterEach(() => {
  for (const project of projects) project.restore();
  projects = [];
});

async function visitSession(page: Page, request: APIRequestContext, workspace = 'local') {
  if (
    !token ||
    !(await request.get('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })).ok()
  ) {
    const status = await (await request.get('/api/auth/status')).json();
    const response = await request.post(status.configured ? '/api/auth/login' : '/api/auth/setup', {
      data: {
        username: 'owner',
        password: 'monitor-e2e-password!',
        ...(!status.configured
          ? { setupKey: readFileSync(path.join(root, 'data/setup-key.txt'), 'utf8').trim() }
          : {}),
      },
    });
    expect(response.ok()).toBeTruthy();
    token = (await response.json()).token;
  }
  await page.addInitScript((value) => localStorage.setItem('codex-monitor.auth.v1', value), token);
  await page.goto(`/?workspace=${workspace}&session=${ids.modern}`);
  const project = projects[workspace === 'local' ? 0 : 1];
  const cwd = String(project.db.prepare('SELECT cwd FROM threads WHERE id=?').get(ids.modern)!.cwd);
  await expect(page.locator('.detail-summary-project')).toHaveAttribute('title', cwd);
}

async function enter(page: Page, request: APIRequestContext, workspace = 'local') {
  await visitSession(page, request, workspace);
  await page.getByRole('button', { name: '查看代码变更', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '代码变更', exact: true });
  await expect(
    dialog.getByRole('button', { name: '查看变更：src/review.ts', exact: true }),
  ).toBeVisible();
  return dialog;
}

test('session diff shows real file changes, line numbers, scopes, binary files and read markers', async ({
  page,
  request,
}) => {
  const dialog = await enter(page, request);
  await dialog.getByRole('button', { name: '查看变更：src/review.ts', exact: true }).click();
  await expect(dialog.locator('.git-line.deleted .git-line-code')).toHaveText(
    'export const value = "original";',
  );
  await expect(dialog.locator('.git-line.added .git-line-code')).toHaveText(
    'export const value = "local-working";',
  );
  await expect(dialog.locator('.git-line.added .git-line-number').last()).toHaveText('1');
  await dialog.getByRole('checkbox', { name: '已读', exact: true }).check();
  await expect(dialog.locator('.git-files-heading')).toContainText('已读 1');
  await dialog.getByRole('button', { name: '刷新代码变更', exact: true }).click();
  await expect(dialog.locator('.git-files-heading')).toContainText('已读 0');
  await dialog.getByRole('button', { name: '已暂存', exact: true }).click();
  await expect(dialog.locator('.git-line.added .git-line-code')).toHaveText(
    'export const value = "staged";',
  );
  await expect(
    dialog.getByRole('button', { name: '查看变更：新增 文件.ts', exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: '未暂存', exact: true }).click();
  await expect(dialog.locator('.git-line.deleted .git-line-code')).toHaveText(
    'export const value = "staged";',
  );
  await dialog.getByRole('button', { name: '查看变更：新增 文件.ts', exact: true }).click();
  await expect(dialog.locator('.git-line.added .git-line-code')).toHaveText(
    'export const fresh = true;',
  );
  await dialog.getByRole('button', { name: '查看变更：picture.bin', exact: true }).click();
  await expect(
    dialog.getByText('二进制文件发生变更，无法显示文本 diff。', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('textbox', { name: '筛选变更文件', exact: true }).fill('no-match-file');
  await expect(dialog.getByText('没有匹配的文件', { exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: '筛选变更文件', exact: true }).fill('');
  await dialog.getByRole('button', { name: '查看变更：src/review.ts', exact: true }).click();
  await expect(dialog.locator('.git-line.added .git-line-code')).toContainText('local-working');
  await page.screenshot({ path: test.info().outputPath('git-diff.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看代码变更', exact: true })).toBeFocused();
});

test('a file review goes to the current conversation with the selected Git scope', async ({
  page,
  request,
}) => {
  const dialog = await enter(page, request);
  await dialog.getByRole('button', { name: '已暂存', exact: true }).click();
  await expect(dialog.locator('.git-line.added .git-line-code')).toContainText('staged');
  await dialog.getByRole('button', { name: '审查当前文件', exact: true }).click();
  const prompt = dialog.getByRole('textbox', { name: '审查要求', exact: true });
  await expect(prompt).toHaveValue(/git diff --cached/);
  await expect(prompt).toHaveValue(/仅审查文件："src\/review.ts"/);
  const note = '特别关注边界条件 ' + test.info().project.name + randomUUID();
  await prompt.fill((await prompt.inputValue()) + '\n' + note);
  await page.screenshot({ path: test.info().outputPath('git-review.png'), fullPage: true });
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/api/workspaces/local/sessions/${ids.modern}/messages`),
  );
  await dialog.getByRole('button', { name: '发送审查请求', exact: true }).click();
  expect((await sent).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.timeline .user-message').filter({ hasText: note })).toBeVisible();
  await expect(
    page.locator('.timeline .assistant-message').filter({ hasText: note }),
  ).toBeVisible();
});

test('diff requests and review prompts follow the selected workspace client', async ({
  page,
  request,
}) => {
  const dialog = await enter(page, request, second);
  await expect(dialog.locator('.git-diff-header p')).toHaveText(realpathSync(projects[1].repo));
  await dialog.getByRole('button', { name: '查看变更：src/review.ts', exact: true }).click();
  await expect(dialog.locator('.git-line.added .git-line-code')).toContainText('second-working');
  await expect(dialog.locator('.git-patch')).not.toContainText('local-working');
  await dialog.getByRole('button', { name: '让 Codex 审查', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '审查要求', exact: true })).toHaveValue(
    /client-b/,
  );
  await expect(dialog.getByRole('textbox', { name: '审查要求', exact: true })).toHaveValue(
    /git diff HEAD/,
  );
});

test('clean and non-Git projects have clear states and can recover after refreshing', async ({
  page,
  request,
}) => {
  const dialog = await enter(page, request);
  const { repo, db } = projects[0];
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'clean test repository');
  await dialog.getByRole('button', { name: '刷新代码变更', exact: true }).click();
  await expect(dialog.getByText('当前没有代码变更', { exact: true })).toBeVisible();
  db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(root, ids.modern);
  await dialog.getByRole('button', { name: '刷新代码变更', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('不是可读取的 Git 仓库');
  db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(repo, ids.modern);
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByText('当前没有代码变更', { exact: true })).toBeVisible();
  write(repo, 'src/review.ts', 'export const value = "recovered";\n');
  await dialog.getByRole('button', { name: '刷新代码变更', exact: true }).click();
  await expect(dialog.locator('.git-line.added .git-line-code')).toContainText('recovered');
});

test('session branches refuse conflicting edits, then switch the actual project and update the header', async ({
  page,
  request,
}) => {
  const { repo } = projects[0];
  const target = 'feature/中文-' + 'long-branch-name-'.repeat(5);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base for branch switching');
  git(repo, 'switch', '-c', target);
  write(repo, 'src/review.ts', 'export const value = "feature";\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'feature branch');
  git(repo, 'switch', 'review-test');
  write(repo, 'src/review.ts', 'export const value = "unsaved-work";\n');
  await visitSession(page, request);
  const trigger = page.getByRole('button', { name: '选择 Git 分支', exact: true });
  await expect(trigger).toHaveText('review-test');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '切换 Git 分支', exact: true });
  const select = dialog.getByRole('combobox', { name: '目标分支', exact: true });
  const submit = dialog.getByRole('button', { name: '切换分支', exact: true });
  await expect(select).toHaveValue('review-test');
  await expect(submit).toBeDisabled();
  await select.selectOption(target);
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText('src/review.ts');
  expect(git(repo, 'branch', '--show-current').trim()).toBe('review-test');
  expect(readFileSync(path.join(repo, 'src/review.ts'), 'utf8')).toContain('unsaved-work');
  await page.screenshot({
    path: test.info().outputPath('git-branch-conflict.png'),
    fullPage: true,
  });
  write(repo, 'src/review.ts', 'export const value = "local-working";\n');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toHaveText(target);
  await expect(trigger).toBeFocused();
  expect(git(repo, 'branch', '--show-current').trim()).toBe(target);
  expect(readFileSync(path.join(repo, 'src/review.ts'), 'utf8')).toContain('feature');
  expect(git(projects[1].repo, 'branch', '--show-current').trim()).toBe('review-test');
  await page.screenshot({
    path: test.info().outputPath('git-branch-switched.png'),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '查看代码变更', exact: true }).click();
  await expect(page.locator('.git-diff-branch')).toHaveText(target);
});

test('branch changes follow the selected workspace and refresh after external Git operations', async ({
  page,
  request,
}) => {
  const { repo } = projects[1];
  git(repo, 'branch', 'feature/second-client');
  await visitSession(page, request, second);
  const trigger = page.getByRole('button', { name: '选择 Git 分支', exact: true });
  await expect(trigger).toHaveText('review-test');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '切换 Git 分支', exact: true });
  await expect(dialog.locator('.git-branch-header p')).toHaveText(realpathSync(repo));
  await dialog
    .getByRole('combobox', { name: '目标分支', exact: true })
    .selectOption('feature/second-client');
  const switched = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/api/workspaces/${second}/sessions/${ids.modern}/git/branch`),
  );
  await dialog.getByRole('button', { name: '切换分支', exact: true }).click();
  expect((await switched).ok()).toBe(true);
  await expect(trigger).toHaveText('feature/second-client');
  expect(git(projects[0].repo, 'branch', '--show-current').trim()).toBe('review-test');
  expect(git(repo, 'branch', '--show-current').trim()).toBe('feature/second-client');
  git(repo, 'checkout', '--detach');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(trigger).toHaveAttribute('title', /分离 HEAD/);
  await trigger.click();
  await expect(dialog.locator('.git-branch-current')).toContainText('分离 HEAD');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('branch discovery explains non-Git directories and recovers after refreshing', async ({
  page,
  request,
}) => {
  const { db } = projects[0];
  const repo = path.join(root, 'initially non-Git ' + randomUUID());
  mkdirSync(repo);
  db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(repo, ids.modern);
  await visitSession(page, request);
  const trigger = page.getByRole('button', { name: '选择 Git 分支', exact: true });
  await expect(trigger).toHaveText('Git 不可用');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '切换 Git 分支', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('不是可读取的 Git 仓库');
  git(repo, 'init', '-b', 'review-test');
  git(repo, 'config', 'user.name', 'Branch test');
  git(repo, 'config', 'user.email', 'branch@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'initial.txt', 'initial\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  await expect(dialog.getByRole('button', { name: '刷新 Git 分支', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '刷新 Git 分支', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '目标分支', exact: true })).toHaveValue(
    'review-test',
  );
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(trigger).toHaveText('review-test');
  await page.screenshot({
    path: test.info().outputPath('git-branch-selector.png'),
    fullPage: true,
  });
});
