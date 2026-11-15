import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configFromEnv } from '../server/config.js';
import {
  DesktopWatchdog,
  ensureWindowsDesktop,
  type DesktopCheck,
} from '../server/desktop-watchdog.js';

test('a missing desktop starts immediately, gets a startup grace period, and restarts after exit', async () => {
  let now = 1000,
    running = false,
    starts = 0;
  const checks: boolean[] = [];
  const watcher = new DesktopWatchdog(
    { intervalMs: 300000 },
    {
      now: () => now,
      log: () => {},
      ensure: async (allowStart) => {
        checks.push(allowStart);
        if (running) return 'running';
        if (!allowStart) return 'missing';
        starts++;
        return 'started';
      },
    },
  );
  try {
    await watcher.check();
    assert.equal(starts, 1);
    now += 15000;
    await watcher.check();
    now += 15000;
    await watcher.check();
    assert.equal(starts, 1, 'slow startup must not repeatedly launch the desktop');
    running = true;
    await watcher.check();
    now += 30000;
    await watcher.check();
    assert.equal(
      starts,
      1,
      'an existing desktop must not be launched or brought to the foreground',
    );
    running = false;
    await watcher.check();
    assert.equal(starts, 2);
    assert.deepEqual(checks, [true, false, false, false, true, true]);
  } finally {
    await watcher.close();
  }
});

test('periodic checks run without browser requests and never overlap a slow probe', async () => {
  let checks = 0;
  let complete!: (value: DesktopCheck) => void;
  const slow = new Promise<DesktopCheck>((resolve) => {
    complete = resolve;
  });
  const watcher = new DesktopWatchdog(
    { intervalMs: 15 },
    {
      log: () => {},
      ensure: async () => (++checks === 1 ? slow : 'running'),
    },
  );
  try {
    const first = watcher.check();
    assert.equal(watcher.check(), first);
    await delay(70);
    assert.equal(checks, 1);
    complete('running');
    await first;
    const deadline = Date.now() + 2000;
    while (checks < 2 && Date.now() < deadline) await delay(15);
    assert.ok(checks >= 2, 'the timer must resume checking after the slow probe finishes');
    await watcher.close();
    const stoppedAt = checks;
    await delay(50);
    await watcher.check();
    assert.equal(checks, stoppedAt);
  } finally {
    complete('running');
    await watcher.close();
  }
});

test('failed checks do not crash the client or repeatedly retry a possibly dispatched launch', async () => {
  let now = 1000;
  const checks: boolean[] = [],
    notices: string[] = [];
  const watcher = new DesktopWatchdog(
    { intervalMs: 300000 },
    {
      now: () => now,
      log: (message) => notices.push(message),
      ensure: async (allowStart) => {
        checks.push(allowStart);
        if (checks.length === 1) throw new Error('launcher timed out');
        return allowStart ? 'started' : 'missing';
      },
    },
  );
  try {
    await watcher.check();
    assert.ok(notices.some((message) => message.includes('launcher timed out')));
    now += 15000;
    await watcher.check();
    const noticeCount = notices.length;
    now += 15000;
    await watcher.check();
    assert.equal(notices.length, noticeCount, 'unchanged state must not flood the log');
    now += 30000;
    await watcher.check();
    assert.deepEqual(checks, [true, false, false, true]);
  } finally {
    await watcher.close();
  }
});

test('shutdown aborts an in-flight Windows helper and prevents subsequent launches', async () => {
  let checks = 0;
  let signal!: AbortSignal;
  const notices: string[] = [];
  const watcher = new DesktopWatchdog(
    { intervalMs: 300000 },
    {
      log: (message) => notices.push(message),
      ensure: (_allowStart, activeSignal) =>
        new Promise((_resolve, reject) => {
          checks++;
          signal = activeSignal;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    },
  );
  await watcher.close();
  assert.equal(signal.aborted, true);
  await watcher.check();
  assert.equal(checks, 1);
  assert.ok(!notices.some((message) => message.includes('aborted')));
});

test('configuration defaults to Windows clients, supports opt-out and validates overrides', (t) => {
  const keys = [
    'MONITOR_MODE',
    'MONITOR_CODEX_AUTOSTART',
    'MONITOR_CODEX_CHECK_MS',
    'MONITOR_CODEX_DESKTOP',
  ];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of keys) delete process.env[key];
  assert.equal(configFromEnv().desktopAutoStart, process.platform === 'win32');
  assert.equal(configFromEnv().desktopCheckMs, 15000);
  process.env.MONITOR_MODE = 'client';
  assert.equal(configFromEnv().desktopAutoStart, process.platform === 'win32');
  process.env.MONITOR_MODE = 'server';
  assert.equal(configFromEnv().desktopAutoStart, false);
  process.env.MONITOR_MODE = 'standalone';
  process.env.MONITOR_CODEX_AUTOSTART = 'false';
  process.env.MONITOR_CODEX_CHECK_MS = '5000';
  process.env.MONITOR_CODEX_DESKTOP = process.execPath;
  assert.equal(configFromEnv().desktopAutoStart, false);
  assert.equal(configFromEnv().desktopCheckMs, 5000);
  assert.equal(configFromEnv().desktopExecutable, process.execPath);
  process.env.MONITOR_CODEX_AUTOSTART = 'typo';
  assert.throws(configFromEnv, /MONITOR_CODEX_AUTOSTART/);
  process.env.MONITOR_CODEX_AUTOSTART = 'true';
  for (const invalid of ['NaN', '0', '999', '-1', '300001', 'Infinity', '1500.5']) {
    process.env.MONITOR_CODEX_CHECK_MS = invalid;
    assert.throws(configFromEnv, /MONITOR_CODEX_CHECK_MS/);
  }
  process.env.MONITOR_CODEX_CHECK_MS = '15000';
  process.env.MONITOR_CODEX_DESKTOP = 'relative.exe';
  assert.throws(configFromEnv, /MONITOR_CODEX_DESKTOP/);
});

test(
  'Windows helper probes an exact executable and reports a missing installation safely',
  {
    skip: process.platform !== 'win32',
  },
  async () => {
    // Use this test process and an impossible override, never stop or start Codex.
    assert.equal(await ensureWindowsDesktop(true, process.execPath), 'running');
    const missing = path.join(
      os.tmpdir(),
      `codex-monitor-no-desktop-${randomUUID()}`,
      'desktop.exe',
    );
    assert.equal(await ensureWindowsDesktop(false, missing), 'missing');
    await assert.rejects(ensureWindowsDesktop(true, missing), /找不到 Codex 桌面应用/);
  },
);
