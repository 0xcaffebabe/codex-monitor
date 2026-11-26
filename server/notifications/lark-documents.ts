import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { LarkDeliveryError } from './lark.js';

const token = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const documentTypes = { doc: 'doc', docx: 'docx', sheets: 'sheet', base: 'bitable', wiki: 'wiki' } as const;
const extensions = { doc: 'docx', docx: 'docx', sheet: 'xlsx', bitable: 'xlsx' } as const;
const exportType = z.enum(['doc', 'docx', 'sheet', 'bitable']);
export type LarkDocument = { type: z.infer<typeof exportType> | 'wiki'; token: string };

export function larkDocuments(text: string): LarkDocument[] {
  const documents: LarkDocument[] = [];
  for (const match of text.matchAll(/https:\/\/[^\s<>()\[\]{}"'，。；！、]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[.,;!]+$/, ''));
      if (url.username || url.password || url.port ||
        !/(?:^|\.)(?:larksuite\.com|feishu\.cn)$/i.test(url.hostname)) continue;
      const link = /^\/(doc|docx|sheets|base|wiki)\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
      if (link) documents.push({ type: documentTypes[link[1] as keyof typeof documentTypes], token: link[2] });
    } catch {
      // Ignore malformed links.
    }
  }
  return documents;
}

const wikiNode = z.object({ node: z.object({ obj_token: token, obj_type: exportType }) });
const exportTicket = z.object({ ticket: token });
const exportResult = z.object({
  result: z.object({
    job_status: z.number().int(),
    file_token: token.optional(),
    file_name: z.string().min(1).max(500).optional(),
    file_size: z.number().int().nonnegative().optional(),
  }),
});

export async function larkDocumentExport(
  document: LarkDocument,
  request: (endpoint: string, body?: object) => Promise<unknown>,
  signal: AbortSignal,
) {
  let { type, token: documentToken } = document;
  if (type === 'wiki') {
    const params = new URLSearchParams({ token: documentToken });
    const resolved = wikiNode.safeParse(await request(`wiki/v2/spaces/get_node?${params}`));
    if (!resolved.success) throw new LarkDeliveryError('无法读取受支持的飞书/Lark 知识库节点');
    ({ obj_type: type, obj_token: documentToken } = resolved.data.node);
  }
  const extension = extensions[type];
  const task = exportTicket.safeParse(await request('drive/v1/export_tasks', {
    file_extension: extension,
    token: documentToken,
    type,
  }));
  if (!task.success) throw new LarkDeliveryError('飞书/Lark 未返回导出任务 ID');
  const params = new URLSearchParams({ token: documentToken });
  const endpoint = `drive/v1/export_tasks/${task.data.ticket}?${params}`;
  for (;;) {
    signal.throwIfAborted();
    const status = exportResult.safeParse(await request(endpoint));
    if (!status.success) throw new LarkDeliveryError('飞书/Lark 返回了无效的导出结果');
    const { job_status, file_token, file_name, file_size } = status.data.result;
    if (job_status === 0 && file_token) {
      const suffix = `.${extension}`;
      const title = file_name ?? 'Lark 云文档';
      const stem = title.toLowerCase().endsWith(suffix) ? title.slice(0, -suffix.length) : title;
      return {
        endpoint: `drive/v1/export_tasks/file/${file_token}/download`,
        name: `${stem.slice(0, 150)}${suffix}`,
        size: file_size,
      };
    }
    if (job_status !== 1 && job_status !== 2)
      throw new LarkDeliveryError(`飞书/Lark 云文档导出失败（任务状态 ${job_status}）`);
    await delay(700, undefined, { signal });
  }
}
