import express from 'express';
import { once } from 'node:events';
import { AuthStore } from '../auth.js';
import type { Config } from '../config.js';
import { installFrontend } from '../http/frontend.js';
import { installWorkspaceRuntime, type WorkspaceServices } from '../workspace-runtime.js';
import { ClientAccess } from './access.js';
import { MAX_JSON_BODY } from '../transport/protocol.js';

export async function createClientRuntime(
  config: Config,
  services: WorkspaceServices & { store?: AuthStore } = {},
) {
  const app = express(),
    store = services.store ?? new AuthStore(config.dataDir, config.sessionDays);
  const access = new ClientAccess(store, !!services.store);
  if (
    !services.store &&
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='notification_settings'").get()
  ) {
    // Retire the previous client-owned sender. Global credentials are configured only on Server.
    store.db.exec(`UPDATE notification_settings SET enabled=0,webhook_url='',signing_secret='';
      UPDATE notification_deliveries SET status='cancelled',error='通知已迁移到 Server 统一投递'
      WHERE status IN ('pending','sending');`);
  }
  app.use((req, res, next) => {
    const header = req.headers.authorization || '',
      token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const identity = access.authenticate(token);
    if (!identity) return res.status(401).json({ error: '工作空间授权已失效' });
    req.identity = identity;
    req.token = token;
    next();
  });
  app.use(express.json({ limit: MAX_JSON_BODY }));
  const runtime = installWorkspaceRuntime(app, config, access, services);
  installFrontend(app, '__no_client_frontend__');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    ...runtime,
    access,
    url,
    close: async () => {
      access.clear();
      await runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!services.store) store.close();
    },
  };
}
