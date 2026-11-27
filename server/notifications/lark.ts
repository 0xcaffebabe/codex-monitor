import { createHmac } from 'node:crypto';
import { larkMarkdown } from './lark-markdown.js';
import { limitMarkdown } from './markdown-limit.js';

// Leave room for the card envelope and webhook signature within the request limit.
const LARK_MARKDOWN_BYTES = 16 * 1024;

export function validLarkWebhook(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]{16,100}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export class LarkDeliveryError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public code?: number,
  ) {
    super(message);
  }
}

export type WebhookTransport = typeof fetch;

export function larkCard(text: string, app = false) {
  const content = limitMarkdown(
    larkMarkdown(text, app),
    (markdown) => Buffer.byteLength(JSON.stringify(markdown)) <= LARK_MARKDOWN_BYTES,
  );
  return {
    schema: '2.0',
    body: { elements: [{ tag: 'markdown', content }] },
  };
}

/** Only this adapter handles credentials and the provider's wire format. */
export async function sendLark(
  config: { webhookUrl: string; signingSecret: string },
  text: string,
  signal: AbortSignal,
  transport: WebhookTransport = fetch,
) {
  if (!validLarkWebhook(config.webhookUrl))
    throw new LarkDeliveryError('请配置有效的飞书/Lark Webhook');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = {
    msg_type: 'interactive',
    card: larkCard(text),
    ...(config.signingSecret
      ? {
          timestamp,
          sign: createHmac('sha256', `${timestamp}\n${config.signingSecret}`)
            .update('')
            .digest('base64'),
        }
      : {}),
  };
  const result = await larkRequest(config.webhookUrl, body, signal, transport);
  const code = result?.code ?? result?.StatusCode;
  if (typeof code !== 'number') throw new LarkDeliveryError('飞书/Lark 返回了无效响应');
  if (code === 11246)
    throw new LarkDeliveryError(
      '飞书/Lark 消息内容创建失败（错误码 11246），请检查卡片格式及图片资源',
    );
  if (code !== 0)
    throw new LarkDeliveryError(`飞书/Lark 拒绝消息（错误码 ${code}），请检查机器人安全设置`);
}

export async function larkRequest(
  url: string,
  body: object | undefined,
  signal: AbortSignal,
  transport: WebhookTransport,
  token?: string,
  maxResponseBytes = 16384,
  method: 'GET' | 'POST' | 'DELETE' = body ? 'POST' : 'GET',
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
        StatusCode?: unknown;
        tenant_access_token?: unknown;
        expire?: unknown;
        data?: {
          image_key?: unknown;
          file_key?: unknown;
          message_id?: unknown;
          reaction_id?: unknown;
          items?: unknown;
        };
      } | null;
    } catch {
      throw new LarkDeliveryError('飞书/Lark 返回了无效响应');
    }
  } catch (error) {
    if (error instanceof LarkDeliveryError) throw error;
    // Fetch errors can contain the complete webhook URL; never expose them.
    throw new LarkDeliveryError('飞书/Lark 连接失败或超时', true);
  }
}
