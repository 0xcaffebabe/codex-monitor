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
import { NotificationService } from './notifications/service.js';
import type { WebhookTransport } from './notifications/lark.js';
import type { LarkReplyListener } from './notifications/lark-replies.js';
import { installNotificationRoutes } from './http/notification-routes.js';
import { installSub2ApiRoutes } from './http/sub2api-routes.js';
import type { ServerMaintenance } from './maintenance/routes.js';

/** Server owns authentication, registration and notification delivery; Codex readers live in clients. */
export function createMonitorServer(
  config: Config,
  services: { publicDir?: string; webhookTransport?: WebhookTransport; larkReplyListener?: LarkReplyListener; maintenance?: ServerMaintenance } = {},
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
  const notifications = new NotificationService(auth.db, config.pollMs, services.webhookTransport, services.larkReplyListener);
  const gateway = new WorkspaceGateway(auth, notifications);
  notifications.startSession = (input, signal) => gateway.startLarkSession(input, signal);
  notifications.workspaceName = (id) => gateway.store.get(id)?.name;
  notifications.readReplyStatus = (workspaceId, userId, requestId, signal) =>
    gateway.larkReplyStatus(workspaceId, userId, requestId, signal);
  notifications.startReplies((input, signal) => gateway.submitLarkReply(input, signal));
  installNotificationRoutes(app, auth, notifications, ({ workspaceId, sessionId }) =>
    gateway.markCompletionRead(workspaceId, sessionId),
  );
  notifications.readAttachment = (workspaceId, ref, signal) =>
    gateway.readNotificationAttachment(workspaceId, ref, signal);
  notifications.onConfigure = (policy, reset) => gateway.configureNotifications(policy, reset);
  services.maintenance?.install(app, auth);
  gateway.install(app, services.maintenance?.snapshot);
  installFrontend(app, path.resolve(services.publicDir || 'dist/public'));
  let closing: Promise<void> | undefined;
  return {
    app,
    auth,
    gateway,
    notifications,
    close: () => {
      if (!closing) {
        gateway.close();
        closing = notifications.close().then(() => auth.close());
      }
      return closing;
    },
  };
}
