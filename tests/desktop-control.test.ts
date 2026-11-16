import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopControl } from '../server/desktop-control.js';
import { NativeDesktopControl } from '../server/native-control.js';
import { DesktopBridge } from '../server/desktop.js';
import { NativeRpc } from '../server/native.js';

const options = { codexHome: '/unused/codex', activity: () => undefined };

for (const platform of ['win32', 'darwin'] as const) {
  test(`${platform} exposes native creation permissions and web approvals without a desktop context`, async (t) => {
    const calls: string[] = [];
    t.mock.method(NativeRpc.prototype, 'request', async (method: string) => {
      calls.push(method);
      return { data: [{ id: 'project', name: '项目', roots: [{ path: '/project' }] }] };
    });
    const control = createDesktopControl(options, { platform, env: {} });
    try {
      assert.ok(control instanceof NativeDesktopControl);
      assert.equal(control.contextRequired, false);
      assert.equal(control.creationPermissions, true);
      assert.deepEqual(control.approvals?.list('thread'), []);
      assert.deepEqual(await control.projects(''), [
        { id: 'project', name: '项目', path: '/project' },
      ]);
      assert.deepEqual(calls, ['project/list']);
    } finally {
      control.close?.();
    }
  });

  test(`${platform} keeps an explicitly configured desktop tools pipe as a legacy option`, () => {
    const control = createDesktopControl(options, {
      platform,
      env: { MONITOR_CODEX_PIPE: 'explicit-tools-pipe' },
    });
    try {
      assert.equal(control.approvals, undefined);
      assert.equal(control.creationPermissions, undefined);
      assert.ok(control instanceof DesktopBridge);
    } finally {
      control.close?.();
    }
  });
}

test('other platforms keep their existing desktop bridge', () => {
  const control = createDesktopControl(options, { platform: 'linux', env: {} });
  try {
    assert.ok(control instanceof DesktopBridge);
  } finally {
    control.close?.();
  }
});
