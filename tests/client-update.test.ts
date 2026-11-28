import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createMonitorServer } from '../server/server-app.js';
import { requestGuard } from '../server/http/security.js';
import { UPDATE_LOCK } from '../server/maintenance/status.js';
import type { ManagedWorkspace } from '../src/workspaces.js';
import { fixture } from './fixture.js';

test(
  'online update pulls from Git, keeps the old build on failure and reports the replacement after reconnect',
  { timeout: 90_000 },
  async () => {
    const f = fixture();
    const upstream = path.join(f.root, 'upstream');
    const root = path.join(f.root, 'client checkout');
    const lockPath = path.join(root, UPDATE_LOCK);
    const exec = promisify(execFile);
    const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd });
    const service = createMonitorServer({ ...f.config, mode: 'server' });
    const server = createServer(service.app);
    service.gateway.attach(server, requestGuard(f.config));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { workspace, key } = service.gateway.store.create('Update client');
    service.gateway.store.create('Local client', 'local');
    const owner = service.auth.issue(
      await service.auth.setup('owner', 'test-update-password'),
      'test',
    );
    const viewerId = randomUUID();
    service.auth.db
      .prepare('INSERT INTO users VALUES(?,?,?,?,?)')
      .run(viewerId, 'viewer', 'unused', 'viewer', Date.now());
    const viewer = service.auth.issue({ id: viewerId, username: 'viewer', role: 'viewer' }, 'test');
    const start = (token: string, id = workspace.id) =>
      fetch(`${base}/api/workspaces/${id}/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
    const current = () => service.gateway.list().find((item) => item.id === workspace.id);
    let child: ReturnType<typeof spawn> | undefined;
    let output = '';
    const until = async (check: (current: ManagedWorkspace) => unknown) => {
      const deadline = Date.now() + 12_000;
      for (;;) {
        const latest = current();
        if (latest && check(latest)) return latest;
        if (Date.now() > deadline)
          throw new Error(`Client update timed out: ${JSON.stringify(latest)}\n${output}`);
        await delay(30);
      }
    };
    try {
      mkdirSync(upstream);
      await git(upstream, 'init', '-b', 'main');
      await git(upstream, 'config', 'user.name', 'Update Test');
      await git(upstream, 'config', 'user.email', 'update@example.test');
      writeFileSync(
        path.join(upstream, '.gitignore'),
        'dist/\nnode_modules/\n.monitor-update-*\nreplacement.mjs\n',
      );
      writeFileSync(
        path.join(upstream, 'package.json'),
        JSON.stringify({ scripts: { build: 'node build.mjs' } }),
      );
      writeFileSync(path.join(upstream, 'package-lock.json'), '{}');
      writeFileSync(
        path.join(upstream, 'build.mjs'),
        `
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const dist = process.env.MONITOR_BUILD_DIR;
mkdirSync(dist, { recursive: true });
copyFileSync('replacement.mjs', path.join(dist, 'server.mjs'));
writeFileSync(path.join(dist, 'terminal-worker.mjs'), '');
if (existsSync('fail-build')) process.exit(1);
`,
      );
      writeFileSync(path.join(upstream, 'fail-build'), '');
      await git(upstream, 'add', '.');
      await git(upstream, 'commit', '-m', 'Initial build');
      await git(f.root, 'clone', upstream, root);
      symlinkSync(
        path.resolve('node_modules'),
        path.join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const entry = path.join(root, 'dist', 'server.mjs');
      const hash = createHash('sha256');
      for (const name of ['package.json', 'package-lock.json'])
        hash.update(readFileSync(path.join(root, name))).update('\0');
      const dependencies = JSON.stringify(hash.digest('hex'));
      const bundle = (commitAt: number) =>
        build({
          entryPoints: ['server/index.ts'],
          bundle: true,
          write: false,
          platform: 'node',
          format: 'esm',
          packages: 'external',
          define: {
            __MONITOR_BUILD_COMMIT_AT__: String(commitAt),
            __MONITOR_BUILD_DEPENDENCIES__: dependencies,
          },
        });
      const [original, replacement] = await Promise.all([bundle(12345), bundle(54321)]);
      const outputSource = original.outputFiles[0].text;
      mkdirSync(path.dirname(entry));
      writeFileSync(entry, outputSource);
      writeFileSync(path.join(root, 'replacement.mjs'), replacement.outputFiles[0].text);
      const slowLockCleanup = path.join(f.root, 'slow-lock-cleanup.mjs');
      writeFileSync(
        slowLockCleanup,
        `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const rm = fs.rm;
fs.rm = async (file, options) => {
  if (file === ${JSON.stringify(lockPath)}) await delay(400);
  return rm(file, options);
};
syncBuiltinESMExports();
`,
      );
      child = spawn(
        process.execPath,
        [
          '--import',
          pathToFileURL(slowLockCleanup).href,
          entry,
          '--mode',
          'client',
          '--server-url',
          base,
          '--workspace-id',
          workspace.id,
          '--client-key',
          key,
          '--codex-home',
          f.config.codexHome,
          '--data-dir',
          path.join(f.root, 'client data'),
          '--codex-autostart',
          'false',
        ],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stdout!.on('data', (data) => {
        output += data;
      });
      child.stderr!.on('data', (data) => {
        output += data;
      });
      await until((item) => item.online && item.clientUpdateSupported);
      assert.equal((await start(viewer.token)).status, 403);
      assert.equal((await start(owner.token, 'local')).status, 409);
      assert.equal((await start(owner.token)).status, 202);
      assert.equal((await start(owner.token)).status, 409);
      const failed = await until((item) => item.clientUpdate?.phase === 'failed');
      assert.equal(existsSync(lockPath), false, 'Failed update must release its checkout lock');
      assert.equal(failed.online, true);
      assert.equal(failed.buildCommitAt, 12345);
      assert.match(failed.clientUpdate!.message!, /构建失败/);
      assert.equal(readFileSync(entry, 'utf8'), outputSource);

      await git(upstream, 'rm', 'fail-build');
      await git(upstream, 'commit', '-m', 'Fix build');
      assert.equal((await start(owner.token)).status, 202);
      const updated = await until((item) => item.clientUpdate?.phase === 'succeeded');
      assert.equal(existsSync(lockPath), false, 'Successful update must release its checkout lock');
      assert.equal(updated.online, true);
      assert.equal(updated.buildCommitAt, 54321);
      assert.equal(
        (await git(root, 'rev-parse', 'HEAD')).stdout,
        (await git(upstream, 'rev-parse', 'HEAD')).stdout,
      );
      assert.equal(child.exitCode, null);
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.close();
      rmSync(f.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
