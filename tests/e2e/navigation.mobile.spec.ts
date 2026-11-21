import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, localTitle, test } from './monitor.js';

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
