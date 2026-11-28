import { gitCommitShortcuts } from '../../src/shared/git-commit-shortcuts.js';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { larkMarkdown } from './lark-markdown.js';
import { limitMarkdown } from './markdown-limit.js';

// Leave room for the card envelope within the request limit.
const LARK_MARKDOWN_BYTES = 16 * 1024;

export class LarkDeliveryError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public code?: number,
  ) {
    super(message);
  }
}

export type LarkTransport = typeof fetch;

export const larkReplyForm = {
  inputName: 'session_reply',
  submitName: 'send_to_session',
  maxLength: 1000,
} as const;

export type LarkCardReply = { status: string; text?: string };
export type LarkCompletionStyle = 'read-only' | 'interactive';
const completionTitle = 'Codex 本轮已结束';
const legacyCompletionHeading = `✅ ${completionTitle}\n`;

export function larkCard(
  text: string,
  { completion, reply }: { completion?: LarkCompletionStyle; reply?: LarkCardReply } = {},
) {
  return larkCardFromMarkdown(larkCardMarkdown(text), completion, reply);
}

export function larkCardMarkdown(text: string, images?: ReadonlyMap<string, string>) {
  return limitMarkdown(
    larkMarkdown(text, images),
    (markdown) => Buffer.byteLength(JSON.stringify(markdown)) <= LARK_MARKDOWN_BYTES,
  );
}

export function larkCardImageKeys(markdown: string) {
  const keys = new Set<string>();
  const pending: Nodes[] = [fromMarkdown(markdown)];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'image') keys.add(node.url);
    if ('children' in node) pending.push(...node.children);
  }
  return keys;
}

export function larkCardFromMarkdown(content: string, completion?: LarkCompletionStyle, reply?: LarkCardReply) {
  // Queued deliveries and previously sent cards may still carry the title in the body.
  if (completion && content.startsWith(legacyCompletionHeading))
    content = content.slice(legacyCompletionHeading.length);
  const completionActions = completion === 'interactive';
  return {
    schema: '2.0',
    ...(completionActions && { config: { update_multi: true } }),
    ...(completion && { header: { title: { tag: 'plain_text', content: completionTitle }, template: 'green' } }),
    body: {
      elements: [
        { tag: 'markdown', content },
        ...(completionActions ? [
          ...(reply?.text ? [{
            tag: 'column_set',
            background_style: 'blue-50',
            columns: [{
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '8px 12px',
              vertical_spacing: '4px',
              elements: [
                {
                  tag: 'div',
                  text: { tag: 'plain_text', content: '追加消息 · 已发送', text_size: 'notation', text_color: 'blue' },
                },
                { tag: 'div', text: { tag: 'plain_text', content: reply.text } },
              ],
            }],
          }] : reply ? [{ tag: 'div', text: { tag: 'plain_text', content: reply.status } }] : []),
          {
            tag: 'form' as const,
            name: 'reply_to_session',
            elements: [
              {
                tag: 'input',
                name: larkReplyForm.inputName,
                placeholder: { tag: 'plain_text', content: '输入后续消息' },
                input_type: 'multiline_text',
                rows: 2,
                width: 'fill',
                ...(reply && { default_value: '' }),
                required: true,
                max_length: larkReplyForm.maxLength,
              },
              {
                tag: 'button',
                name: larkReplyForm.submitName,
                text: { tag: 'plain_text', content: '发送到会话' },
                type: 'primary',
                form_action_type: 'submit',
              },
            ],
          },
          {
            tag: 'column_set' as const,
            flex_mode: 'flow',
            columns: gitCommitShortcuts.map(({ id, label }) => ({
              tag: 'column',
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: label },
                behaviors: [{ type: 'callback', value: { shortcut: id } }],
              }],
            })),
          },
        ] : []),
      ] as const,
    },
  };
}

export async function larkRequest(
  url: string,
  body: object | undefined,
  signal: AbortSignal,
  transport: LarkTransport,
  token?: string,
  maxResponseBytes = 16384,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' = body ? 'POST' : 'GET',
) {
  try {
    const multipart = body instanceof FormData;
    const response = await transport(url, {
      method,
      headers: {
        ...(!body || multipart ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: multipart ? body : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(multipart ? 30000 : 10000)]),
    });
    if (!response.ok && (body || ![400, 403].includes(response.status))) {
      await response.body?.cancel();
      throw new LarkDeliveryError(
        `飞书/Lark HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new LarkDeliveryError('飞书/Lark 返回了空响应');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxResponseBytes) {
          await reader.cancel();
          throw new LarkDeliveryError('飞书/Lark 响应内容过大');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        code?: unknown;
        tenant_access_token?: unknown;
        expire?: unknown;
        bot?: { open_id?: unknown };
        data?: {
          image_key?: unknown;
          file_key?: unknown;
          message_id?: unknown;
          chat_id?: unknown;
          reaction_id?: unknown;
          items?: unknown;
          bot?: { open_id?: unknown };
        };
      } | null;
    } catch {
      throw new LarkDeliveryError('飞书/Lark 返回了无效响应');
    }
  } catch (error) {
    if (error instanceof LarkDeliveryError) throw error;
    // Fetch errors can contain provider URLs; never expose them.
    throw new LarkDeliveryError('飞书/Lark 连接失败或超时', true);
  }
}
