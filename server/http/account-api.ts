import type { Express } from 'express';
import type { AuthStore } from '../auth.js';
import type { Config } from '../config.js';
import { authenticate, createAuthRateLimiter } from './access.js';
import { installAccountRoutes, installPublicAuthRoutes } from './auth-routes.js';
import { installHttpSecurity } from './security.js';
import { installSub2ApiRoutes } from './sub2api-routes.js';
import { installUserRoutes } from './user-routes.js';

/** Establish the public/authenticated boundary before installing workspace-specific routes. */
export function installAccountApi(app: Express, auth: AuthStore, config: Config) {
  installHttpSecurity(app, config);
  const rate = createAuthRateLimiter();
  installPublicAuthRoutes(app, auth, rate);
  app.use('/api', authenticate(auth));
  installAccountRoutes(app, auth, rate);
  installUserRoutes(app, auth);
  installSub2ApiRoutes(app, auth);
}
