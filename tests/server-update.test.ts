import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const pm2Cli = process.env.MONITOR_TEST_PM2_CLI;
const exec = promisify(execFile);

test(
  'PM2 server updates build in the checkout, survive restart, and preserve the running release on failure',
  { timeout: 150_000, skip: !pm2Cli },
  async (t) => {
    if (
      process.platform === 'win32' &&
      (await new Promise<boolean>((resolve) => {
        const pipe = connect('\\\\.\\pipe\\rpc.sock');
        pipe.once('connect', () => {
          pipe.destroy();
          resolve(true);
        });
        pipe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'ENOENT'));
      }))
    )
      return t.skip('PM2 already owns the shared Windows pipe');

    const temporary = mkdtempSync(path.join(os.tmpdir(), 'monitor-pm2-test-'));
    const upstream = path.join(temporary, 'upstream');
    const root = path.join(temporary, 'server checkout');
    const dataDir = path.join(temporary, 'server-data');
    const pm2Home = path.join(temporary, 'pm2');
    const pm2Bin = path.resolve(path.dirname(pm2Cli!), '..', '..', '.bin');
    const address = createServer();
    address.listen(0, '127.0.0.1');
    await once(address, 'listening');
    const port = (address.address() as { port: number }).port;
    await new Promise<void>((resolve) => address.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      PM2_HOME: pm2Home,
      PATH: [pm2Bin, process.env.PATH].join(path.delimiter),
      MONITOR_MODE: 'server',
      MONITOR_DATA_DIR: dataDir,
      MONITOR_HTTPS: 'false',
      HOST: '127.0.0.1',
      PORT: String(port),
    };
    const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, timeout: 15_000 });
    const pm2 = (...args: string[]) =>
      exec(process.execPath, [pm2Cli!, ...args], { cwd: root, env, timeout: 20_000 });
    const updateLog = path.join(dataDir, 'server-update.log');
    const statusFile = path.join(dataDir, 'server-update.json');
    const log = () => (existsSync(updateLog) ? readFileSync(updateLog, 'utf8') : '');
    const status = () =>
      existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, 'utf8')) : null;
    async function until<T>(
      probe: () => T | Promise<T>,
      check: (value: T) => boolean,
      seconds = 20,
    ) {
      const deadline = Date.now() + seconds * 1000;
      do {
        const value = await probe();
        if (check(value)) return value;
        await delay(125);
      } while (Date.now() < deadline);
      assert.fail(`Timed out waiting for server update: ${JSON.stringify(status())}\n${log()}`);
    }
    const health = () =>
      fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })
        .then((response) => response.json())
        .catch(() => null);

    try {
      mkdirSync(upstream);
      await git(upstream, 'init', '-b', 'main');
      await git(upstream, 'config', 'user.name', 'Update Test');
      await git(upstream, 'config', 'user.email', 'update@example.test');
      writeFileSync(
        path.join(upstream, '.gitignore'),
        'dist/\nnode_modules/\n.monitor-update-*\nartifacts/\n',
      );
      writeFileSync(
        path.join(upstream, 'package.json'),
        JSON.stringify({ scripts: { build: 'node build.mjs' } }),
      );
      writeFileSync(path.join(upstream, 'package-lock.json'), '{}');
      writeFileSync(path.join(upstream, 'scenario'), 'build-fails');
      writeFileSync(
        path.join(upstream, 'build.mjs'),
        `
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync } from 'node:fs';
assert.ok(existsSync('.git'), 'npm run build must run in the deployed Git checkout');
assert.equal(process.cwd(), process.env.MONITOR_TEST_CHECKOUT);
const scenario = readFileSync('scenario', 'utf8');
if (scenario === 'build-fails') process.exit(1);
cpSync('artifacts/' + scenario, process.env.MONITOR_BUILD_DIR, { recursive: true });
`,
      );
      await git(upstream, 'add', '.');
      await git(upstream, 'commit', '-m', 'Create update fixture');
      await git(temporary, 'clone', upstream, root);
      const oldDist = path.join(root, 'dist');
      const newDist = path.join(root, 'artifacts', 'new');
      const brokenDist = path.join(root, 'artifacts', 'broken');
      symlinkSync(
        path.resolve('node_modules'),
        path.join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const hash = createHash('sha256');
      for (const file of ['package.json', 'package-lock.json'])
        hash.update(readFileSync(path.join(root, file))).update('\0');
      const dependencies = hash.digest('hex');
      await Promise.all(
        [
          [oldDist, 'old'],
          [newDist, 'new'],
        ].map(async ([dir, id]) => {
          await build({
            entryPoints: {
              server: 'server/index.ts',
              'server-update': 'server/maintenance/worker.ts',
            },
            outdir: dir,
            bundle: true,
            platform: 'node',
            format: 'esm',
            outExtension: { '.js': '.mjs' },
            packages: 'external',
            define: {
              __MONITOR_BUILD_ID__: JSON.stringify(id),
              __MONITOR_BUILD_DEPENDENCIES__: JSON.stringify(dependencies),
            },
          });
          mkdirSync(path.join(dir, 'public'));
          writeFileSync(path.join(dir, 'public', 'index.html'), id);
          writeFileSync(path.join(dir, 'terminal-worker.mjs'), '');
          writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ buildId: id }));
        }),
      );
      mkdirSync(path.join(brokenDist, 'public'), { recursive: true });
      copyFileSync(
        path.join(newDist, 'server-update.mjs'),
        path.join(brokenDist, 'server-update.mjs'),
      );
      writeFileSync(path.join(brokenDist, 'public', 'index.html'), 'broken');
      writeFileSync(path.join(brokenDist, 'terminal-worker.mjs'), '');
      writeFileSync(path.join(brokenDist, 'build.json'), JSON.stringify({ buildId: 'broken' }));
      writeFileSync(
        path.join(brokenDist, 'server.mjs'),
        `process.exit(process.argv.includes('--check-config') ? 0 : 1);`,
      );
      Object.assign(env, { MONITOR_TEST_CHECKOUT: root });
      await pm2(
        'start',
        path.join(oldDist, 'server.mjs'),
        '--name',
        'server',
        '--cwd',
        root,
        '--kill-timeout',
        '1000',
      );
      await until(health, (value) => value?.buildId === 'old');
      const headers = { 'Content-Type': 'application/json' };
      const setup = await fetch(`${base}/api/auth/setup`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          username: 'admin',
          password: 'example-password',
          setupKey: readFileSync(path.join(dataDir, 'setup-key.txt'), 'utf8').trim(),
        }),
      });
      assert.equal(setup.status, 201);
      const authorization = { ...headers, Authorization: `Bearer ${(await setup.json()).token}` };
      const start = () =>
        fetch(`${base}/api/server/update`, { method: 'POST', headers: authorization, body: '{}' });
      const snapshot = () =>
        fetch(`${base}/api/workspaces`, { headers: authorization }).then((res) => res.json());
      const setScenario = async (scenario: string) => {
        writeFileSync(path.join(upstream, 'scenario'), scenario);
        await git(upstream, 'commit', '-am', scenario);
      };
      const unlocked = () =>
        until(
          () => existsSync(path.join(root, '.monitor-update-lock')),
          (exists) => !exists,
        );
      assert.equal((await snapshot()).serverUpdateSupported, true);
      assert.equal((await start()).status, 202);
      assert.equal((await start()).status, 409);
      await until(status, (value) => value?.phase === 'failed');
      assert.match(status().message, /构建/);
      assert.equal((await health()).buildId, 'old');
      await unlocked();

      await setScenario('new');
      assert.equal((await start()).status, 202);
      await until(status, (value) => value?.phase === 'succeeded');
      assert.equal((await health()).buildId, 'new');
      assert.equal((await snapshot()).serverUpdate.phase, 'succeeded');
      await unlocked();

      await setScenario('broken');
      assert.equal((await start()).status, 202);
      await until(status, (value) => value?.phase === 'failed', 65);
      assert.match(status().message, /已恢复上一版本/);
      assert.equal((await health()).buildId, 'new');
      await unlocked();
    } finally {
      if (existsSync(path.join(pm2Home, 'pm2.pid'))) await pm2('kill').catch(console.error);
      rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
