import type { Page } from '@playwright/test';

export const sessionActions = (page: Page) =>
  page.getByRole('button', { name: '更多会话操作', exact: true });

export async function openSessionAction(page: Page, name: string) {
  await sessionActions(page).click();
  await page.getByRole('button', { name, exact: true }).click();
}
