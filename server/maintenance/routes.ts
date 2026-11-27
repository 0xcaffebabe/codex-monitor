import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type { AuthStore } from '../auth.js';
import { buildDependencies, buildId } from '../build-info.js';
import type { Config } from '../config.js';
import { admin, fail } from '../http/access.js';
import {
  readUpdateStatus,
  UPDATE_LOCK,
  UPDATE_LOG,
  writeUpdateStatus,
  type ServerUpdateJob,
} from './status.js';

export function serverMaintenance(config: Config, entry: string) {
  const root = process.cwd();
  const worker = path.join(root, 'dist', 'server-update.mjs');
  const pmId = Number(process.env.pm_id ?? NaN);
  const jobBuildId = buildId;
  const jobDependencies = buildDependencies;
  if (
    !jobBuildId ||
    !jobDependencies ||
    !Number.isSafeInteger(pmId) ||
    pmId < 0 ||
    path.relative(root, entry) !== path.join('dist', 'server.mjs') ||
    !existsSync(path.join(root, '.git')) ||
    !existsSync(worker)
  )
    return;

  const lockPath = path.join(root, UPDATE_LOCK);
  const boundHost =
    config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  const host = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
  const healthUrl = `${config.secure ? 'https' : 'http'}://${host}:${config.port}/api/health`;
  return {
    snapshot: () => ({
      serverUpdateSupported: true,
      serverUpdate: readUpdateStatus(config.dataDir),
    }),
    install(app: Express, auth: AuthStore) {
      app.post('/api/server/update', admin, async (req, res) => {
        const job: ServerUpdateJob = {
          dataDir: config.dataDir,
          pmId,
          healthUrl,
          buildId: jobBuildId,
          dependencies: jobDependencies,
        };
        let locked = false;
        try {
          const lock = openSync(lockPath, 'wx', 0o600);
          locked = true;
          closeSync(lock);
          writeUpdateStatus(job.dataDir, { phase: 'requested' });
          const log = openSync(path.join(job.dataDir, UPDATE_LOG), 'a', 0o600);
          try {
            const bridge = spawn(process.execPath, [worker, '--detach'], {
              cwd: root,
              windowsHide: true,
              stdio: ['ignore', log, log],
              env: { ...process.env, MONITOR_PM2_UPDATE_JOB: JSON.stringify(job) },
            });
            const [code] = await once(bridge, 'exit');
            if (code !== 0) throw new Error(`Update launcher exited (${code})`);
          } finally {
            closeSync(log);
          }
        } catch (error) {
          if (!locked && (error as NodeJS.ErrnoException).code === 'EEXIST')
            return fail(res, 409, '当前项目目录已有更新任务在运行。');
          if (locked) {
            try {
              writeUpdateStatus(job.dataDir, {
                phase: 'failed',
                message: '无法启动服务端更新，请查看服务端日志。',
              });
            } finally {
              unlinkSync(lockPath);
            }
          }
          console.error('[server update]', error);
          return fail(res, 500, '无法启动服务端更新。');
        }
        auth.log('server-update', req.identity!.user.username, req.ip ?? '');
        res.status(202).json({ ok: true });
      });
    },
  };
}

export type ServerMaintenance = NonNullable<ReturnType<typeof serverMaintenance>>;
