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
