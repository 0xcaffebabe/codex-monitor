import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivacyWork } from '../server/client/privacy-work.js';

test('privacy work runs immediately on manual enable, repeats, and cancels on disable', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const commands: AbortSignal[] = [];
  const privacyWork = new PrivacyWork(async (signal) => {
    commands.push(signal);
  });
  try {
    privacyWork.setEnabled(true, { runImmediately: true });
    assert.equal(commands.length, 1);
    await Promise.resolve();

    t.mock.timers.tick(59_999);
    privacyWork.setEnabled(true, { runImmediately: true });
    assert.equal(commands.length, 1);

    t.mock.timers.tick(1);
    assert.equal(commands.length, 2);
    await Promise.resolve();

    t.mock.timers.tick(60_000);
    assert.equal(commands.length, 3);
    privacyWork.setEnabled(false);
    assert.equal(commands[2].aborted, true);

    privacyWork.setEnabled(true, { runImmediately: true });
    assert.equal(commands.length, 4);
    await Promise.resolve();
    privacyWork.setEnabled(false);
    t.mock.timers.tick(120_000);
    assert.equal(commands.length, 4);
  } finally {
    privacyWork.setEnabled(false);
  }
});

test('restoring privacy work on reconnect waits 60 seconds before running', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const commands: AbortSignal[] = [];
  const privacyWork = new PrivacyWork(async (signal) => {
    commands.push(signal);
  });
  try {
    privacyWork.setEnabled(true);
    t.mock.timers.tick(59_999);
    assert.equal(commands.length, 0);
    t.mock.timers.tick(1);
    assert.equal(commands.length, 1);
  } finally {
    privacyWork.setEnabled(false);
  }
});
