import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { AuthStore } from '../auth.js';
import { fail } from './access.js';
import { credentials } from './schemas.js';

const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(40),
    password: z.string().min(1).max(256),
    device: z.string().max(160).optional(),
  })
  .strict();
export function installPublicAuthRoutes(app: Express, auth: AuthStore, rate: RequestHandler) {
  app.get('/api/auth/status', (_req, res) => res.json({ configured: auth.configured() }));
  app.post('/api/auth/setup', rate, async (req, res) => {
    if (auth.configured()) return fail(res, 409, '管理员已创建，请登录');
    const parsed = credentials
      .extend({ setupKey: z.string().min(1).max(128), device: z.string().max(160).optional() })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '用户名需 2–40 位，密码至少 12 位');
    if (!auth.validSetupKey(parsed.data.setupKey))
      return fail(res, 403, '初始化密钥无效，请从本机启动信息获取');
    try {
      const user = await auth.setup(parsed.data.username, parsed.data.password);
      auth.log('setup', user.username, req.ip ?? '');
      res
        .status(201)
        .json(auth.issue(user, parsed.data.device || req.headers['user-agent'] || '浏览器'));
    } catch {
      return fail(res, 409, '管理员已创建，请登录');
    }
  });
  app.post('/api/auth/login', rate, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '请输入有效的用户名和密码');
    const user = await auth.login(parsed.data.username, parsed.data.password);
    auth.log(user ? 'login' : 'login_failed', parsed.data.username, req.ip ?? '');
    if (!user) return fail(res, 401, '用户名或密码错误');
    res.json(auth.issue(user, parsed.data.device || req.headers['user-agent'] || '浏览器'));
  });
}
export function installAccountRoutes(app: Express, auth: AuthStore, rate: RequestHandler) {
  app.get('/api/auth/me', (req, res) => res.json(req.identity));
  app.post('/api/auth/logout', (req, res) => {
    auth.revoke(req.identity!.user.id, req.identity!.sessionId);
    res.status(204).end();
  });
  app.get('/api/auth/devices', (req, res) =>
    res.json({ devices: auth.devices(req.identity!.user.id), current: req.identity!.sessionId }),
  );
  app.delete('/api/auth/devices/:id', (req, res) => {
    auth.revoke(req.identity!.user.id, String(req.params.id));
    res.status(204).end();
  });
  app.post('/api/auth/password', rate, async (req, res) => {
    const parsed = z
      .object({ currentPassword: z.string().max(256), password: z.string().min(12).max(256) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '新密码至少 12 位');
    const identity = req.identity!;
    if (!(await auth.login(identity.user.username, parsed.data.currentPassword)))
      return fail(res, 403, '当前密码错误');
    if (!(await auth.changePassword(identity.user.id, parsed.data.password, identity.sessionId)))
      return fail(res, 403, '登录权限已失效，请重新登录');
    auth.log('password_changed', identity.user.username, req.ip ?? '');
    res.status(204).end();
  });
}
