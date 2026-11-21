import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, localTitle, test } from './monitor.js';

test('the mobile project drawer can browse and open projects from another workspace', async ({
  signedIn: { workspace },
  monitor,
}) => {
  const remoteName = '手机测试工作空间';
  const remoteTitle = '远程工作空间项目会话';
  const remote = await monitor.addWorkspace(remoteName, remoteTitle);
  await workspace.showMobileProjects();
  await expect(workspace.projectScope).toHaveValue('');
  await workspace.projectScope.selectOption(remote.id);
  await workspace.projectGroup(remoteName).getByRole('button', { name: '项目：project' }).tap();

  await expect(workspace.navigation).not.toBeInViewport();
  await expect(workspace.sessionScope).toHaveValue(remote.id);
  await expect(workspace.sessionRow(remoteTitle)).toBeVisible();
  await expect(workspace.sessionRow(localTitle)).toHaveCount(0);
});

test('a touch viewport can open a session and return to the list without horizontal overflow', async ({
  signedIn: { session, workspace },
}) => {
  await workspace.tapSession(localTitle);
  await expect(session.heading(localTitle)).toBeVisible();
  await expect(session.message('请开发一个实时会话监控应用。')).toBeVisible();
  expect(await session.hasHorizontalOverflow()).toBe(false);
  await session.tapBackToList();
  await expect(session.detail).toBeHidden();
  await expect(workspace.sessionListHeading).toBeVisible();
  await expect(workspace.sessionRow(localTitle)).toBeVisible();
});

test('a new session shows and switches the selected project branch on mobile', async ({
  signedIn: { browserPage, newSession, session },
  local,
}) => {
  const project = { id: randomUUID(), name: '分支测试', path: path.join(local.data.root, 'branch-project') };
  await mkdir(project.path);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project.path, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('-c', 'user.name=Monitor Test', '-c', 'user.email=monitor@example.test', '-c',
    'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial commit');
  git('branch', 'feature/mobile');
  const projects = await local.control.projects();
  local.control.projects = async () => [...projects, project];

  await newSession.open();
  const branch = browserPage.getByRole('button', { name: /^当前分支：/ });
  await expect(branch).toHaveText('分支不可用');
  await newSession.project(project.name).check();
  await expect(branch).toHaveText('main');
  await expect(branch).toBeInViewport();
  const branchBox = (await branch.boundingBox())!;
  const permissionsBox = (await newSession.permissions.boundingBox())!;
  const draftBox = (await newSession.draft.boundingBox())!;
  expect(branchBox.y).toBeGreaterThan(permissionsBox.y + permissionsBox.height);
  expect(branchBox.y + branchBox.height).toBeLessThan(draftBox.y);

  await branch.tap();
  const dialog = browserPage.getByRole('dialog', { name: '切换 Git 分支' });
  await dialog.getByLabel('目标分支').selectOption('feature/mobile');
  await dialog.getByRole('button', { name: '切换分支', exact: true }).tap();
  await expect(dialog).toBeHidden();
  await expect(branch).toHaveText('feature/mobile');
  expect(git('branch', '--show-current')).toBe('feature/mobile');

  const prompt = '在所选分支开始会话';
  await newSession.createAndSend(prompt);
  await expect(session.message(prompt)).toBeVisible();
  await expect(branch).toHaveCount(0);
  await session.detail.getByRole('button', { name: '更多会话操作' }).tap();
  await expect(session.detail.getByRole('button', { name: '选择 Git 分支' })).toHaveCount(0);
});

test('a loaded session can open workspace changes when further scripts are unavailable', async ({
  signedIn: { browserPage, session, workspace },
  local,
}) => {
  const project = path.join(local.data.root, 'project');
  const change = 'Mobile Git diff regression check';
  execFileSync('git', ['init', '-q'], { cwd: project });
  await writeFile(path.join(project, 'example.txt'), `${change}\n`);
  await workspace.tapSession(localTitle);
  await expect(session.heading(localTitle)).toBeVisible();
  await browserPage.route('**/assets/*.js', (route) => route.abort());

  await session.detail.getByRole('button', { name: '更多会话操作' }).tap();
  await session.detail.getByRole('button', { name: '查看工作区变更' }).tap();
  const dialog = browserPage.getByRole('dialog', { name: '工作区变更', exact: true });
  await expect(dialog.getByRole('table', { name: '逐行代码差异' }).getByText(change)).toBeVisible();
  await dialog.getByRole('button', { name: '关闭代码变更' }).tap();
  await expect(dialog).toBeHidden();
  await expect(session.heading(localTitle)).toBeVisible();
});

test('a linked Markdown report has a full-screen file preview on a phone', async ({
  signedIn: { browserPage, session, workspace },
  local,
}) => {
  await writeFile(path.join(local.data.root, '交付报告.md'), '# 交付结果\n\n**已验收**');
  local.data.append('[交付报告](../交付报告.md)');
  await workspace.tapSession(localTitle);
  await session.detail.getByRole('button', { name: '交付报告', exact: true }).tap();
  const dialog = browserPage.getByRole('dialog', { name: '文件预览' });
  await expect(dialog.getByRole('heading', { name: '交付结果' })).toBeVisible();
  await expect(dialog.getByText('已验收')).toBeVisible();
  expect(await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.width === window.innerWidth && Math.abs(bounds.height - window.innerHeight) <= 1;
  })).toBe(true);
  await dialog.getByRole('button', { name: '关闭文件预览' }).tap();
  await expect(dialog).toBeHidden();
  await expect(session.detail.getByRole('button', { name: '交付报告', exact: true })).toBeVisible();
});
