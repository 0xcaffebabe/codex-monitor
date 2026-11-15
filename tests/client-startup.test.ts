import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  copyFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { createMonitorServer } from '../server/server-app.js';
import { requestGuard } from '../server/http/security.js';
import { fixture, ids } from './fixture.js';

const exec = promisify(execFile);
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^MONITOR_|^(?:HOST|PORT|CODEX_HOME)$/i.test(name),
  ),
);

test(
  'built client entrypoint and Windows background launcher connect using command-line configuration',
  { timeout: 90000 },
  async () => {
    const f = fixture();
    const project = path.join(f.root, 'launcher project');
    const directData = path.join(project, 'direct client data');
    const backgroundData = path.join(project, 'background client data');
    mkdirSync(path.join(project, 'dist'), { recursive: true });
    symlinkSync(
      path.resolve('node_modules'),
      path.join(project, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await build({
      entryPoints: ['server/index.ts'],
      outfile: path.join(project, 'dist/server.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
    });
    const service = createMonitorServer({
      ...f.config,
      mode: 'server',
      dataDir: path.join(f.root, 'central'),
    });
    const server = createServer(service.app);
    service.gateway.attach(server, requestGuard(f.config));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const registration = service.gateway.store.create('CLI client');
    const auth = service.auth.issue(
      await service.auth.setup('owner', 'cli-startup-password'),
      'test',
    );
    const args = [
      '--mode',
      'client',
      '--server-url',
      base,
      '--workspace-id',
      registration.workspace.id,
      '--client-key',
      registration.key,
      '--codex-home',
      f.config.codexHome,
      '--data-dir',
      directData,
      '--codex-autostart',
      'false',
    ];
    const entry = path.join(project, 'dist/server.mjs');
    let child: ReturnType<typeof spawn> | undefined;
    let output = '';
    const ps = (script: string, parameters: string[]) =>
      exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(project, script),
          ...parameters,
        ],
        { env: cleanEnv, timeout: 15000 },
      );
    const batch = (command: string) =>
      exec('cmd.exe', ['/d', '/s', '/c', command], {
        cwd: project,
        env: cleanEnv,
        windowsVerbatimArguments: true,
        timeout: 15000,
      });
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`Client did not connect: ${output}`);
        await delay(40);
      }
    };
    try {
      const checked = await exec(process.execPath, [entry, ...args, '--check-config'], {
        env: cleanEnv,
      });
      assert.match(checked.stdout, /Configuration valid \(client\)/);
      assert.equal(existsSync(directData), false, 'validation must not create runtime data');
      const help = await exec(process.execPath, [entry, '--help'], {
        env: { ...cleanEnv, MONITOR_MODE: 'invalid' },
      });
      assert.match(help.stdout, /--server-url/);
      await assert.rejects(
        exec(process.execPath, [entry, '--mode', 'client', '--data-dir', directData], {
          env: cleanEnv,
        }),
        (error: Error & { stderr: string }) => {
          assert.match(error.stderr, /Startup failed: Client requires --server-url/);
          assert.doesNotMatch(error.stderr, /at startupFromArgs/);
          return true;
        },
      );
      assert.equal(existsSync(directData), false);
      child = spawn(process.execPath, [entry, ...args], {
        env: {
          ...cleanEnv,
          MONITOR_MODE: 'server',
          MONITOR_CLIENT_KEY_FILE: 'missing-inherited-key',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', (data) => {
        output += data;
      });
      child.stderr!.on('data', (data) => {
        output += data;
      });
      await until(
        () =>
          !!service.gateway.list().find((item) => item.id === registration.workspace.id)?.online,
      );
      const session = await fetch(
        `${base}/api/workspaces/${registration.workspace.id}/sessions/${ids.modern}`,
        { headers: { Authorization: `Bearer ${auth.token}` } },
      );
      assert.equal(session.status, 200);
      assert.equal((await session.json()).session.id, ids.modern);
      assert.equal(existsSync(path.join(directData, 'monitor.sqlite')), true);
      assert.ok(!output.includes(registration.key), 'connection logs must not contain the key');
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      child = undefined;

      if (process.platform === 'win32') {
        for (const script of ['start.ps1', 'start.cmd', 'stop.ps1', 'stop.cmd'])
          copyFileSync(script, path.join(project, script));
        writeFileSync(
          path.join(project, '.env'),
          'MONITOR_MODE=server\nMONITOR_SERVER_URL=ws://invalid\nMONITOR_CLIENT_KEY_FILE=missing-file\n',
        );
        const keyFile = path.join(project, 'private client key.txt');
        writeFileSync(keyFile, registration.key + '\r\n');
        const parameters = [
          '-Mode',
          'client',
          '-ServerUrl',
          base,
          '-WorkspaceId',
          registration.workspace.id,
          '-ClientKeyFile',
          keyFile,
          '-CodexHome',
          f.config.codexHome,
          '-DataDir',
          backgroundData,
          '-CodexAutoStart',
          'false',
        ];
        const inheritedCheck = await exec(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(project, 'start.ps1'),
            '-Mode',
            'Client',
            '-ServerUrl',
            base,
            '-WorkspaceId',
            registration.workspace.id,
            '-CodexAutoStart',
            'False',
            '-CheckConfig',
          ],
          { env: { ...cleanEnv, MONITOR_CLIENT_KEY: registration.key } },
        );
        assert.match(inheritedCheck.stdout, /Configuration valid \(client\)/);
        await until(
          () =>
            !service.gateway.list().find((item) => item.id === registration.workspace.id)?.online,
        );
        const started = await batch(
          `start.cmd ${parameters.map((value) => `"${value}"`).join(' ')}`,
        );
        assert.match(started.stdout, /client started/);
        await until(
          () =>
            !!service.gateway.list().find((item) => item.id === registration.workspace.id)?.online,
        );
        const stateFile = path.join(backgroundData, 'server-process.json');
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        assert.ok(state.settingsHash);
        assert.ok(!readFileSync(stateFile, 'utf8').includes(registration.key));
        assert.equal(
          existsSync(path.join(project, '.monitor')),
          false,
          'client launch must not reuse standalone process state',
        );
        const repeated = await ps('start.ps1', parameters);
        assert.match(repeated.stdout, /client is already running/);
        assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).pid, state.pid);
        // Older launcher records have no build hash; a newer bundle still needs a restart.
        delete state.buildHash;
        writeFileSync(stateFile, JSON.stringify(state));
        appendFileSync(entry, '\n// Updated build\n');
        const updated = await ps('start.ps1', parameters);
        assert.match(updated.stdout, /Restarting Codex Monitor to apply the current build/);
        const updatedState = JSON.parse(readFileSync(stateFile, 'utf8'));
        assert.notEqual(updatedState.pid, state.pid);
        assert.ok(updatedState.buildHash);
        writeFileSync(
          path.join(project, 'package.json'),
          JSON.stringify({ scripts: { build: 'node --check dist/server.mjs' } }),
        );
        const rebuilt = await ps('start.ps1', [...parameters, '-Build']);
        assert.match(rebuilt.stdout, /Restarting Codex Monitor to apply the current build/);
        assert.notEqual(JSON.parse(readFileSync(stateFile, 'utf8')).pid, updatedState.pid);
        await until(
          () =>
            !!service.gateway.list().find((item) => item.id === registration.workspace.id)?.online,
        );
        await assert.rejects(
          ps('start.ps1', [...parameters, '-PollMs', '2000']),
          (error: Error & { stderr: string }) => {
            assert.match(error.stderr, /already running with other settings/);
            return true;
          },
        );
        writeFileSync(keyFile, 'A'.repeat(43));
        await assert.rejects(ps('start.ps1', parameters), (error: Error & { stderr: string }) => {
          assert.match(error.stderr, /already running with other settings/);
          return true;
        });
        const batchHelp = await batch('start.cmd -Help -OpenBrowser');
        assert.match(batchHelp.stdout, /Windows background launcher/);
        await assert.rejects(
          batch(
            'start.cmd -Mode client -ServerUrl ws://localhost -WorkspaceId invalid -ClientKey invalid -CheckConfig',
          ),
          (error: Error & { code: number; stdout: string; stderr: string }) => {
            assert.equal(error.code, 1);
            assert.match(error.stderr, /--workspace-id/);
            assert.doesNotMatch(error.stdout, /Press any key/);
            return true;
          },
        );
        await batch(`stop.cmd -Mode client -DataDir "${backgroundData}"`);
        assert.equal(existsSync(stateFile), false, 'batch stop must forward client parameters');
      }
    } finally {
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      if (
        process.platform === 'win32' &&
        existsSync(path.join(backgroundData, 'server-process.json'))
      )
        await ps('stop.ps1', ['-Mode', 'client', '-DataDir', backgroundData]);
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
