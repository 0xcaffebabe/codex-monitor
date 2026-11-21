import { expect, test as base } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MonitorClient } from '../../server/client/connection.js';
import { configFromEnv } from '../../server/config.js';
import { requestGuard } from '../../server/http/security.js';
import { createMonitorServer } from '../../server/server-app.js';
import { ApprovalFixtureDesktop } from '../approval-fixture.js';
import { fixture, ids } from '../fixture.js';
import { MonitorPage } from './pages/monitor.js';

export const localTitle = '开发 codex-monitor 实时监控';

type Workspace = Awaited<ReturnType<Monitor['addWorkspace']>>;
type Cleanup = (action: () => unknown) => void;
type Monitor = Awaited<ReturnType<typeof startMonitor>>;

async function startMonitor(defer: Cleanup) {
  const publicDir = path.resolve('dist/public');
  await access(path.join(publicDir, 'index.html')).catch(() => {
    throw new Error('Run npm run build before running the browser tests.');
  });
  const root = await mkdtemp(path.join(tmpdir(), 'codex-monitor-e2e-'));
  defer(() => rm(root, { recursive: true, force: true }));
  const config = configFromEnv({
    MONITOR_MODE: 'server',
    MONITOR_DATA_DIR: path.join(root, 'server'),
    CODEX_HOME: path.join(root, 'unused'),
    HOST: '127.0.0.1',
    MONITOR_POLL_MS: '500',
  });
  const monitor = createMonitorServer(config, {
    publicDir,
    webhookTransport: () => Promise.reject(new Error('External delivery is disabled in E2E')),
  });
  const server = createServer(monitor.app);
  defer(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  defer(() => monitor.close());
  monitor.gateway.attach(server, requestGuard(config));
  const listening = once(server, 'listening');
  server.listen(0, config.host);
  await listening;
  const url = `http://${config.host}:${(server.address() as AddressInfo).port}`;
  const setupKey = monitor.auth.setupKey!;
  const credentials = { username: 'owner', password: randomUUID() };

  async function addWorkspace(name: string, title: string, id?: string, projectPath?: string) {
    const registration = monitor.gateway.store.create(name, id);
    const workspaceId = registration.workspace.id;
    const data = fixture(path.join(root, workspaceId));
    defer(() => data.close());
    const project = projectPath ?? path.join(data.root, 'project');
    await mkdir(project, { recursive: true });
    data.state.prepare('UPDATE threads SET cwd=?').run(project);
    data.state.prepare('UPDATE threads SET title=? WHERE id=?').run(title, ids.modern);
    let active: MonitorClient | undefined;
    let control: ApprovalFixtureDesktop;

    async function start() {
      control = new ApprovalFixtureDesktop(data, 0, project);
      active = await MonitorClient.start({
        config: { ...data.config, desktopAutoStart: false },
        serverUrl: url,
        workspaceId,
        key: registration.key,
        services: { control },
      });
      await expect.poll(() => active?.connected).toBe(true);
    }

    async function stop() {
      const client = active;
      active = undefined;
      await client?.close();
    }

    defer(stop);
    await start();
    return {
      id: workspaceId,
      data,
      start,
      stop,
      get control() {
        return control;
      },
    };
  }

  return { url, credentials, setupKey, addWorkspace };
}

export const test = base.extend<{
  monitor: Monitor;
  local: Workspace;
  app: MonitorPage;
  signedIn: MonitorPage;
}>({
  monitor: async ({}, use) => {
    const cleanup: Parameters<Cleanup>[0][] = [];
    try {
      await use(await startMonitor((action) => cleanup.push(action)));
    } finally {
      const errors: unknown[] = [];
      for (const action of cleanup.reverse()) {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Closing E2E fixtures failed');
    }
  },
  baseURL: async ({ monitor }, use) => use(monitor.url),
  context: async ({ context, monitor }, use) => {
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === monitor.url ? route.continue() : route.abort(),
    );
    await use(context);
  },
  local: async ({ monitor }, use) =>
    use(await monitor.addWorkspace('本机工作空间', localTitle, 'local')),
  app: async ({ page }, use) => use(new MonitorPage(page)),
  signedIn: async ({ app, monitor, local }, use) => {
    await app.account.setUpOwner(
      monitor.setupKey,
      monitor.credentials,
      `/?workspace=${local.id}&view=all`,
    );
    await expect(app.workspace.sessionListHeading).toBeVisible();
    await use(app);
  },
});

export { expect };
