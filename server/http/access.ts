import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Identity } from '../authorization.js';
import { AuthStore } from '../auth.js';

declare global {
  namespace Express {
    interface Request {
      identity?: Identity;
      token?: string;
    }
  }
}

export const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ error });
export const admin = (req: Request, res: Response, next: NextFunction) =>
  req.identity?.user.role === 'admin' ? next() : fail(res, 403, '此操作需要管理员权限');

export const authenticate =
  (auth: AuthStore): RequestHandler =>
  (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const identity = auth.authenticate(token);
    if (!identity) return fail(res, 401, '登录已过期，请重新登录');
    req.identity = identity;
    req.token = token;
    next();
  };
export function createAuthRateLimiter(): RequestHandler {
  const attempts = new Map<string, { count: number; reset: number }>();
  const rate = (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
    const key = req.socket.remoteAddress || 'unknown',
      a = attempts.get(key) ?? { count: 0, reset: now + 60000 };
    a.count++;
    attempts.set(key, a);
    if (a.count > 12) {
      res.setHeader('Retry-After', Math.ceil((a.reset - now) / 1000));
      return fail(res, 429, '尝试过于频繁，请一分钟后重试');
    }
    next();
  };

  return rate;
}
