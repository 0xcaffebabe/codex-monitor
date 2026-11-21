import type { Express } from 'express';
import { z } from 'zod';
import type { SessionFilePreviews } from '../file-preview.js';
import { ImagePreviews, imagePreviewQuery } from '../image-previews.js';
import { MediaError } from '../media.js';
import { validId } from '../source/session.js';
import { admin, fail } from './access.js';

const query = z
  .object({
    view: z.enum(['preview', 'image', 'download']).default('preview'),
    ...imagePreviewQuery,
  })
  .strict();

export function installFilePreviewRoutes(
  app: Express,
  files: SessionFilePreviews,
  images: ImagePreviews,
) {
  app.get('/api/sessions/:id/file-preview/:itemId/:linkId', admin, async (req, res) => {
    const { id, itemId, linkId } = req.params as Record<string, string>;
    const parsed = query.safeParse(req.query);
    if (
      !validId(id) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(itemId) ||
      !/^[a-f\d]{64}$/.test(linkId) ||
      !parsed.success
    )
      return fail(res, 400, '文件引用参数无效');
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const { view, variant, format } = parsed.data;
      const file = await files.read(id, itemId, linkId, view, controller.signal);
      if (controller.signal.aborted) return;
      res.setHeader('Cache-Control', 'no-store');
      if (!('data' in file)) return res.json(file);
      if (view === 'download') return res.attachment(file.name).type(file.mime).send(file.data);
      const image = await images.render({ data: file.data, mime: file.mime }, variant, format);
      if (!controller.signal.aborted && 'data' in image)
        res.type(image.mime).setHeader('Content-Disposition', 'inline').send(image.data);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof MediaError) return fail(res, error.status, error.message);
      throw error;
    } finally {
      res.off('close', abort);
    }
  });
}
