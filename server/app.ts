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
import { NotificationService } from './notifications/service.js';
import { NotificationReporter } from './notifications/reporter.js';
import type { WebhookTransport } from './notifications/lark.js';
import { installNotificationRoutes } from './http/notification-routes.js';
import { installSub2ApiRoutes } from './http/sub2api-routes.js';

/** Local HTTP harness for capability tests; production uses server-app and client/connection. */
export function createApp(
  config: Config,
  services: WorkspaceServices & { publicDir?: string; webhookTransport?: WebhookTransport } = {},
) {
  const app = express(),
    auth = new AuthStore(config.dataDir, config.sessionDays);
  installHttpSecurity(app, config);
  const rate = createAuthRateLimiter();
  installPublicAuthRoutes(app, auth, rate);
  app.use('/api', authenticate(auth));
  installAccountRoutes(app, auth, rate);
  installUserRoutes(app, auth);
  installSub2ApiRoutes(app, auth);
  const runtime = installWorkspaceRuntime(app, config, auth, services);
  const notifications = new NotificationService(auth.db, config.pollMs, services.webhookTransport);
  notifications.readAttachment = (_workspaceId, ref, signal) =>
    runtime.notificationAttachments.read(ref, signal);
  const notificationReporter = new NotificationReporter(
    auth.db,
    runtime.source,
    config.pollMs,
    async (report) => notifications.receive({ id: 'local', name: '本机工作空间' }, report),
  );
  notifications.onConfigure = (policy, reset) => notificationReporter.configure(policy, reset);
  const notificationReady = notificationReporter.configure(notifications.policy());
  installNotificationRoutes(app, auth, notifications, ({ sessionId }) =>
    runtime.markSessionRead(sessionId),
  );
  installFrontend(app, path.resolve(services.publicDir || 'dist/public'));
  let closing: Promise<void> | undefined;
  return {
    app,
    auth,
    ...runtime,
    notifications,
    async pollNotifications() {
      await notificationReady;
      await notificationReporter.poll();
      await notifications.poll();
    },
    close: () => {
      if (!closing) {
        closing = Promise.all([notificationReporter.close(), notifications.close()])
          .then(() => runtime.close())
          .then(() => auth.close());
      }
      return closing;
    },
  };
}
