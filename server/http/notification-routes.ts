import type { Express, Request } from 'express';
import { z } from 'zod';
import type { NotificationService } from '../notifications/service.js';
import { validLarkWebhook } from '../notifications/lark.js';
import { admin, fail, type WorkspaceAuth } from './access.js';

const publicUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        ['https:', 'http:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  });
const settings = z
  .object({
    enabled: z.boolean(),
    provider: z.literal('lark'),
    webhookUrl: z.string().trim().max(512).refine(validLarkWebhook).optional(),
    signingSecret: z.string().trim().max(256).optional(),
    publicUrl,
  })
  .strict();

export function installNotificationRoutes(
  app: Express,
  auth: WorkspaceAuth,
  notifications: NotificationService,
  authorized?: (req: Request) => Promise<boolean>,
) {
  app.get('/api/notifications', admin, (_req, res) => res.json(notifications.state()));
  app.put('/api/notifications', admin, async (req, res) => {
    const parsed = settings.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '请填写有效的飞书/Lark Webhook 和访问地址');
    if (parsed.data.enabled && !(parsed.data.webhookUrl ?? notifications.store.config().webhookUrl))
      return fail(res, 400, '启用完成通知前请先配置 Webhook');
    try {
      const result = await notifications.configure(parsed.data, () =>
        authorized ? authorized(req) : auth.authenticate(req.token!)?.user.role === 'admin',
      );
      auth.log('notifications_updated', req.identity!.user.username, req.ip ?? '');
      res.json(result);
    } catch {
      fail(res, 409, '通知配置保存失败，请刷新确认权限与数据源后重试');
    }
  });
  app.post('/api/notifications/test', admin, async (req, res) => {
    if (!notifications.store.config().webhookUrl) return fail(res, 400, '请先保存 Webhook 配置');
    const task = notifications.test();
    if (!task) {
      res.setHeader('Retry-After', '5');
      return fail(res, 429, '测试发送过于频繁，请 5 秒后重试');
    }
    const delivery = await task;
    auth.log('notifications_tested', req.identity!.user.username, req.ip ?? '');
    if (delivery.status !== 'sent') return fail(res, 502, delivery.error || '测试发送失败');
    // Do not return the stored message, raw webhook or signing secret.
    res.json({ ok: true, ...notifications.state() });
  });
}
