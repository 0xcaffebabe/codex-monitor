import { ids } from '../fixture.js';
import { expect, localTitle, test } from './monitor.js';

test('two clients with the same session ID isolate draft, history and message delivery', async ({
  signedIn: { session, workspace },
  monitor,
  local,
}) => {
  const remoteTitle = '第二个工作空间的会话';
  const other = await monitor.addWorkspace('第二个工作空间', remoteTitle);
  await session.open(local.id, ids.modern);
  const draft = '本机工作空间的草稿';
  await session.writeDraft(draft);

  await workspace.switchTo(other.id);
  await workspace.openSession(remoteTitle);
  await expect(session.heading(remoteTitle)).toBeVisible();
  expect(session.currentId()).toBe(ids.modern);
  await expect(session.draft).toBeEmpty();
  const message = '只发给第二个工作空间';
  await session.sendMessage(message);
  await expect(session.message(`测试回复：${message}`)).toBeVisible();

  await workspace.switchTo(local.id);
  await workspace.openSession(localTitle);
  await expect(session.heading(localTitle)).toBeVisible();
  await expect(session.draft).toHaveValue(draft);
  await expect(session.timeline).not.toContainText(message);
  expect(local.control.sends).toBe(0);
  expect(other.control.sends).toBe(1);
});
