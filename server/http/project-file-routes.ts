import type { Express } from 'express';
import { z } from 'zod';
import { ProjectFiles, ProjectFileError, validProjectFilePath } from '../project-files.js';
import { validId } from '../source/session.js';
import { admin, fail } from './access.js';
import { ControlError } from '../control-error.js';

const query = z
  .object({
    path: z.string().refine(validProjectFilePath).default(''),
    search: z
      .string()
      .trim()
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]*$/)
      .default(''),
  })
  .strict();

export function installProjectFileRoutes(app: Express, files: ProjectFiles) {
  for (const type of ['session', 'project'] as const) {
    const route =
      type === 'session' ? '/api/sessions/:id/files' : '/api/control/projects/:id/files';
    app.get(route, admin, async (req, res) => {
      const id = String(req.params.id);
      const parsed = query.safeParse(req.query);
      if (!validId(id) || !parsed.success) return fail(res, 400, '文件查询参数无效');
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try {
        const listing = await files.list(
          { type, id },
          parsed.data.path,
          parsed.data.search,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          res.setHeader('Cache-Control', 'no-store');
          res.json(listing);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ProjectFileError || error instanceof ControlError)
          return fail(res, error.status, error.message);
        throw error;
      } finally {
        res.off('close', abort);
      }
    });
  }
}
