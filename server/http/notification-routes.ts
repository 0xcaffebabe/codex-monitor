import type { Express, Request } from 'express';
import { z } from 'zod';
import type { NotificationService } from '../notifications/service.js';
import { validLarkWebhook } from '../notifications/lark.js';
import { notificationConfigured } from '../notifications/store.js';
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
    completionMode: z.enum(['watched', 'all']).optional(),
    webhookUrl: z.string().trim().max(512).refine(validLarkWebhook).optional(),
    signingSecret: z.string().trim().max(256).optional(),
    mode: z.enum(['webhook', 'app']).optional(),
    appRegion: z.enum(['lark', 'feishu']).optional(),
    appId: z.string().trim().regex(/^(?:cli_[A-Za-z0-9]{1,100})?$/).optional(),
    appSecret: z.string().trim().max(256).optional(),
    chatId: z.string().trim().regex(/^(?:oc_[A-Za-z0-9_-]{1,100})?$/).optional(),
    publicUrl,
  })
  .strict();

const dismissal = z
  .object({
    generation: z.uuid(),
    ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(50),
  })
  .strict();

export function installNotificationRoutes(
  app: Express,
  auth: WorkspaceAuth,
  notifications: NotificationService,
  authorized?: (req: Request) => Promise<boolean>,
) {
  // All authenticated readers can already read sessions in every registered workspace.
  app.get('/api/notifications/completions', (_req, res) => {
    res.json(notifications.completions.snapshot());
  });
  app.post('/api/notifications/completions/dismiss', (req, res) => {
    const parsed = dismissal.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '通知关闭请求无效，请刷新后重试');
    // Dismiss only IDs observed by the caller, so a concurrent new completion survives “close all”.
    const result = notifications.completions.dismiss(parsed.data.generation, parsed.data.ids);
    if (!result) return fail(res, 409, '服务已重启，通知列表已更新，请刷新后重试');
    res.json(result);
  });
  app.get('/api/notifications', admin, (_req, res) => res.json(notifications.state()));
  app.get('/api/notifications/watches', admin, (_req, res) => res.json({ watches: notifications.store.watches() }));
  app.put('/api/notifications/watches', admin, (req, res) => {
    const parsed = z.object({
      workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      watched: z.boolean(),
    }).strict().safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '关注操作无效');
    const { workspaceId, sessionId, watched } = parsed.data;
    if (!notifications.store.watch(workspaceId, sessionId, watched))
      return fail(res, 409, '已达到关注上限，请先取消不再跟进的会话');
    res.json({ watches: notifications.store.watches() });
  });
  app.put('/api/notifications', admin, async (req, res) => {
    const parsed = settings.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '请检查飞书/Lark 通知配置和监控台访问地址');
    const config = { ...notifications.store.config(), ...parsed.data };
    if (config.enabled && !notificationConfigured(config))
      return fail(res, 400, config.mode === 'app'
        ? '启用通知前请填写 App ID、App Secret 和群聊 ID'
        : '启用通知前请先配置 Webhook');
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
    if (!notificationConfigured(notifications.store.config()))
      return fail(res, 400, '请先保存所选方式的通知配置');
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
