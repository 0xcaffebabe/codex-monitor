import path from 'node:path';
import { LarkDeliveryError, larkCard, larkRequest, type WebhookTransport } from './lark.js';
import type { NotificationConfig } from './store.js';
import type { NotificationAttachment } from './attachments.js';
import { imageMime } from '../media.js';
import { LARK_REPLY_MAX_BYTES } from './lark-replies.js';

const imageMimes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
export class LarkReplyImageTooLarge extends Error {}
const fileTypes = new Map([
  ['.opus', 'opus'],
  ['.mp4', 'mp4'],
  ['.pdf', 'pdf'],
  ['.doc', 'doc'],
  ['.docx', 'doc'],
  ['.xls', 'xls'],
  ['.xlsx', 'xls'],
  ['.ppt', 'ppt'],
  ['.pptx', 'ppt'],
]);

export class LarkApp {
  private token?: {
    origin: string;
    appId: string;
    appSecret: string;
    value: string;
    until: number;
  };

  constructor(private transport: WebhookTransport = fetch) {}

  private async request(
    origin: string,
    endpoint: string,
    body: object,
    signal: AbortSignal,
    action: string,
    token?: string,
  ) {
    const result = await larkRequest(
      origin + '/open-apis/' + endpoint,
      body,
      signal,
      this.transport,
      token,
    );
    const code = result?.code;
    if (code === 0) return result;
    if (typeof code !== 'number') throw new LarkDeliveryError('飞书/Lark 返回了无效响应');
    if (code === 99991663 || code === 99991664) this.token = undefined;
    throw new LarkDeliveryError(
      `飞书/Lark ${action}失败（错误码 ${code}），请检查应用凭据、机器人权限和群聊设置`,
      [99991400, 99991663, 99991664, 230020].includes(code),
    );
  }

  async sender(config: NotificationConfig, signal: AbortSignal) {
    const origin =
      config.appRegion === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com';
    const { appId, appSecret, chatId } = config;
    let token = this.token;
    if (
      !token ||
      token.origin !== origin ||
      token.appId !== appId ||
      token.appSecret !== appSecret ||
      token.until <= Date.now()
    ) {
      const result = await this.request(
        origin,
        'auth/v3/tenant_access_token/internal',
        { app_id: appId, app_secret: appSecret },
        signal,
        '获取应用令牌',
      );
      if (typeof result?.tenant_access_token !== 'string' || !result.tenant_access_token)
        throw new LarkDeliveryError('飞书/Lark 未返回应用令牌');
      const expire = typeof result.expire === 'number' ? result.expire : 0;
      token = {
        origin,
        appId,
        appSecret,
        value: result.tenant_access_token,
        until: Date.now() + Math.max(0, expire - 60) * 1000,
      };
      this.token = token;
    }
    const value = token.value;
    const send = (uuid: string, msgType: string, content: object) =>
      this.request(
        origin,
        'im/v1/messages?receive_id_type=chat_id',
        {
          receive_id: chatId,
          msg_type: msgType,
          content: JSON.stringify(content),
          uuid,
        },
        signal,
        '发送群消息',
        value,
      );
    return {
      card: async (uuid: string, text: string) => {
        const result = await send(uuid, 'interactive', larkCard(text, true));
        const messageId = result?.data?.message_id;
        return typeof messageId === 'string' && /^om_[\w-]{1,125}$/.test(messageId) ? messageId : undefined;
      },
      react: (messageId: string, emoji: string) =>
        this.request(
          origin,
          `im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
          { reaction_type: { emoji_type: emoji } },
          signal,
          '添加消息表情',
          value,
        ),
      readReplyImages: async (messageId: string, keys: string[]) => {
        const images: Buffer[] = [];
        let remaining = LARK_REPLY_MAX_BYTES;
        const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
        for (const key of keys) {
          const response = await this.transport(
            `${origin}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=image`,
            {
              method: 'GET',
              headers: { Authorization: `Bearer ${value}` },
              redirect: 'error',
              signal: downloadSignal,
            },
          );
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new LarkDeliveryError('无法读取飞书/Lark 回复图片');
          }
          if (Number(response.headers.get('content-length')) > remaining) {
            await response.body.cancel();
            throw new LarkReplyImageTooLarge();
          }
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              remaining -= value.length;
              if (remaining < 0) {
                await reader.cancel();
                throw new LarkReplyImageTooLarge();
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          const image = Buffer.concat(chunks);
          if (!imageMime(image.subarray(0, 16)))
            throw new LarkDeliveryError('飞书/Lark 返回了不支持的图片格式');
          images.push(image);
        }
        return images;
      },
      attachment: async (uuid: string, file: NotificationAttachment) => {
        const image = imageMimes.has(file.mime) && file.data.length <= 10 * 1024 * 1024;
        const form = new FormData();
        const blob = new Blob([new Uint8Array(file.data)], { type: file.mime });
        if (image) {
          form.set('image_type', 'message');
          form.set('image', blob, file.name);
        } else {
          form.set('file_type', fileTypes.get(path.extname(file.name).toLowerCase()) ?? 'stream');
          form.set('file_name', file.name);
          form.set('file', blob, file.name);
        }
        const result = await this.request(
          origin,
          image ? 'im/v1/images' : 'im/v1/files',
          form,
          signal,
          '上传附件',
          value,
        );
        const key = image ? result?.data?.image_key : result?.data?.file_key;
        if (typeof key !== 'string' || !key)
          throw new LarkDeliveryError('飞书/Lark 未返回附件标识');
        await send(uuid, image ? 'image' : 'file', image ? { image_key: key } : { file_key: key });
      },
    };
  }
}
