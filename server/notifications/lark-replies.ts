import { createHash } from 'node:crypto';
import type { WSClient } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { notificationConfigured, type NotificationConfig } from './store.js';

const messageId = z.string().regex(/^om_[\w-]{1,125}$/);
const imageKey = z.string().regex(/^img_[\w-]{1,200}$/);
export const LARK_REPLY_MAX_IMAGES = 5;
export const LARK_REPLY_MAX_BYTES = 20 * 1024 * 1024;
const textContent = z.object({ text: z.string() });
const imageContent = z.object({ image_key: imageKey });
const postContent = z.object({
  title: z.string().optional(),
  content: z.array(
    z.array(
      z.object({ tag: z.string(), text: z.string().optional(), image_key: z.string().optional() }),
    ),
  ),
});
const eventSchema = z.object({
  app_id: z.string().optional(),
  sender: z.object({
    sender_type: z.literal('user'),
    sender_id: z.object({ open_id: z.string() }),
  }),
  message: z.object({
    message_id: messageId,
    parent_id: z.string().optional(),
    root_id: z.string().optional(),
    chat_id: z.string(),
    chat_type: z.literal('group'),
    message_type: z.string(),
    content: z.string().max(64 * 1024),
    mentions: z.array(z.object({ key: z.string().regex(/^@_user_\d+$/) })).optional(),
  }),
});

export function larkReply(config: NotificationConfig, event: unknown) {
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) return;
  const { app_id, sender, message } = parsed.data;
  if (
    (app_id && app_id !== config.appId) ||
    message.chat_id !== config.chatId ||
    !config.replyOpenIds.includes(sender.sender_id.open_id)
  )
    return;
  const parents = [message.parent_id, message.root_id].filter(
    (id): id is string => messageId.safeParse(id).success && id !== message.message_id,
  );
  if (!parents.length) return;
  const reply = { messageId: message.message_id, parents, prompt: '', imageKeys: [] as string[] };
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return reply;
  }
  if (message.message_type === 'text') {
    const text = textContent.safeParse(content);
    if (text.success) {
      reply.prompt = text.data.text.trim();
      const leadingMention = reply.prompt.match(/^@_user_\d+(?=\s|$)/)?.[0];
      if (leadingMention && message.mentions?.some(({ key }) => key === leadingMention))
        reply.prompt = reply.prompt.slice(leadingMention.length).trimStart();
    }
  } else if (message.message_type === 'image') {
    const image = imageContent.safeParse(content);
    if (image.success) reply.imageKeys.push(image.data.image_key);
  } else if (message.message_type === 'post') {
    const direct = postContent.safeParse(content);
    const localized = direct.success
      ? undefined
      : z.record(z.string(), postContent).safeParse(content);
    const post = direct.success
      ? direct.data
      : localized?.success
        ? Object.values(localized.data)[0]
        : undefined;
    if (post) {
      const lines = [post.title ?? ''];
      for (const row of post.content) {
        const text: string[] = [];
        for (const node of row) {
          if (node.tag === 'img') {
            const key = imageKey.safeParse(node.image_key);
            if (!key.success) return { ...reply, imageKeys: [] };
            reply.imageKeys.push(key.data);
          } else if ((node.tag === 'text' || node.tag === 'a') && node.text) text.push(node.text);
        }
        lines.push(text.join(''));
      }
      reply.prompt = lines.join('\n').trim();
    }
  }
  return reply;
}

/** The same incoming Lark message always uses the same Monitor queue receipt. */
export function larkRequestId(destination: string, messageId: string, purpose: 'submit' | 'reply') {
  const hash = createHash('sha256')
    .update(JSON.stringify([destination, messageId, purpose]))
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function larkRepliesEnabled(config: NotificationConfig) {
  return (
    config.enabled &&
    config.mode === 'app' &&
    notificationConfigured(config) &&
    !!config.replyAdminId &&
    !!config.replyOpenIds.length
  );
}

export type LarkReplySubmission = {
  workspaceId: string;
  sessionId: string;
  userId: string;
  requestId: string;
  prompt: string;
  images: Buffer[];
};

export const replyReceipts = {
  sent: '已发送到 Codex 会话。',
  queued: '已加入 Monitor 消息队列。',
  unavailable: '此会话已不可发送消息。',
  offline: '工作空间已离线。客户端重新连接后，可以重新引用通知发送。',
  upgrade: '请更新此工作空间的 Monitor 客户端，再重新引用通知发送。',
  failed: '提交失败。请在 Monitor 中查看会话和发送回执。',
  unknown: '暂时无法确认发送结果，请在 Monitor 中查看会话和发送回执。',
  unsupported: '请引用通知发送文字或图片，文字最多 12000 字符。',
  imagesTooLarge: '每条回复最多发送 5 张图片，合计不超过 20 MB。',
  imageFailed: '无法读取回复里的图片，消息未提交。请检查机器人图片权限或重新上传图片。',
  busy: '当前处理的回复过多，请稍后重新引用通知发送。',
};
export type LarkReplyReceipt = keyof typeof replyReceipts;

export type LarkReplyListener = (
  config: NotificationConfig,
  receive: (event: unknown) => Promise<void>,
) => Pick<WSClient, 'getConnectionStatus' | 'close'>;

export const listenForLarkReplies: LarkReplyListener = (config, receive) => {
  // The SDK can log event contents and request details. Only expose connection state.
  const quiet = () => {};
  const logger = { error: quiet, warn: quiet, info: quiet, debug: quiet, trace: quiet };
  let client: WSClient | undefined;
  let closed = false;
  let failed = false;
  void import('@larksuiteoapi/node-sdk')
    .then(async ({ Domain, EventDispatcher, WSClient }) => {
      if (closed) return;
      client = new WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: config.appRegion === 'feishu' ? Domain.Feishu : Domain.Lark,
        logger,
        handshakeTimeoutMs: 10000,
      });
      const eventDispatcher = new EventDispatcher({ logger }).register({
        'im.message.receive_v1': receive,
      });
      await client.start({ eventDispatcher });
    })
    .catch(() => {
      failed = true;
    });
  return {
    close(options) {
      closed = true;
      client?.close(options);
    },
    getConnectionStatus: () =>
      client?.getConnectionStatus() ?? {
        state: failed ? 'failed' : 'connecting',
        reconnectAttempts: 0,
      },
  };
};
