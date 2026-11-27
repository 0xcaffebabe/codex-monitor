import path from 'node:path';
import { z } from 'zod';
import { LarkDeliveryError, larkCard, larkCardFromMarkdown, larkRequest, type LarkCardReply, type WebhookTransport } from './lark.js';
import type { NotificationConfig } from './store.js';
import type { NotificationAttachment } from './attachments.js';
import { imageMime } from '../media.js';
import { LARK_REPLY_MAX_BYTES, type LarkReplyAttachment, type LarkReplyResource } from './lark-replies.js';
import { larkDocumentExport } from './lark-documents.js';

const imageMimes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const cardMessage = z.array(z.object({
  message_id: z.string(),
  chat_id: z.string(),
  msg_type: z.literal('interactive'),
  body: z.object({ content: z.string().max(64 * 1024) }),
})).nonempty();
const cardMarkdown = z.object({
  schema: z.literal('2.0'),
  body: z.object({ elements: z.tuple([
    z.object({ tag: z.literal('markdown'), content: z.string() }),
  ]).rest(z.unknown()) }),
});
export class LarkReplyAttachmentsTooLarge extends Error {}
export class LarkReplyDocumentError extends Error {}
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
    botOpenId?: string;
  };

  constructor(private transport: WebhookTransport = fetch) {}

  private async download(url: string, token: string, signal: AbortSignal, limit: number) {
    const response = await this.transport(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new LarkDeliveryError('无法读取飞书/Lark 回复附件');
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body.cancel();
      throw new LarkReplyAttachmentsTooLarge();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          throw new LarkReplyAttachmentsTooLarge();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  }

  private async request(
    origin: string,
    endpoint: string,
    body: object | undefined,
    signal: AbortSignal,
    action: string,
    token?: string,
    method?: 'DELETE' | 'PATCH',
  ) {
    const result = await larkRequest(
      origin + '/open-apis/' + endpoint,
      body,
      signal,
      this.transport,
      token,
      body ? undefined : 2 * 1024 * 1024,
      method,
    );
    const code = result?.code;
    if (code === 0) return result;
    if (typeof code !== 'number') throw new LarkDeliveryError('飞书/Lark 返回了无效响应');
    if (code === 99991663 || code === 99991664) this.token = undefined;
    throw new LarkDeliveryError(
      `飞书/Lark ${action}失败（错误码 ${code}），请检查应用凭据、机器人权限和群聊设置`,
      [99991400, 99991663, 99991664, 230020].includes(code),
      code,
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
      botOpenId: async () => {
        if (token.botOpenId) return token.botOpenId;
        const result = await this.request(origin, 'bot/v3/info', undefined, signal, '查询机器人身份', value);
        const id = result?.bot?.open_id ?? result?.data?.bot?.open_id;
        if (typeof id !== 'string' || !/^ou_[\w-]{1,100}$/.test(id))
          throw new LarkDeliveryError('飞书/Lark 未返回机器人 Open ID');
        token.botOpenId = id;
        return id;
      },
      replyCard: async (parent: string, uuid: string, card: string | object) => {
        const result = await this.request(
          origin,
          `im/v1/messages/${encodeURIComponent(parent)}/reply`,
          { msg_type: 'interactive', content: JSON.stringify(typeof card === 'string' ? larkCard(card, true) : card), uuid },
          signal,
          '回复群消息',
          value,
        );
        const id = result?.data?.message_id;
        if (typeof id !== 'string' || !/^om_[\w-]{1,125}$/.test(id))
          throw new LarkDeliveryError('飞书/Lark 未返回回复消息 ID', true);
        return id;
      },
      message: async (id: string) =>
        (await this.request(origin, `im/v1/messages/${encodeURIComponent(id)}`, undefined, signal, '读取引用消息', value))?.data,
      card: async (uuid: string, text: string, completionActions = false) => {
        const result = await send(uuid, 'interactive', larkCard(text, true, completionActions));
        const messageId = result?.data?.message_id;
        return typeof messageId === 'string' && /^om_[\w-]{1,125}$/.test(messageId) ? messageId : undefined;
      },
      completeCardReply: async (messageId: string, reply: LarkCardReply, text?: string, updateToken?: string) => {
        const endpoint = `im/v1/messages/${encodeURIComponent(messageId)}`;
        let card;
        if (text === undefined) {
          const result = await this.request(origin, `${endpoint}?card_msg_content_type=user_card_content`,
            undefined, signal, '读取原通知卡片', value);
          const message = cardMessage.safeParse(result?.data?.items).data?.[0];
          if (message?.message_id !== messageId || message.chat_id !== chatId)
            throw new LarkDeliveryError('飞书/Lark 未返回原通知卡片');
          let raw: unknown;
          try {
            raw = JSON.parse(message.body.content);
          } catch {
            throw new LarkDeliveryError('飞书/Lark 返回了无效的原通知卡片');
          }
          const original = cardMarkdown.safeParse(raw).data;
          if (!original) throw new LarkDeliveryError('飞书/Lark 返回了无效的原通知卡片');
          card = larkCardFromMarkdown(original.body.elements[0].content, true, reply);
          if (updateToken) {
            await this.request(origin, 'interactive/v1/card/update', { token: updateToken, card },
              signal, '更新通知卡片', value);
            return;
          }
        } else {
          card = larkCard(text, true, true, reply);
        }
        await this.request(origin, endpoint, { content: JSON.stringify(card) }, signal, '更新通知卡片', value, 'PATCH');
      },
      isRead: async (messageId: string) => {
        const result = await this.request(
          origin,
          `im/v1/messages/${encodeURIComponent(messageId)}/read_users?user_id_type=open_id&page_size=1`,
          undefined,
          signal,
          '查询消息已读状态',
          value,
        );
        const items = result?.data?.items;
        if (items == null) return false;
        if (!Array.isArray(items)) throw new LarkDeliveryError('飞书/Lark 返回了无效的已读列表');
        return items.length > 0;
      },
      react: async (messageId: string, emoji: string) => {
        const result = await this.request(
          origin,
          `im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
          { reaction_type: { emoji_type: emoji } },
          signal,
          '添加消息表情',
          value,
        );
        const reactionId = result?.data?.reaction_id;
        return typeof reactionId === 'string' && reactionId ? reactionId : undefined;
      },
      removeReaction: (messageId: string, reactionId: string) =>
        this.request(
          origin,
          `im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
          undefined,
          signal,
          '删除消息表情',
          value,
          'DELETE',
        ),
      history: async (query: URLSearchParams) =>
        (await this.request(origin, `im/v1/messages?${query}`, undefined, signal, '读取群消息历史', value))?.data,
      readReplyAttachments: async (resources: LarkReplyResource[]) => {
        const attachments: LarkReplyAttachment[] = [];
        let remaining = LARK_REPLY_MAX_BYTES;
        const timeout = resources.some((resource) => 'document' in resource) ? 45000 : 20000;
        const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
        for (const resource of resources) {
          const document = 'document' in resource;
          try {
            const file = document
              ? await larkDocumentExport(
                  resource.document,
                  async (endpoint, body) => (await this.request(
                    origin, endpoint, body, downloadSignal, '导出云文档', value,
                  ))?.data,
                  downloadSignal,
                )
              : {
                  endpoint: `im/v1/messages/${encodeURIComponent(resource.messageId)}/resources/${encodeURIComponent(resource.key)}?type=${resource.name ? 'file' : 'image'}`,
                  name: resource.name,
                  size: undefined,
                };
            if (file.size !== undefined && file.size > remaining)
              throw new LarkReplyAttachmentsTooLarge();
            const data = await this.download(
              `${origin}/open-apis/${file.endpoint}`, value, downloadSignal, remaining,
            );
            if (
              !data.length ||
              (document && (data.length < 4 || data.readUInt32BE(0) !== 0x504b0304)) ||
              (!file.name && !imageMime(data.subarray(0, 16)))
            ) throw new LarkDeliveryError('飞书/Lark 返回了不支持的附件格式');
            remaining -= data.length;
            attachments.push({ data, name: file.name });
          } catch (error) {
            if (!document || error instanceof LarkReplyAttachmentsTooLarge) throw error;
            throw new LarkReplyDocumentError('无法导出飞书/Lark 云文档', { cause: error });
          }
        }
        return attachments;
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
