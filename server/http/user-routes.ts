import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthStore, passwordHash } from '../auth.js';
import { admin, fail } from './access.js';
import { credentials } from './schemas.js';

export function installUserRoutes(app: Express, auth: AuthStore) {
  app.get('/api/users', admin, (_req, res) =>
    res.json({
      users: auth.db
        .prepare('SELECT id,username,role,created_at AS createdAt FROM users ORDER BY created_at')
        .all(),
    }),
  );
  app.post('/api/users', admin, async (req, res) => {
    const parsed = credentials
      .extend({ role: z.enum(['admin', 'viewer']).default('viewer') })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '用户名需 2–40 位，密码至少 12 位');
    const { username, password, role } = parsed.data;
    const hash = await passwordHash(password);
    if (auth.authenticate(req.token!)?.user.role !== 'admin')
      return fail(res, 403, '登录或操作权限已失效，请重新登录');
    try {
      auth.db
        .prepare('INSERT INTO users VALUES(?,?,?,?,?)')
        .run(randomUUID(), username, hash, role, Date.now());
      auth.log('user_created', req.identity!.user.username, req.ip ?? '');
      res.status(201).json({ ok: true });
    } catch {
      fail(res, 409, '此用户名已存在');
    }
  });
  app.delete('/api/users/:id', admin, (req, res) => {
    if (req.params.id === req.identity!.user.id) return fail(res, 400, '不能删除当前账户');
    auth.db.prepare('DELETE FROM users WHERE id=?').run(String(req.params.id));
    auth.log('user_deleted', req.identity!.user.username, req.ip ?? '');
    res.status(204).end();
  });
}
