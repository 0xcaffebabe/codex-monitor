import type { Express } from 'express';
import { z } from 'zod';
import { validId } from '../source/session.js';
import { UsageStore } from '../usage.js';
import { fail } from './access.js';

export function installUsageRoutes(app: Express, usage: Pick<UsageStore, 'sync' | 'query'>) {
  app.get('/api/usage', async (req, res) => {
    const parsed = z
      .object({
        from: z.coerce.number().int().min(0).max(8640000000000000).optional(),
        to: z.coerce.number().int().min(0).max(8640000000000000).optional(),
        model: z.string().max(150).optional(),
        session: z.string().refine(validId).optional(),
        project: z.string().max(1000).optional(),
        subagents: z.enum(['true', 'false']).optional(),
        timezoneOffset: z.coerce.number().int().min(-840).max(840).optional(),
        offset: z.coerce.number().int().min(0).max(10000000).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        refresh: z.enum(['true', 'false']).optional(),
      })
      .strict()
      .safeParse(req.query);
    if (
      !parsed.success ||
      (parsed.data.from !== undefined &&
        parsed.data.to !== undefined &&
        parsed.data.from >= parsed.data.to)
    )
      return fail(res, 400, '用量筛选参数无效');
    void usage.sync(parsed.data.refresh === 'true');
    res.json(await usage.query(parsed.data));
  });
}
