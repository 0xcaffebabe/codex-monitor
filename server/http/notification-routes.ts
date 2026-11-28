import type { Express, Request } from 'express';
import { z } from 'zod';
import type { CompletionNotification } from '../../src/types.js';
import type { NotificationService } from '../notifications/service.js';
import { notificationConfigured } from '../notifications/store.js';
import { admin, fail } from './access.js';
import type { WorkspaceAuth } from '../authorization.js';

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
const alias = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,15}$/);
const larkStart = z.object({
  defaultAlias: z.union([z.literal(''), alias]),
  targets: z.array(z.object({
    alias,
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    projectId: z.uuid(),
    projectName: z.string().trim().min(1).max(500).optional(),
  }).strict()).max(20),
}).strict().refine(({ defaultAlias, targets }) =>
  new Set(targets.map((target) => target.alias)).size === targets.length &&
  (!targets.length ? !defaultAlias : targets.some((target) => target.alias === defaultAlias)));

const settings = z
  .object({
    enabled: z.boolean(),
    provider: z.literal('lark'),
    completionMode: z.enum(['watched', 'all']).optional(),
    appRegion: z.enum(['lark', 'feishu']).optional(),
    appId: z.string().trim().regex(/^(?:cli_[A-Za-z0-9]{1,100})?$/).optional(),
    appSecret: z.string().trim().max(256).optional(),
    replyOpenIds: z.array(z.string().trim().regex(/^ou_[A-Za-z0-9_-]{1,100}$/)).max(50)
      .transform((ids) => [...new Set(ids)]).optional(),
    larkStart: larkStart.optional(),
    publicUrl,
  })
  .strict();

const dismissal = z
  .object({
    generation: z.uuid(),
    ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(50),
    markRead: z.literal(true).optional(),
  })
  .strict()
  .refine(({ ids, markRead }) => !markRead || ids.length === 1);

export function installNotificationRoutes(
  app: Express,
  auth: WorkspaceAuth,
  notifications: NotificationService,
  markRead: (notice: CompletionNotification) => Promise<void>,
  authorized?: (req: Request) => Promise<boolean>,
) {
  const streams = new Map<string, number>();
  let streamCount = 0;
  // All authenticated readers can already read sessions in every registered workspace.
  app.get('/api/notifications/completions', (_req, res) => {
    res.json(notifications.completions.snapshot());
  });
  app.get('/api/notifications/completions/stream', (req, res) => {
    const sessionId = req.identity!.sessionId;
    const count = streams.get(sessionId) ?? 0;
    if (streamCount >= 50 || count >= 5)
      return fail(res, 429, '通知实时连接数量已达上限');
    streams.set(sessionId, count + 1);
    streamCount++;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.writableNeedDrain) {
        res.destroy();
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const authorized = () => {
      if (res.destroyed || res.writableEnded) return false;
      if (auth.authenticate(req.token!)) return true;
      send('unauthorized', {});
      res.end();
      return false;
    };
    const unsubscribe = notifications.completions.subscribe((snapshot) => {
      if (!snapshot) res.end();
      else if (authorized()) send('snapshot', snapshot);
    });
    const heartbeat = setInterval(() => {
      if (authorized()) send('heartbeat', {});
    }, 15000);
    heartbeat.unref();
    res.once('close', () => {
      streamCount--;
      const remaining = streams.get(sessionId)! - 1;
      if (remaining) streams.set(sessionId, remaining);
      else streams.delete(sessionId);
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  app.post('/api/notifications/completions/dismiss', (req, res) => {
    const parsed = dismissal.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '通知关闭请求无效，请刷新后重试');
    // Dismiss only IDs observed by the caller, so a concurrent new completion survives “close all”.
    const { generation, ids, markRead: shouldMarkRead } = parsed.data;
    const target = shouldMarkRead
      ? notifications.completions.snapshot().notifications.find((notice) => notice.id === ids[0])
      : undefined;
    const result = notifications.completions.dismiss(generation, ids);
    if (!result) return fail(res, 409, '服务已重启，通知列表已更新，请刷新后重试');
    if (target) void markRead(target).catch(() => {});
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
    if (!parsed.success) return fail(res, 400, '请检查飞书/Lark 通知配置、授权 Open ID 和会话目标。简称须唯一，并选定一个默认目标。');
    const config = { ...notifications.store.config(), ...parsed.data };
    if (config.enabled && !notificationConfigured(config))
      return fail(res, 400, '启用私聊通知前请填写 App ID、App Secret 和接收人的 Open ID');
    try {
      const result = await notifications.configure(
        parsed.data,
        () => authorized ? authorized(req) : auth.authenticate(req.token!)?.user.role === 'admin',
        req.identity!.user.id,
      );
      auth.log('notifications_updated', req.identity!.user.username, req.ip ?? '');
      res.json(result);
    } catch {
      fail(res, 409, '通知配置保存失败，请刷新确认权限与数据源后重试');
    }
  });
  app.post('/api/notifications/test', admin, async (req, res) => {
    if (!notificationConfigured(notifications.store.config()))
      return fail(res, 400, '请先保存私聊通知配置');
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
