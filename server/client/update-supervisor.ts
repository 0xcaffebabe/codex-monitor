import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildDependencies } from '../build-info.js';
import { dependencyHash, prepareDependencyInstall } from '../maintenance/build.js';
import { UPDATE_LOCK } from '../maintenance/status.js';
import type { UpdateStatus } from './update-channel.js';

const windows = process.platform === 'win32';

function run(
  command: 'git' | 'npm',
  args: string[],
  cwd: string,
  signal: AbortSignal,
  buildDir?: string,
) {
  const git = command === 'git';
  // Windows needs cmd.exe for npm.cmd. Only the fixed npm arguments below reach the shell.
  const shell = windows && !git;
  const child = spawn(
    shell ? 'cmd.exe' : command,
    shell ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args,
    {
      cwd,
      env: {
        ...process.env,
        PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        GIT_TERMINAL_PROMPT: '0',
        MONITOR_BUILD_DIR: buildDir,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      detached: !windows,
    },
  );
  const stop = () => {
    if (!child.pid) return;
    if (windows) {
      const kill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      kill.on('error', () => child.kill());
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* exited */
      }
    }
  };
  const timer = setTimeout(stop, git ? 120_000 : 600_000);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return once(child, 'close')
    .then(([code]) => {
      if (code !== 0 || signal.aborted)
        throw new Error(`${command} ${args.join(' ')} failed (${code})`);
    })
    .finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    });
}

/** Keep the original PID, arguments and stdio for both foreground and background launchers. */
export async function superviseClient(root: string, entry: string) {
  const dist = path.join(root, 'dist');
  const modules = path.join(root, 'node_modules');
  const abort = new AbortController();
  let worker: ChildProcess | undefined;
  let job: Promise<void> | undefined;
  let status: UpdateStatus | undefined;
  let installed = buildDependencies ?? dependencyHash(root);

  function notify(child: ChildProcess | undefined, message: object) {
    if (child?.connected) child.send(message, () => {});
  }

  function publish(next: UpdateStatus) {
    status = next;
    notify(worker, { type: 'update-status', status });
  }

  async function stopWorker() {
    const child = worker;
    worker = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const exited = once(child, 'exit');
    notify(child, { type: 'stop' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  async function launch() {
    abort.signal.throwIfAborted();
    const child = fork(entry, process.argv.slice(2), {
      cwd: root,
      env: { ...process.env, MONITOR_CLIENT_WORKER: '1' },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    worker = child;
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Client startup timed out')), 30_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      child.on('message', (message: { type?: string; id?: string }) => {
        if (worker !== child) return;
        if (message?.type === 'started') {
          if (status) notify(child, { type: 'update-status', status });
          finish();
        } else if (message?.type === 'update' && typeof message.id === 'string') {
          const id = message.id;
          if (status?.id === id) return;
          if (job) {
            notify(child, {
              type: 'update-status',
              status: { id, phase: 'failed', message: '客户端已有更新任务在运行。' },
            });
            return;
          }
          // A terminal status lets the Server accept another update immediately.
          job = update(id)
            .finally(() => {
              job = undefined;
            })
            .then(publish);
        }
      });
      child.once('error', finish);
      child.once('exit', (code, signal) => {
        finish(new Error(`Client exited (${code ?? signal})`));
        if (worker === child) {
          worker = undefined;
          if (!job && !abort.signal.aborted) process.exitCode = code ?? 1;
        }
      });
    });
    await started;
  }

  async function update(id: string): Promise<UpdateStatus> {
    const lockPath = path.join(root, UPDATE_LOCK);
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let stage: string | undefined;
    let failure = '此目录已有更新任务在运行。';
    const rollback: (() => Promise<void>)[] = [];
    try {
      lock = await open(lockPath, 'wx');
      stage = await mkdtemp(path.join(root, '.monitor-update-'));
      const stagedDist = path.join(stage, 'dist');
      failure = '拉取失败，请检查客户端的 Git 上游、凭据和工作区。';
      publish({ id, phase: 'pulling' });
      await run('git', ['pull', '--ff-only'], root, abort.signal);
      const nextDependencies = dependencyHash(root);
      if (installed !== nextDependencies || !existsSync(modules)) {
        failure = '安装依赖失败，请查看客户端日志。';
        publish({ id, phase: 'installing' });
        await prepareDependencyInstall(root, stage);
        await run('npm', ['ci', '--include=dev', '--no-fund'], stage, abort.signal);
        abort.signal.throwIfAborted();
        await stopWorker();
        const backup = path.join(stage, 'previous-node_modules');
        if (existsSync(modules)) {
          await rename(modules, backup);
          rollback.push(() => rename(backup, modules));
        }
        await rename(path.join(stage, 'node_modules'), modules);
        rollback.push(() => rename(modules, path.join(stage!, 'node_modules')));
      }

      failure = '构建失败，请查看客户端日志。';
      publish({ id, phase: 'building' });
      await run('npm', ['run', 'build'], root, abort.signal, stagedDist);
      if (
        !existsSync(path.join(stagedDist, 'server.mjs')) ||
        !existsSync(path.join(stagedDist, 'terminal-worker.mjs'))
      )
        throw new Error('Build did not produce a complete client');
      await runConfigCheck(path.join(stagedDist, 'server.mjs'), root, abort.signal);

      abort.signal.throwIfAborted();
      failure = '新版本启动失败，请查看客户端日志。';
      publish({ id, phase: 'restarting' });
      await stopWorker();
      const backup = path.join(stage, 'previous-dist');
      await rename(dist, backup);
      rollback.push(() => rename(backup, dist));
      await rename(stagedDist, dist);
      rollback.push(() => rename(dist, stagedDist));
      await launch();
      rollback.length = 0;
      installed = nextDependencies;
      return { id, phase: 'succeeded' };
    } catch (error) {
      console.error('[client update]', error);
      if (rollback.length) {
        try {
          await stopWorker();
          for (const undo of rollback.reverse()) await undo();
        } catch (restoreError) {
          console.error('[client update] Restore failed. Files retained in', stage, restoreError);
          stage = undefined;
          failure = '恢复上一版本失败，请查看客户端日志。';
        }
      }
      if (!worker && !abort.signal.aborted) {
        try {
          await launch();
        } catch (launchError) {
          console.error('[client update] Previous client failed to start:', launchError);
          await stopWorker();
          process.exitCode = 1;
        }
      }
      return { id, phase: 'failed', message: failure };
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true }).catch(console.error);
      if (lock) {
        await lock.close().catch(console.error);
        await rm(lockPath, { force: true }).catch(console.error);
      }
    }
  }

  function stop() {
    if (abort.signal.aborted) return;
    abort.abort();
    void (async () => {
      await job;
      await stopWorker();
    })().catch(console.error);
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await launch();
  } catch (error) {
    if (!abort.signal.aborted) {
      console.error(error);
      process.exitCode = 1;
    }
    await stopWorker();
  }
}

async function runConfigCheck(entry: string, cwd: string, signal: AbortSignal) {
  const child = spawn(
    process.execPath,
    [...process.execArgv, entry, ...process.argv.slice(2), '--check-config'],
    {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      windowsHide: true,
    },
  );
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error('Updated client configuration check failed');
}
