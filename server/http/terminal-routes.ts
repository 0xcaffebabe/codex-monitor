import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { ProjectTerminals, TerminalError } from '../terminal.js';
import { validId } from '../source/session.js';
import { admin, fail } from './access.js';

const size = z.object({
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(2).max(200),
});
const create = size.extend({ id: z.uuid() }).strict();
const input = z.object({ data: z.string().min(1).max(16384) }).strict();

export function installTerminalRoutes(app: Express, terminals: ProjectTerminals) {
  const route = '/api/sessions/:id/terminal/:terminal';
  const run =
    (action: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
      if (!validId(String(req.params.id)) || !z.uuid().safeParse(req.params.terminal).success)
        return fail(res, 400, '终端或会话 ID 无效');
      try {
        await terminals.authorize(req.identity!);
        await action(req, res);
      } catch (error) {
        if (error instanceof TerminalError) return fail(res, error.status, error.message);
        throw error;
      }
    };
  app.post('/api/sessions/:id/terminal', admin, async (req, res) => {
    const parsed = create.safeParse(req.body);
    if (!validId(String(req.params.id)) || !parsed.success) return fail(res, 400, '终端参数无效');
    try {
      const { id, cols, rows } = parsed.data;
      res
        .status(201)
        .json(await terminals.open(req.identity!, String(req.params.id), id, cols, rows));
    } catch (error) {
      if (error instanceof TerminalError) return fail(res, error.status, error.message);
      throw error;
    }
  });
  app.get(
    route,
    admin,
    run((req, res) => {
      const query = z
        .object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
        .strict()
        .safeParse(req.query);
      if (!query.success) return fail(res, 400, '终端输出位置无效');
      res.json(
        terminals.read(
          req.identity!,
          String(req.params.id),
          String(req.params.terminal),
          query.data.after,
        ),
      );
    }),
  );
  app.post(
    route + '/input',
    admin,
    run((req, res) => {
      const parsed = input.safeParse(req.body);
      if (!parsed.success) return fail(res, 400, '终端输入无效，单次最多 16384 字符');
      terminals.write(
        req.identity!,
        String(req.params.id),
        String(req.params.terminal),
        parsed.data.data,
      );
      res.status(204).end();
    }),
  );
  app.post(
    route + '/resize',
    admin,
    run((req, res) => {
      const parsed = size.strict().safeParse(req.body);
      if (!parsed.success) return fail(res, 400, '终端尺寸无效');
      terminals.resize(
        req.identity!,
        String(req.params.id),
        String(req.params.terminal),
        parsed.data.cols,
        parsed.data.rows,
      );
      res.status(204).end();
    }),
  );
  app.delete(
    route,
    admin,
    run((req, res) => {
      terminals.removeOwned(req.identity!, String(req.params.id), String(req.params.terminal));
      res.status(204).end();
    }),
  );
}
