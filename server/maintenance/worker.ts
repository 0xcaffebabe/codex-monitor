import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { UpdateStatus } from '../../src/workspaces.js';
import { dependencyHash, prepareDependencyInstall } from './build.js';
import { UPDATE_LOCK, writeUpdateStatus, type ServerUpdateJob } from './status.js';

const root = process.cwd();
const appName = 'server';
const exec = promisify(execFile);
const windows = process.platform === 'win32';

async function command(
  tool: 'git' | 'npm' | 'pm2' | 'node',
  args: string[],
  cwd = root,
  buildDir?: string,
) {
  // The npm and PM2 arguments are fixed literals. Paths are passed as cwd, env or Node args.
  const cmd = windows && (tool === 'npm' || tool === 'pm2');
  const executable = tool === 'node' ? process.execPath : cmd ? 'cmd.exe' : tool;
  const argv = cmd ? ['/d', '/s', '/c', [tool, ...args].join(' ')] : args;
  const output = await exec(executable, argv, {
    cwd,
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      GIT_TERMINAL_PROMPT: '0',
      MONITOR_BUILD_DIR: buildDir,
    },
    timeout: tool === 'npm' ? 600_000 : tool === 'git' ? 120_000 : 45_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  }).catch((error: Error & { stdout?: string; stderr?: string }) => {
    // PM2 process listings can include application environment variables.
    if (tool !== 'pm2') console.error(error.stdout ?? '', error.stderr ?? '');
    throw new Error(`${tool} ${args[0]} failed`);
  });
  if (tool !== 'pm2') {
    if (output.stdout) process.stdout.write(output.stdout);
    if (output.stderr) process.stderr.write(output.stderr);
  }
  return output.stdout;
}

async function verifyPm2(pmId: number) {
  const processes: { name: string; pm_id: number; pm2_env: { pm_cwd: string; status: string } }[] =
    JSON.parse(await command('pm2', ['jlist']));
  const matching = processes.filter((app) => app.name === appName);
  if (
    !matching.some((app) => app.pm_id === pmId && app.pm2_env.status === 'online') ||
    matching.some(
      (app) => path.relative(realpathSync(root), realpathSync(app.pm2_env.pm_cwd)) !== '',
    )
  ) {
    throw new Error('PM2 app server does not match this deployment');
  }
}

function checkBuild(url: string, buildId: string) {
  return new Promise<void>((resolve, reject) => {
    const fail = (message: string, cause?: unknown) =>
      reject(new Error(`Health check at ${url}: ${message}`, { cause }));
    const get = url.startsWith('https:') ? httpsGet : httpGet;
    const request = get(
      url,
      {
        // The local listener must be checked directly, even when Node uses an environment proxy.
        agent: false,
        // Verify the expected build on the local listener, including self-signed community deployments.
        rejectUnauthorized: false,
        signal: AbortSignal.timeout(2000),
      },
      (response) => {
        if (response.statusCode !== 200) {
          fail(`HTTP ${response.statusCode}`);
          response.destroy();
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 16_384) {
            fail('response exceeded the size limit');
            response.destroy();
          }
        });
        response.on('error', (error) => fail('response failed', error));
        response.on('end', () => {
          let status;
          try {
            status = JSON.parse(body);
          } catch {
            fail('invalid JSON response');
            return;
          }
          if (status?.ok !== true || status.app !== 'codex-monitor') {
            fail('response did not identify a healthy Codex Monitor server');
          } else if (status.buildId !== buildId) {
            fail(`build ID did not match the expected build (${buildId})`);
          } else {
            resolve();
          }
        });
      },
    );
    request.on('error', (error) => fail('request failed', error));
  });
}

async function waitForBuild(url: string, buildId: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await checkBuild(url, buildId);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await delay(500);
  }
}

async function update(job: ServerUpdateJob) {
  const publish = (phase: UpdateStatus['phase'], message?: string) =>
    writeUpdateStatus(job.dataDir, { phase, message });
  let stage: string | undefined;
  let stopped = false;
  let restarted = false;
  let failure = '无法确认 PM2 应用 server，请查看服务端更新日志。';
  const rollback: (() => Promise<void>)[] = [];

  async function stop() {
    if (stopped) return;
    await verifyPm2(job.pmId);
    stopped = true;
    await command('pm2', ['stop', appName]);
  }

  async function promote(source: string, target: string, backup: string) {
    if (existsSync(target)) {
      await rename(target, backup);
      rollback.push(() => rename(backup, target));
    }
    await rename(source, target);
    rollback.push(() => rename(target, source));
  }

  try {
    await verifyPm2(job.pmId);
    failure = '当前版本的本机健康检查失败，请查看服务端更新日志。';
    await waitForBuild(job.healthUrl, job.buildId, 5_000);
    stage = await mkdtemp(path.join(root, '.monitor-update-'));
    failure = '拉取失败，请检查服务端的 Git 上游、凭据和工作区。';
    publish('pulling');
    await command('git', ['diff', '--quiet', 'HEAD', '--']);
    await command('git', ['pull', '--ff-only']);

    const modules = path.join(root, 'node_modules');
    if (dependencyHash(root) !== job.dependencies || !existsSync(modules)) {
      failure = '安装或切换依赖失败，请查看服务端更新日志。';
      publish('installing');
      await prepareDependencyInstall(root, stage);
      await command('npm', ['ci', '--include=dev', '--no-fund'], stage);
      await stop();
      await promote(
        path.join(stage, 'node_modules'),
        modules,
        path.join(stage, 'previous-node_modules'),
      );
    }
    failure = '构建或配置检查失败，请查看服务端更新日志。';
    publish('building');
    const stagedDist = path.join(stage, 'dist');
    await command('npm', ['run', 'build'], root, stagedDist);
    const manifest = JSON.parse(readFileSync(path.join(stagedDist, 'build.json'), 'utf8'));
    if (
      typeof manifest.buildId !== 'string' ||
      manifest.buildId === job.buildId ||
      !existsSync(path.join(stagedDist, 'public', 'index.html')) ||
      !existsSync(path.join(stagedDist, 'server-update.mjs')) ||
      !existsSync(path.join(stagedDist, 'terminal-worker.mjs'))
    )
      throw new Error('Incomplete server build');
    await command('node', [path.join(stagedDist, 'server.mjs'), '--check-config']);

    failure = 'PM2 重启或新版本健康检查失败。';
    publish('restarting');
    await stop();
    await promote(stagedDist, path.join(root, 'dist'), path.join(stage, 'previous-dist'));
    restarted = true;
    await command('pm2', ['restart', appName]);
    await waitForBuild(job.healthUrl, manifest.buildId);
    publish('succeeded');
  } catch (error) {
    console.error('[server update]', error);
    if (stopped) {
      try {
        if (restarted) await command('pm2', ['stop', appName]);
        for (const undo of rollback.reverse()) await undo();
        await command('pm2', ['restart', appName]);
        await waitForBuild(job.healthUrl, job.buildId);
        failure += ' 已恢复上一版本。';
      } catch (rollbackError) {
        console.error('[server update] Recovery failed. Backup directory:', stage, rollbackError);
        stage = undefined;
        failure += ' 自动恢复失败，请查看服务端更新日志。';
      }
    }
    publish('failed', failure);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(console.error);
    await rm(path.join(root, UPDATE_LOCK), { force: true });
  }
}

const job = JSON.parse(process.env.MONITOR_PM2_UPDATE_JOB || 'null') as ServerUpdateJob | null;
if (!job) throw new Error('Missing server update job');

if (process.argv[2] === '--detach') {
  // Let this bridge exit before PM2 stops its process tree. The updater continues independently.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await once(child, 'spawn');
  child.unref();
} else {
  delete process.env.MONITOR_PM2_UPDATE_JOB;
  await update(job);
}
