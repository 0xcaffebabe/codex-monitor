import express from 'express';
import path from 'node:path';
import { AuthStore } from './auth.js';
import type { Config } from './config.js';
import { authenticate, createAuthRateLimiter } from './http/access.js';
import { installAccountRoutes, installPublicAuthRoutes } from './http/auth-routes.js';
import { installFrontend } from './http/frontend.js';
import { installHttpSecurity } from './http/security.js';
import { installUserRoutes } from './http/user-routes.js';
import { installWorkspaceRuntime, type WorkspaceServices } from './workspace-runtime.js';

/** Local HTTP harness for capability tests; production uses server-app and client/connection. */
export function createApp(
  config: Config,
  services: WorkspaceServices & { publicDir?: string } = {},
) {
  const app = express(),
    auth = new AuthStore(config.dataDir, config.sessionDays);
  installHttpSecurity(app, config);
  const rate = createAuthRateLimiter();
  installPublicAuthRoutes(app, auth, rate);
  app.use('/api', authenticate(auth));
  installAccountRoutes(app, auth, rate);
  installUserRoutes(app, auth);
  const runtime = installWorkspaceRuntime(app, config, auth, services);
  installFrontend(app, path.resolve(services.publicDir || 'dist/public'));
  let closing: Promise<void> | undefined;
  return {
    app,
    auth,
    ...runtime,
    close: () => {
      if (!closing) {
        closing = runtime.close();
        auth.close();
      }
      return closing;
    },
  };
}
