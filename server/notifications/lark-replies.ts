import { createHash } from 'node:crypto';
import type { WSClient } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { notificationConfigured, type NotificationConfig } from './store.js';

const messageId = z.string().regex(/^om_[\w-]{1,125}$/);
const imageKey = z.string().regex(/^img_[\w-]{1,200}$/);
const fileKey = z.string().regex(/^file_[\w-]{1,200}$/);
export const LARK_REPLY_MAX_ATTACHMENTS = 5;
export const LARK_REPLY_MAX_BYTES = 20 * 1024 * 1024;
export const LARK_REPLY_HISTORY_LIMIT = 50;
const textContent = z.object({ text: z.string() });
const imageContent = z.object({ image_key: imageKey });
const fileContent = z.object({ file_key: fileKey, file_name: z.string().min(1).max(500) });
const postContent = z.object({
  title: z.string().optional(),
  content: z.array(
    z.array(
      z.object({
        tag: z.string(),
        text: z.string().optional(),
        image_key: z.string().optional(),
        file_key: z.string().optional(),
        file_name: z.string().optional(),
      }),
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
    create_time: z.string().regex(/^\d{12,15}$/).optional(),
    thread_id: z.string().regex(/^omt_[\w-]{1,125}$/).optional(),
    parent_id: z.string().optional(),
    root_id: z.string().optional(),
    chat_id: z.string(),
    chat_type: z.literal('group'),
    message_type: z.string(),
    content: z.string().max(64 * 1024),
    mentions: z.array(z.object({ key: z.string().regex(/^@_user_\d+$/) })).optional(),
  }),
});

const historyPage = z.object({
  items: z.array(z.unknown()).optional().default([]),
  has_more: z.boolean().optional(),
  page_token: z.string().max(2048).optional(),
});
const historyMessage = z.object({
  message_id: messageId,
  parent_id: z.string().optional(),
  root_id: z.string().optional(),
  thread_id: z.string().optional(),
  chat_id: z.string(),
  msg_type: z.string(),
  deleted: z.boolean().optional(),
  sender: z.object({ id: z.string(), id_type: z.string(), sender_type: z.string() }),
  body: z.object({ content: z.string().max(64 * 1024) }).optional(),
  mentions: z.array(z.object({ key: z.string() })).optional(),
});

export type LarkReplyResource = { messageId: string; key: string; name?: string };
export type LarkReplyAttachment = { name?: string; data: Buffer };

export async function larkReplyHistory(
  reply: NonNullable<ReturnType<typeof larkReply>>,
  chatId: string,
  page: (query: URLSearchParams) => Promise<unknown>,
  previouslySubmitted: (id: string) => boolean,
) {
  if (!reply.createdAt) return [];
  const query = new URLSearchParams({
    container_id_type: reply.threadId ? 'thread' : 'chat',
    container_id: reply.threadId ?? chatId,
    sort_type: 'ByCreateTimeDesc',
    page_size: '25',
    end_time: String(Math.floor(reply.createdAt / 1000) + 1),
  });
  const collected: ReturnType<typeof larkMessageContent>[] = [];
  let found = false;
  for (let index = 0; index < 4; index++) {
    const { items, has_more, page_token } = historyPage.parse(await page(query));
    for (const item of items) {
      const parsed = historyMessage.safeParse(item);
      if (!parsed.success) {
        if (found) return collected.reverse();
        continue;
      }
      const msg = parsed.data;
      if (!found) {
        found = msg.message_id === reply.messageId && msg.chat_id === chatId;
        continue;
      }
      if (
        msg.chat_id !== chatId ||
        msg.sender.sender_type !== 'user' ||
        msg.sender.id_type !== 'open_id' ||
        msg.sender.id !== reply.senderId ||
        (msg.thread_id && msg.thread_id !== reply.threadId) ||
        msg.deleted ||
        previouslySubmitted(msg.message_id) ||
        msg.parent_id ||
        msg.root_id
      ) return collected.reverse();
      collected.push(larkMessageContent(msg.message_id, msg.msg_type, msg.body?.content, msg.mentions));
      if (collected.length >= LARK_REPLY_HISTORY_LIMIT) return collected.reverse();
    }
    if (!has_more || !page_token || page_token === query.get('page_token')) break;
    query.set('page_token', page_token);
  }
  return collected.reverse();
}

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
  return {
    messageId: message.message_id,
    senderId: sender.sender_id.open_id,
    createdAt: Number(message.create_time ?? 0),
    threadId: message.thread_id,
    parents,
    ...larkMessageContent(message.message_id, message.message_type, message.content, message.mentions),
  };
}

function larkMessageContent(
  id: string,
  type: string,
  raw?: string,
  mentions?: { key: string }[],
) {
  const reply = { prompt: '', resources: [] as LarkReplyResource[], invalidResource: false };
  let content: unknown;
  try {
    content = JSON.parse(raw ?? '');
  } catch {
    reply.invalidResource = type === 'file' || type === 'image';
    return reply;
  }
  if (type === 'text') {
    const text = textContent.safeParse(content);
    if (text.success) {
      reply.prompt = text.data.text.trim();
      const leadingMention = reply.prompt.match(/^@_user_\d+(?=\s|$)/)?.[0];
      if (leadingMention && mentions?.some(({ key }) => key === leadingMention))
        reply.prompt = reply.prompt.slice(leadingMention.length).trimStart();
    }
  } else if (type === 'image') {
    const image = imageContent.safeParse(content);
    if (image.success) reply.resources.push({ messageId: id, key: image.data.image_key });
    else reply.invalidResource = true;
  } else if (type === 'file') {
    const file = fileContent.safeParse(content);
    if (file.success) reply.resources.push({ messageId: id, key: file.data.file_key, name: file.data.file_name });
    else reply.invalidResource = true;
  } else if (type === 'post') {
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
            if (!key.success) return { ...reply, invalidResource: true };
            reply.resources.push({ messageId: id, key: key.data });
          } else if (node.tag === 'file' || node.tag === 'media') {
            const file = fileContent.safeParse(node);
            if (!file.success) return { ...reply, invalidResource: true };
            reply.resources.push({ messageId: id, key: file.data.file_key, name: file.data.file_name });
          } else if (['text', 'a', 'md', 'code_block'].includes(node.tag) && node.text) text.push(node.text);
        }
        lines.push(text.join(''));
      }
      reply.prompt = lines.join('\n').trim();
    }
  }
  return reply;
}

/** The same incoming Lark message always uses the same Monitor queue receipt. */
export function larkRequestId(destination: string, messageId: string) {
  const hash = createHash('sha256')
    .update(JSON.stringify([destination, messageId, 'submit']))
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
  attachments: LarkReplyAttachment[];
  nextTurn: boolean;
};

export const replyReceipts = {
  sent: { text: '已发送到 Codex 会话。', emoji: 'CheckMark' },
  queued: { text: '已加入 Monitor 消息队列。', emoji: 'OneSecond' },
  unavailable: { text: '此会话已不可发送消息。', emoji: 'CrossMark' },
  offline: {
    text: '工作空间已离线。客户端重新连接后，可以重新引用通知发送。',
    emoji: 'CrossMark',
  },
  upgrade: {
    text: '请更新此工作空间的 Monitor 客户端，再重新引用通知发送。',
    emoji: 'CrossMark',
  },
  failed: { text: '提交失败。请在 Monitor 中查看会话和发送回执。', emoji: 'CrossMark' },
  unknown: {
    text: '暂时无法确认发送结果，请在 Monitor 中查看会话和发送回执。',
    emoji: 'THINKING',
  },
  unsupported: { text: '请引用通知发送文字或图片，文字最多 12000 字符。', emoji: 'CrossMark' },
  imagesTooLarge: { text: '每条回复最多发送 5 张图片，合计不超过 20 MB。', emoji: 'CrossMark' },
  imageFailed: {
    text: '无法读取回复里的图片，消息未提交。请检查机器人图片权限或重新上传图片。',
    emoji: 'CrossMark',
  },
  attachmentFailed: { text: '无法读取或保存回复里的附件，消息未提交。', emoji: 'CrossMark' },
  attachmentsTooLarge: { text: '每次最多合并 5 个附件，合计不超过 20 MB。', emoji: 'CrossMark' },
  historyFailed: { text: '无法读取连续消息，请检查 Lark 群消息历史权限后重试。', emoji: 'CrossMark' },
  busy: { text: '当前处理的回复过多，请稍后重新引用通知发送。', emoji: 'CrossMark' },
};
export type LarkReplyReceipt = keyof typeof replyReceipts;

const reactionByReceipt = new Map(
  Object.values(replyReceipts).map(({ text, emoji }) => [text, emoji]),
);

export function larkReplyReaction(receipt: string) {
  return reactionByReceipt.get(receipt);
}

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
