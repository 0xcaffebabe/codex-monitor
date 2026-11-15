import express from 'express';
import path from 'node:path';
import { AuthStore } from './auth.js';
import type { Config } from './config.js';
import { authenticate, createAuthRateLimiter } from './http/access.js';
import { installAccountRoutes, installPublicAuthRoutes } from './http/auth-routes.js';
import { installFrontend } from './http/frontend.js';
import { installHttpSecurity } from './http/security.js';
import { installUserRoutes } from './http/user-routes.js';
import { WorkspaceGateway } from './workspaces/gateway.js';

/** Server owns web authentication and registration; local Codex capabilities live in clients. */
export function createMonitorServer(config: Config, services: { publicDir?: string } = {}) {
  const app = express(),
    auth = new AuthStore(config.dataDir, config.sessionDays);
  installHttpSecurity(app, config);
  const rate = createAuthRateLimiter();
  installPublicAuthRoutes(app, auth, rate);
  app.use('/api', authenticate(auth));
  installAccountRoutes(app, auth, rate);
  installUserRoutes(app, auth);
  const gateway = new WorkspaceGateway(auth);
  gateway.install(app);
  installFrontend(app, path.resolve(services.publicDir || 'dist/public'));
  return {
    app,
    auth,
    gateway,
    close: () => {
      gateway.close();
      auth.close();
    },
  };
}
