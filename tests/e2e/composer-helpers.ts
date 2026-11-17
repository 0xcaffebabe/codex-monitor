import { expect, type Locator, type Page } from '@playwright/test';

export async function openComposerMenu(root: Page | Locator, label: string) {
  for (const other of ['添加内容', '快捷操作', '发送设置']) {
    if (other !== label) await closeComposerMenu(root, other);
  }
  const panel = root.getByRole('dialog', { name: label, exact: true });
  if (!(await panel.isVisible()))
    await root.getByRole('button', { name: label, exact: true }).click();
  await expect(panel).toBeVisible();
  return panel;
}

export async function closeComposerMenu(root: Page | Locator, label: string) {
  const panel = root.getByRole('dialog', { name: label, exact: true });
  if (await panel.isVisible())
    await panel.getByRole('button', { name: `关闭${label}`, exact: true }).click();
  await expect(panel).toBeHidden();
}

export async function openReferencePicker(page: Page) {
  const menu = await openComposerMenu(page, '添加内容');
  await menu.getByRole('button', { name: '引用会话', exact: true }).click();
}
