import { createHmac } from 'node:crypto';

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
  ) {
    super(message);
  }
}

export type WebhookTransport = typeof fetch;

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
    msg_type: 'text',
    // Neutralize mention markup in session titles and model-generated text.
    content: { text: text.replaceAll('<', '＜').replaceAll('>', '＞') },
    ...(config.signingSecret
      ? {
          timestamp,
          sign: createHmac('sha256', `${timestamp}\n${config.signingSecret}`)
            .update('')
            .digest('base64'),
        }
      : {}),
  };
  try {
    const response = await transport(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) {
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
        if (size > 16384) {
          await reader.cancel();
          throw new LarkDeliveryError('飞书/Lark 响应内容过大');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let result: { code?: unknown; StatusCode?: unknown };
    try {
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new LarkDeliveryError('飞书/Lark 返回了无效响应');
    }
    const code = result?.code ?? result?.StatusCode;
    if (typeof code !== 'number') throw new LarkDeliveryError('飞书/Lark 返回了无效响应');
    if (code !== 0)
      throw new LarkDeliveryError(`飞书/Lark 拒绝消息（错误码 ${code}），请检查机器人安全设置`);
  } catch (error) {
    if (error instanceof LarkDeliveryError) throw error;
    // Fetch errors can contain the complete webhook URL; never expose them.
    throw new LarkDeliveryError('飞书/Lark 连接失败或超时', true);
  }
}
