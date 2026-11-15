import path from 'node:path';
import type { Express } from 'express';
import type { Config } from './config.js';
import { installControl, type ControlAuthorization } from './control.js';
import { DesktopBridge, type DesktopControl } from './desktop.js';
import { DesktopWatchdog } from './desktop-watchdog.js';
import type { WorkspaceAuth } from './http/access.js';
import { installSessionRoutes } from './http/session-routes.js';
import { installUsageRoutes } from './http/usage-routes.js';
import { installRealtime } from './realtime.js';
import { CodexSource } from './source.js';
import { UploadStore, installUploads } from './uploads.js';
import { UsageStore } from './usage.js';
import { ProjectTerminals } from './terminal.js';
import { installTerminalRoutes } from './http/terminal-routes.js';

export type WorkspaceServices = {
  control?: DesktopControl;
  authorization?: ControlAuthorization;
};

/** Local capabilities shared by the legacy test harness and the WebSocket client. */
export function installWorkspaceRuntime(
  app: Express,
  config: Config,
  auth: WorkspaceAuth,
  services: WorkspaceServices = {},
) {
  const source = new CodexSource(config.codexHome);
  const usage = new UsageStore(
    source,
    config.dataDir,
    config.pricingFile ?? path.resolve('config/model-pricing.json'),
  );
  const uploads = new UploadStore(auth.db, config.dataDir);
  installUploads(app, uploads);
  const terminals = new ProjectTerminals(auth, source, services.authorization);
  installTerminalRoutes(app, terminals);
  const closeControl = installControl(
    app,
    auth.db,
    source,
    services.control ??
      new DesktopBridge({
        codexHome: config.codexHome,
        activity: (id) => source.activity(id),
      }),
    uploads,
    services.authorization,
  );
  const recentCreation = auth.db.prepare(`SELECT 1 FROM control_requests WHERE state='succeeded'
    AND json_extract(result_json,'$.mode')='create' AND json_extract(result_json,'$.threadId')=?
    AND json_extract(result_json,'$.acceptedAt')>? LIMIT 1`);
  installSessionRoutes(app, source, (id) => !!recentCreation.get(id, Date.now() - 120000));
  installUsageRoutes(app, usage);
  const closeRealtime = installRealtime(app, auth, source, config.pollMs);
  const desktopWatchdog = config.desktopAutoStart
    ? new DesktopWatchdog({
        intervalMs: config.desktopCheckMs ?? 15000,
        executable: config.desktopExecutable,
      })
    : undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closeControl();
    closeRealtime();
    terminals.close();
    uploads.close();
    source.close();
    closing = Promise.all([usage.close(), desktopWatchdog?.close()]).then(() => {});
    return closing;
  };
  return { source, usage, terminals, close };
}
