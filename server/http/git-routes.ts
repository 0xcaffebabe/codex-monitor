import type { Express } from 'express';
import { z } from 'zod';
import { ProjectGit, GitError, validGitPath } from '../git.js';
import { validId } from '../source/session.js';
import { admin, fail } from './access.js';

const scope = z.enum(['all', 'unstaged', 'staged']).default('all');
const statusQuery = z.object({ scope }).strict();
const diffQuery = statusQuery.extend({ path: z.string().refine(validGitPath) }).strict();

export function installGitRoutes(app: Express, git: ProjectGit) {
  for (const diff of [false, true]) {
    app.get(`/api/sessions/:id/git${diff ? '/diff' : ''}`, admin, async (req, res) => {
      const id = String(req.params.id);
      const query = (diff ? diffQuery : statusQuery).safeParse(req.query);
      if (!validId(id) || !query.success) return fail(res, 400, 'Git 查询参数无效');
      try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(
          diff
            ? await git.diff(id, query.data.scope, (query.data as z.infer<typeof diffQuery>).path)
            : await git.status(id, query.data.scope),
        );
      } catch (error) {
        if (error instanceof GitError) return fail(res, error.status, error.message);
        throw error;
      }
    });
  }
}
