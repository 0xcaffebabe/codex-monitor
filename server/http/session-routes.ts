import type { Express } from 'express';
import { z } from 'zod';
import { MediaError } from '../media.js';
import { ImagePreviews, imagePreviewQuery } from '../image-previews.js';
import { CodexSource } from '../source.js';
import { validId } from '../source/session.js';
import { fail } from './access.js';

export function installSessionRoutes(
  app: Express,
  source: Pick<
    CodexSource,
    | 'overview'
    | 'list'
    | 'detail'
    | 'export'
    | 'outline'
    | 'image'
    | 'computerUse'
    | 'computerUseImage'
  >,
  isPendingCreation: (id: string) => boolean = () => false,
  previews = new ImagePreviews(),
) {
  app.get('/api/overview', async (_req, res) => res.json(await source.overview()));
  app.get('/api/sessions', async (req, res) => {
    const parsed = z
      .object({
        q: z.string().max(200).optional(),
        project: z.string().max(1000).optional(),
        status: z
          .enum([
            'all',
            'running',
            'waiting',
            'completed',
            'interrupted',
            'failed',
            'idle',
            'stale',
          ])
          .optional(),
        archived: z.enum(['true', 'false', 'all']).optional(),
        subagents: z.enum(['true', 'false']).optional(),
        sort: z.enum(['recent', 'running']).optional(),
        offset: z.coerce.number().int().min(0).max(100000).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .safeParse(req.query);
    if (!parsed.success) return fail(res, 400, '筛选参数无效');
    res.json(await source.list(parsed.data));
  });
  app.get('/api/sessions/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!validId(id)) return fail(res, 400, '会话 ID 无效');
    const parsed = z
      .object({
        before: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .strict()
      .safeParse(req.query);
    if (!parsed.success) return fail(res, 400, '分页参数无效');
    const detail = await source.detail(id, parsed.data.before, parsed.data.limit);
    if (!detail && isPendingCreation(id))
      return res.status(202).set('Retry-After', '1').json({ state: 'syncing' });
    if (!detail) return fail(res, 404, '找不到此会话');
    res.json(detail);
  });
  app.get('/api/sessions/:id/export', async (req, res) => {
    const id = String(req.params.id);
    if (!validId(id)) return fail(res, 400, '会话 ID 无效');
    const content = await source.export(id);
    if (content === null) return fail(res, 404, '找不到此会话');
    res.setHeader('Content-Disposition', `attachment; filename="codex-${id}.md"`);
    res.type('text/markdown').send(content);
  });
  app.get('/api/sessions/:id/outline', async (req, res) => {
    const id = String(req.params.id);
    if (!validId(id)) return fail(res, 400, '会话 ID 无效');
    const outline = await source.outline(id);
    if (!outline) return fail(res, 404, '找不到此会话');
    res.json(outline);
  });
  app.get('/api/sessions/:id/images/:itemId', async (req, res) => {
    const id = String(req.params.id),
      itemId = String(req.params.itemId);
    if (!validId(id) || !/^[A-Za-z0-9_-]{1,200}$/.test(itemId))
      return fail(res, 400, '图片标识无效');
    const parsed = z
      .object({
        index: z.coerce.number().int().min(0).max(10000).optional(),
        ...imagePreviewQuery,
      })
      .strict()
      .safeParse(req.query);
    if (!parsed.success) return fail(res, 400, '图片参数无效');
    try {
      const original = await source.image(id, itemId, parsed.data.index);
      if (!original) return fail(res, 404, '找不到这条图片记录');
      const media = await previews.render(original, parsed.data.variant, parsed.data.format);
      res.type(media.mime).setHeader('Content-Disposition', 'inline');
      if ('file' in media) res.sendFile(media.file, { dotfiles: 'allow' });
      else res.send(media.data);
    } catch (error) {
      if (error instanceof MediaError) return fail(res, error.status, error.message);
      throw error;
    }
  });
  app.get('/api/sessions/:id/computer-use', async (req, res) => {
    const id = String(req.params.id);
    if (!validId(id)) return fail(res, 400, '会话 ID 无效');
    const parsed = z
      .object({
        before: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .strict()
      .safeParse(req.query);
    if (!parsed.success) return fail(res, 400, '分页参数无效');
    const page = await source.computerUse(id, parsed.data.before, parsed.data.limit);
    if (!page) return fail(res, 404, '找不到此会话');
    res.json(page);
  });
  app.get('/api/sessions/:id/computer-use/:itemId/images/:index', async (req, res) => {
    const id = String(req.params.id),
      itemId = String(req.params.itemId);
    const parsed = z.coerce.number().int().min(0).max(10000).safeParse(req.params.index);
    if (!validId(id) || !/^[A-Za-z0-9_-]{1,200}$/.test(itemId) || !parsed.success)
      return fail(res, 400, '截图标识无效');
    const query = z.object(imagePreviewQuery).strict().safeParse(req.query);
    if (!query.success) return fail(res, 400, '图片参数无效');
    const original = await source.computerUseImage(id, itemId, parsed.data);
    if (!original) return fail(res, 404, '这一步没有可用的完整截图');
    const media = await previews.render(original, query.data.variant, query.data.format);
    res.type(media.mime).setHeader('Content-Disposition', 'inline');
    if ('file' in media) res.sendFile(media.file, { dotfiles: 'allow' });
    else res.send(media.data);
  });
}
