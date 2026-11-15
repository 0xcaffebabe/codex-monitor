import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startupFromArgs } from '../server/cli.js';
import { clientConnectionUrl } from '../server/client/config.js';

const key = randomBytes(32).toString('base64url'),
  workspace = randomUUID();
const connectionArgs = ['--server-url', 'ws://localhost:4317', '--workspace-id', workspace];

test('CLI options override inherited settings without mutating the environment', () => {
  const inherited = {
    MONITOR_MODE: 'server',
    MONITOR_SERVER_URL: 'ws://old-server:4317',
    MONITOR_WORKSPACE_ID: randomUUID(),
    MONITOR_CLIENT_KEY_FILE: 'missing-inherited-key-file',
    CODEX_HOME: 'old-home',
    MONITOR_DATA_DIR: 'old-data',
    MONITOR_CODEX_AUTOSTART: 'true',
  };
  const original = { ...inherited };
  const startup = startupFromArgs(
    [
      '--mode=client',
      ...connectionArgs,
      '--client-key',
      key,
      '--codex-home',
      'codex home',
      '--data-dir',
      'client data',
      '--poll-ms',
      '2000',
      '--pricing-file',
      'custom pricing.json',
      '--codex-autostart',
      'false',
      '--codex-check-ms',
      '5000',
      '--codex-desktop',
      process.execPath,
      '--codex-cli',
      'native cli.exe',
      '--codex-pipe',
      'desktop-pipe',
    ],
    inherited,
  );
  assert.equal(startup.help, false);
  if (startup.help) return;
  assert.equal(startup.config.mode, 'client');
  assert.equal(startup.config.codexHome, path.resolve('codex home'));
  assert.equal(startup.config.dataDir, path.resolve('client data'));
  assert.equal(startup.config.pollMs, 2000);
  assert.equal(startup.config.pricingFile, path.resolve('custom pricing.json'));
  assert.equal(startup.config.desktopAutoStart, false);
  assert.equal(startup.config.desktopCheckMs, 5000);
  assert.equal(startup.config.desktopExecutable, process.execPath);
  assert.deepEqual(startup.client, {
    serverUrl: 'ws://localhost:4317',
    workspaceId: workspace,
    key,
  });
  assert.equal(startup.env.MONITOR_CODEX_CLI, 'native cli.exe');
  assert.equal(startup.env.MONITOR_CODEX_PIPE, 'desktop-pipe');
  assert.equal(startup.env.MONITOR_CLIENT_KEY_FILE, undefined);
  assert.deepEqual(inherited, original);
  if (process.platform === 'win32') {
    const mixedCase = startupFromArgs(
      ['--mode', 'client', ...connectionArgs, '--client-key', key],
      {
        monitor_client_key_file: 'missing-inherited-key-file',
        Codex_Home: 'mixed case home',
      },
    );
    if (mixedCase.help) throw new Error('Expected startup settings');
    assert.equal(mixedCase.config.codexHome, path.resolve('mixed case home'));
    assert.equal(mixedCase.env.MONITOR_CLIENT_KEY_FILE, undefined);
  }
});

test('key files accept whitespace and paths with spaces, and explicit sources replace inherited ones', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-cli-key-'));
  const keyFile = path.join(root, 'workspace key.txt');
  writeFileSync(keyFile, `\n${key}\r\n`);
  try {
    for (const explicit of [false, true]) {
      const startup = startupFromArgs(
        [
          '--mode',
          'client',
          ...connectionArgs,
          ...(explicit ? ['--client-key-file', keyFile] : []),
        ],
        { MONITOR_CLIENT_KEY: 'invalid-inherited-key', MONITOR_CLIENT_KEY_FILE: keyFile },
      );
      if (startup.help) throw new Error('Expected startup settings');
      assert.equal(startup.client?.key, key);
      if (explicit) assert.equal(startup.env.MONITOR_CLIENT_KEY, undefined);
    }
    assert.throws(
      () => startupFromArgs(['--client-key', key, '--client-key-file', keyFile], {}),
      /either --client-key or --client-key-file/,
    );
    assert.throws(
      () => startupFromArgs(['--mode', 'client', ...connectionArgs, '--client-key-file', root], {}),
      /Cannot read --client-key-file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('help bypasses invalid environment and defaults preserve standalone/environment startup', () => {
  for (const flag of ['--help', '-h'])
    assert.deepEqual(startupFromArgs([flag], { MONITOR_MODE: 'invalid' }), { help: true });
  const defaults = startupFromArgs([], {});
  if (defaults.help) throw new Error('Expected startup settings');
  assert.equal(defaults.config.mode, 'standalone');
  assert.equal(defaults.config.dataDir, path.resolve('.monitor'));
  const client = startupFromArgs(['--check-config'], {
    MONITOR_MODE: 'client',
    MONITOR_SERVER_URL: 'https://example.com',
    MONITOR_WORKSPACE_ID: workspace,
    MONITOR_CLIENT_KEY: key,
  });
  if (client.help) throw new Error('Expected startup settings');
  assert.equal(client.checkConfig, true);
  assert.equal(client.config.dataDir, path.resolve('.monitor-client'));
  assert.equal(clientConnectionUrl(client.client!).protocol, 'wss:');
});

test('base64url keys beginning with a dash work as ordinary option values', () => {
  const dashKey = '-' + key.slice(1);
  const startup = startupFromArgs(
    ['--mode', 'client', ...connectionArgs, '--client-key', dashKey],
    {},
  );
  if (startup.help) throw new Error('Expected startup settings');
  assert.equal(startup.client?.key, dashKey);
});

test('invalid arguments and connection settings fail without including secret values', () => {
  const cases = [
    { args: ['--mode', 'typo'], pattern: /MONITOR_MODE/ },
    { args: ['--server-url'], pattern: /Invalid command-line/ },
    { args: ['--unknown', key], pattern: /Invalid command-line/ },
    { args: ['--client-key', key, 'extra'], pattern: /Invalid command-line/ },
    { args: ['--data-dir='], pattern: /non-empty/ },
    { args: ['--port', '65536'], pattern: /PORT/ },
    { args: ['--poll-ms', 'NaN'], pattern: /MONITOR_POLL_MS/ },
    { args: ['--poll-ms', '499'], pattern: /MONITOR_POLL_MS/ },
    { args: ['--codex-autostart', 'no'], pattern: /MONITOR_CODEX_AUTOSTART/ },
    { args: ['--codex-check-ms', '999'], pattern: /MONITOR_CODEX_CHECK_MS/ },
    { args: ['--codex-desktop', 'relative.exe'], pattern: /MONITOR_CODEX_DESKTOP/ },
    { args: ['--mode', 'client'], pattern: /--server-url/ },
    { args: ['--mode', 'client', '--server-url', 'ws://localhost'], pattern: /--workspace-id/ },
    {
      args: [
        '--mode',
        'client',
        ...connectionArgs,
        '--workspace-id',
        'a'.repeat(36),
        '--client-key',
        key,
      ],
      pattern: /--workspace-id/,
    },
    { args: ['--mode', 'client', ...connectionArgs], pattern: /--client-key/ },
    {
      args: ['--mode', 'client', ...connectionArgs, '--client-key', 'secret-value'],
      pattern: /--client-key/,
    },
  ];
  for (const { args, pattern } of cases)
    assert.throws(
      () => startupFromArgs(args, {}),
      (error: Error) => {
        assert.match(error.message, pattern);
        assert.ok(!error.message.includes(key));
        assert.ok(!error.message.includes('secret-value'));
        return true;
      },
    );
  for (const serverUrl of [
    'invalid',
    'ftp://server',
    'ws://server/path',
    'ws://server?q=1',
    'ws://server#hash',
    'http://user:secret-value@server',
  ])
    assert.throws(
      () => clientConnectionUrl({ serverUrl, workspaceId: workspace, key }),
      (error: Error) => {
        assert.match(error.message, /--server-url/);
        assert.ok(!error.message.includes('secret-value'));
        return true;
      },
    );
});
