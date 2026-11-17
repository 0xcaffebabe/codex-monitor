import type { Express } from 'express';
import { z } from 'zod';
import { ProjectGit, GitError, validGitBranch, validGitPath } from '../git.js';
import { validId } from '../source/session.js';
import type { ControlAuthorization } from '../control.js';
import { admin, fail, type Identity, type WorkspaceAuth } from './access.js';

const scope = z.enum(['all', 'unstaged', 'staged']).default('all');
const statusQuery = z.object({ scope }).strict();
const diffQuery = statusQuery.extend({ path: z.string().refine(validGitPath) }).strict();
const branchBody = z.object({ branch: z.string().refine(validGitBranch) }).strict();

export function installGitRoutes(
  app: Express,
  git: ProjectGit,
  auth: WorkspaceAuth,
  authorization?: ControlAuthorization,
) {
  const authorize = async (identity: Identity) => {
    const valid = () =>
      !!auth.db
        .prepare(
          `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
           WHERE s.id=? AND s.user_id=? AND s.expires_at>? AND u.role='admin'`,
        )
        .get(identity.sessionId, identity.user.id, Date.now());
    if (!valid() || (authorization && !(await authorization.device(identity))) || !valid())
      throw new GitError('登录或分支切换权限已失效，请重新登录。', 403);
  };
  app.get('/api/sessions/:id/git/branches', admin, async (req, res) => {
    const id = String(req.params.id);
    if (!validId(id) || Object.keys(req.query).length) return fail(res, 400, 'Git 查询参数无效');
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await git.branches(id));
    } catch (error) {
      if (error instanceof GitError) return fail(res, error.status, error.message);
      throw error;
    }
  });
  app.post('/api/sessions/:id/git/branch', admin, async (req, res) => {
    const id = String(req.params.id);
    const parsed = branchBody.safeParse(req.body);
    if (!validId(id) || !parsed.success || Object.keys(req.query).length)
      return fail(res, 400, '分支切换参数无效');
    try {
      await authorize(req.identity!);
      const result = await git.switchBranch(id, parsed.data.branch, () => authorize(req.identity!));
      auth.log('git.switch', req.identity!.user.username, req.ip || '');
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (error) {
      if (error instanceof GitError) return fail(res, error.status, error.message);
      throw error;
    }
  });
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
