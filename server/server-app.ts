import express from 'express';
import path from 'node:path';
import { AuthStore } from './auth.js';
import type { Config } from './config.js';
import { installAccountApi } from './http/account-api.js';
import { installFrontend } from './http/frontend.js';
import { WorkspaceGateway } from './workspaces/gateway.js';
import { NotificationService } from './notifications/service.js';
import type { WebhookTransport } from './notifications/lark.js';
import type { LarkReplyListener } from './notifications/lark-replies.js';
import { installNotificationRoutes } from './http/notification-routes.js';
import type { ServerMaintenance } from './maintenance/routes.js';

/** Server owns authentication, registration and notification delivery; Codex readers live in clients. */
export function createMonitorServer(
  config: Config,
  services: { publicDir?: string; webhookTransport?: WebhookTransport; larkReplyListener?: LarkReplyListener; maintenance?: ServerMaintenance } = {},
) {
  const app = express(),
    auth = new AuthStore(config.dataDir, config.sessionDays);
  installAccountApi(app, auth, config);
  const notifications = new NotificationService(auth.db, config.pollMs, services.webhookTransport, services.larkReplyListener);
  const gateway = new WorkspaceGateway(auth, notifications);
  notifications.startSession = (input, signal) => gateway.startLarkSession(input, signal);
  notifications.workspaceName = (id) => gateway.store.get(id)?.name;
  notifications.workspacesNamed = (name) => gateway.store.list().filter((workspace) => workspace.name === name);
  notifications.helpWorkspaces = () => gateway.larkHelpWorkspaces();
  notifications.readHelpSnapshot = (id, details, signal) => gateway.larkHelpSnapshot(id, details, signal);
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
