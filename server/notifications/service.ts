import type { DatabaseSync } from 'node:sqlite';
import type { CompletionNotification, LarkStartTarget } from '../../src/types.js';
import { LarkDeliveryError, larkReplyForm, sendLark, type WebhookTransport } from './lark.js';
import {
  NotificationStore,
  notificationConfigured,
  type NotificationConfig,
  type NotificationInput,
  type PendingDelivery,
} from './store.js';
import { notificationKey, type NotificationEvent, type NotificationPolicy, type NotificationReport } from './events.js';
import { notificationMessage } from './messages.js';
import { CompletionNotifications } from './completions.js';
import { LarkApp, LarkReplyAttachmentsTooLarge, LarkReplyDocumentError, type LarkRecipient } from './lark-app.js';
import {
  larkCompletionAction,
  larkCardAction,
  larkRepliesEnabled,
  larkReply,
  larkReplyHistory,
  larkReplyReaction,
  larkQuotedResources,
  larkStartContent,
  larkStartMentions,
  larkRequestId,
  listenForLarkReplies,
  LARK_REPLY_MAX_ATTACHMENTS,
  replyReceipts,
  type LarkActionResponse,
  type LarkReplyListener,
  type LarkReplyReceipt,
  type LarkReplyResult,
  type LarkReplySubmission,
  type LarkStartResult,
  type LarkStartProject,
  type LarkStartSubmission,
} from './lark-replies.js';
import {
  NOTIFICATION_ATTACHMENT_LIMIT,
  type NotificationAttachmentRef,
  type NotificationAttachmentResult,
} from './attachments.js';
import { LarkHelp } from './lark-help.js';
import type { HelpSnapshot } from './help-snapshot.js';

const LARK_READ_POLL_MS = 10_000;
const LARK_READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LARK_REPLY_POLL_MS = 3_000;
const START_UNKNOWN = '暂时无法确认会话是否已创建。请在 Monitor 检查会话记录，避免重复提交。';
const helpCommand = /^\/?help$/i;
const markdownLabel = (value: string) => value.replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>~]/g, '\\$&');
function cardReplyNotice(result: LarkReplyReceipt, error?: string) {
  const reason = error || replyReceipts[result].text;
  if (result === 'unknown')
    return error ? `Codex 消息发送结果待确认。\n${error}` : reason;
  return `发送到 Codex 会话失败。\n${reason}`;
}
type ReportedCompletion = Extract<NotificationEvent, { kind: 'session.completed' }>;
type StartTarget = { workspaceId: string; project: LarkStartProject; label: string; prompt: string };

const namedTarget = /^("(?:[^"\\]|\\["\\])+"|[^\s/"\\:：]+)\/("(?:[^"\\]|\\["\\])+"|[^\s/"\\]+)(?=\s|$)/u;
const unquoteTargetName = (name: string) =>
  name[0] === '"' ? name.slice(1, -1).replace(/\\(["\\])/g, '$1') : name;

/** Server-owned configuration and durable delivery queue, independent of clients and browsers. */
export class NotificationService {
  readonly store: NotificationStore;
  readonly completions: CompletionNotifications;
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private busy?: Promise<void>;
  private testTask?: Promise<PendingDelivery>;
  private lastTestAt = 0;
  private abort = new AbortController();
  private destination = new AbortController();
  private deliveryDestination = new AbortController();
  private replyAuthorization = new AbortController();
  private app: LarkApp;
  private help = new LarkHelp();
  private larkReadTimer?: ReturnType<typeof setInterval>;
  private larkReadScan?: Promise<void>;
  private larkReadCards = new Map<number, { deliveryId: string; messageIds: Set<string>; expiresAt: number }>();
  private larkReadStatus = new Map<string, string>();
  private replyConnection?: ReturnType<LarkReplyListener>;
  private replyDestination?: string;
  private replies = new Map<string, { accepted: Promise<string | undefined>; feedback: Promise<void> }>();
  private replyScan?: Promise<void>;
  private startScan?: Promise<void>;
  private starts = new Map<string, Promise<void>>();
  private startingWorkspaces = new Map<string, { active: number; completions: Map<string, ReportedCompletion> }>();
  private replyDownloads = 0;
  private monitorErrors = new Map<string, string>();
  onConfigure?: (policy: NotificationPolicy, reset: boolean) => Promise<void>;
  readAttachment?: (
    workspaceId: string,
    ref: NotificationAttachmentRef,
    signal: AbortSignal,
  ) => Promise<NotificationAttachmentResult>;
  constructor(
    private db: DatabaseSync,
    pollMs: number,
    private transport?: WebhookTransport,
    private listenForReplies: LarkReplyListener = listenForLarkReplies,
  ) {
    this.store = new NotificationStore(db);
    this.app = new LarkApp(transport);
    this.completions = new CompletionNotifications(db);
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref();
    void this.poll();
  }
  state() {
    return {
      settings: {
        ...this.store.publicConfig([...this.monitorErrors.values()].join('；')),
        replyConnection: this.replyConnection?.getConnectionStatus().state,
      },
      deliveries: this.store.history().map((delivery) => ({
        ...delivery,
        larkReadStatus: this.larkReadStatus.get(delivery.id),
      })),
    };
  }
  policy(): NotificationPolicy {
    const { enabled, enabledAt, inputSince, revision } = this.store.config();
    return { enabled, enabledAt, inputSince, revision, completionSince: this.completions.since };
  }
  async configure(
    input: NotificationInput,
    authorized: () => boolean | Promise<boolean> = () => true,
    adminId?: string,
  ) {
    const old = this.store.config();
    const next = { ...old, ...input };
    const connectionChanged =
      next.mode !== old.mode ||
      (next.mode === 'app'
        ? next.appRegion !== old.appRegion ||
          next.appId !== old.appId ||
          next.appSecret !== old.appSecret ||
          next.chatId !== old.chatId
        : next.webhookUrl !== old.webhookUrl || next.signingSecret !== old.signingSecret);
    const openIdsChanged = next.replyOpenIds.length !== old.replyOpenIds.length ||
      next.replyOpenIds.some((id) => !old.replyOpenIds.includes(id));
    const changed = connectionChanged || (next.mode === 'app' && (
      next.appRecipientType !== old.appRecipientType || (next.appRecipientType === 'private' && openIdsChanged)
    ));
    const reset = input.enabled && (!old.enabled || changed);
    if (!(await authorized())) throw new Error('登录或操作权限已失效，请重新登录');
    if (this.store.config().revision !== old.revision)
      throw new Error('通知配置已被其他请求更新，请刷新后重试');
    if (this.closed) throw new Error('服务正在停止');
    this.store.save(
      input,
      Math.floor(Date.now() / 1000) * 1000,
      reset,
      connectionChanged,
      input.replyOpenIds?.length ? adminId : undefined,
    );
    if (input.replyOpenIds && (
      (adminId && input.replyOpenIds.length > 0 && adminId !== old.replyAdminId) ||
      openIdsChanged
    )) {
      this.replyAuthorization.abort();
      this.replyAuthorization = new AbortController();
    }
    const disabled = old.enabled && !input.enabled;
    if (connectionChanged || disabled) {
      this.destination.abort();
      this.destination = new AbortController();
    }
    if (changed || disabled) {
      this.deliveryDestination.abort();
      this.deliveryDestination = new AbortController();
      for (const { deliveryId } of this.larkReadCards.values())
        this.setLarkReadStatus(deliveryId, 'Lark 已读查询已停止，通知接收配置已变更或关闭');
      this.larkReadCards.clear();
      this.stopLarkReadTimer();
    }
    this.monitorErrors.clear();
    this.syncReplyListener();
    await this.onConfigure?.(this.policy(), reset);
    return this.state();
  }
  submitReply?: (input: LarkReplySubmission, signal: AbortSignal) => Promise<LarkReplyResult>;
  startSession?: (input: LarkStartSubmission, signal: AbortSignal) => Promise<LarkStartResult>;
  workspaceName?: (id: string) => string | undefined;
  workspacesNamed?: (name: string) => readonly { id: string }[];
  helpWorkspaces?: () => { id: string; name: string; online: boolean; readable: boolean }[];
  readHelpSnapshot?: (workspaceId: string, details: boolean, signal: AbortSignal) => Promise<HelpSnapshot | undefined>;
  readReplyStatus?: (
    workspaceId: string, userId: string, requestId: string, signal: AbortSignal,
  ) => Promise<LarkReplyResult | undefined>;
  startReplies(submit: NonNullable<NotificationService['submitReply']>) {
    this.submitReply = submit;
    this.syncReplyListener();
  }
  private syncReplyListener() {
    const config = this.store.config();
    const destination = !this.closed && this.submitReply && larkRepliesEnabled(config)
      ? config.larkDestination
      : undefined;
    if (destination === this.replyDestination) return;
    this.replyConnection?.close({ force: true });
    this.replyDestination = destination;
    this.replyConnection = destination
      ? this.listenForReplies(config, (event) => this.receiveReply(destination, event),
        (event) => this.receiveCompletionAction(destination, event))
      : undefined;
  }
  private async receiveCompletionAction(destination: string, event: unknown): Promise<LarkActionResponse | undefined> {
    if (this.closed || destination !== this.replyDestination || !this.submitReply) return;
    const config = this.store.config();
    const callback = larkCardAction(config, event);
    if (!callback) return;
    const target = this.store.larkTarget(destination, callback.messageId, true);
    if (target && (target.chatId ?? config.chatId) !== callback.chatId) return;
    if (!this.canUseLarkActions(config, callback.openId)) {
      return { toast: { type: 'error', content: '此账号未获授权操作此卡片。' } };
    }
    const signal = this.larkActionSignal();
    if (this.helpWorkspaces && this.readHelpSnapshot) {
      const response = await this.help.handle(config, callback, {
        workspaces: this.helpWorkspaces,
        read: this.readHelpSnapshot,
        start: (target, workspace, prompt) =>
          this.startFromHelp(config, callback, target, workspace.name, prompt, signal),
        send: (target, prompt) => this.submitCardReply(config, callback.eventId, target, prompt, signal, callback.messageId),
      }, signal).catch((): LarkActionResponse => ({ toast: { type: 'error', content: '菜单暂不可用，请重新发送 help。' } }));
      if (response) return response;
    }
    const action = larkCompletionAction(callback);
    if (!action) return;
    if (!target) return { toast: { type: 'error', content: '此卡片的操作已不可用。' } };
    if (action.prompt === undefined)
      return { toast: { type: 'error', content: `请输入 1 至 ${larkReplyForm.maxLength} 个字符的消息。` } };
    return this.submitCardReply(config, action.eventId, target, action.prompt, signal, action.messageId, action);
  }
  private canUseLarkActions(config: NotificationConfig, openId: string) {
    return larkRepliesEnabled(config) && config.replyOpenIds.includes(openId) &&
      !!this.db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin'").get(config.replyAdminId);
  }
  private larkActionSignal() {
    return AbortSignal.any([this.abort.signal, this.destination.signal, this.replyAuthorization.signal]);
  }
  private async submitCardReply(config: NotificationConfig, eventId: string,
    target: Pick<LarkReplySubmission, 'workspaceId' | 'sessionId'>, prompt: string, signal: AbortSignal,
    messageId: string, completionCard?: { updateToken?: string; replyText?: string }): Promise<LarkActionResponse> {
    const destination = config.larkDestination;
    const receiptId = `card:${eventId}`;
    const { result, error } = await this.submitReply!({
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
      userId: config.replyAdminId,
      requestId: larkRequestId(destination, receiptId),
      prompt,
      attachments: [],
      nextTurn: true,
      requireNextTurn: true,
    }, signal).catch((): LarkReplyResult => ({ result: 'unknown' }));
    const accepted = result === 'sent' || result === 'queued';
    if (!signal.aborted && (completionCard || result !== 'sent')) {
      this.store.recordLarkReceipt(destination, receiptId, accepted ? replyReceipts[result].text : cardReplyNotice(result, error), {
        workspaceId: target.workspaceId,
        userId: config.replyAdminId,
        cardMessageId: messageId,
        cardUpdateToken: accepted && completionCard?.updateToken &&
          this.store.larkCardText(destination, messageId) === undefined ? completionCard.updateToken : undefined,
        cardReplyText: accepted && completionCard ? completionCard.replyText ?? prompt : undefined,
      });
      void this.poll();
    }
    return { toast: {
      type: result === 'sent' ? 'success' : result === 'queued' || result === 'unknown' ? 'info' : 'error',
      content: result === 'offline' ? '工作空间已离线，请等客户端重新连接后再试。'
        : result === 'upgrade' ? '请更新此工作空间的 Monitor 客户端后再试。'
        : result === 'busy' ? '工作空间正在处理其他请求，请稍后再试。'
        : error || replyReceipts[result].text,
    } };
  }
  private startFromHelp(config: NotificationConfig, event: { eventId: string; messageId: string; chatId: string }, selected: LarkStartTarget,
    workspace: string, prompt: string, signal: AbortSignal): LarkActionResponse {
    if (!this.startSession || signal.aborted)
      return { toast: { type: 'error', content: '暂时无法新建会话。' } };
    const destination = config.larkDestination;
    const receiptId = 'help:' + event.eventId;
    const key = destination + ':' + receiptId;
    if (this.starts.size >= 16)
      return { toast: { type: 'error', content: '当前正在处理的请求过多，请稍后再试。' } };
    if (this.store.claimLarkStart(destination, receiptId, START_UNKNOWN, event.chatId, event.messageId)) {
      const target = { workspaceId: selected.workspaceId, project: { projectId: selected.projectId }, label: selected.projectName ?? selected.alias, prompt };
      const job = this.submitLarkStart(config, receiptId, target, workspace, prompt, [], signal).then((result) => {
        if (!signal.aborted) this.store.finishLarkStart(destination, receiptId, result.text,
          result.sessionId ? { workspaceId: target.workspaceId, sessionId: result.sessionId } : undefined);
      }).catch(() => {}).finally(() => {
        this.starts.delete(key);
        void this.poll();
      });
      this.starts.set(key, job);
    }
    return { toast: { type: 'info', content: '已接收创建请求，结果会回复在这张卡片下。' } };
  }
  private async receiveReply(destination: string, event: unknown) {
    if (this.closed || destination !== this.replyDestination || !this.submitReply)
      return;
    const config = this.store.config();
    const reply = larkReply(config, event);
    if (!reply) return;
    const referencedTargets = reply.parents.flatMap((id) => this.store.larkTarget(destination, id) ?? []);
    const target = referencedTargets.find((item) => (item.chatId ?? config.chatId) === reply.chatId);
    if (!target && referencedTargets.length) return;
    const key = `${destination}:${reply.messageId}`;
    if (!target) {
      if (!this.startSession || this.starts.has(key) || this.starts.size >= 16 ||
          this.store.hasLarkStart(destination, reply.messageId)) return;
      const mentions = larkStartMentions(reply.message);
      if (this.helpWorkspaces && !reply.parents.length &&
          helpCommand.test(larkStartContent(reply.message, mentions.map(({ key }) => key).filter(Boolean)).prompt)) {
        if (!this.canUseLarkActions(config, reply.senderId)) return;
        const signal = this.larkActionSignal();
        const task = (async () => {
          const sender = await this.app.sender(config, signal);
          if (mentions.length) {
            const bot = await sender.botOpenId();
            if (!mentions.some(({ openId }) => openId === bot)) return;
          }
          signal.throwIfAborted();
          await this.help.open(config, reply.messageId, reply.chatId, reply.senderId, (card) =>
            sender.replyCard(reply.messageId, larkRequestId(destination, 'help:' + reply.messageId), card), signal);
        })().catch(() => {}).finally(() => { this.starts.delete(key); });
        this.starts.set(key, task);
        return;
      }
      if (!mentions.length && (!reply.isPrivate || !reply.prompt)) return;
      const signal = AbortSignal.any([this.abort.signal, this.destination.signal, this.replyAuthorization.signal]);
      const job = this.receiveStart(config, reply, mentions, signal)
        .catch(() => { /* A claimed request with no final receipt remains uncertain. */ })
        .finally(() => {
          this.starts.delete(key);
          void this.poll();
        });
      this.starts.set(key, job);
      return;
    }
    let newReceipt = false;
    const active = this.replies.get(key);
    const background = !!(reply.createdAt || reply.resources.length);
    if (active) {
      if (!background) await active.accepted;
      return;
    }
    if (this.replies.size >= 32) throw new Error('Monitor reply capacity reached');
    const signal = AbortSignal.any([
      this.abort.signal,
      this.destination.signal,
      this.replyAuthorization.signal,
    ]);
    const accepted = (async () => {
      let receipt = this.store.larkReceipt(destination, reply.messageId);
      if (!receipt) {
        const result = await this.dispatchReply(config, target, reply, signal);
        if (signal.aborted) return;
        receipt = replyReceipts[result].text;
        const queued = result === 'queued'
          ? { workspaceId: target.workspaceId, userId: config.replyAdminId }
          : undefined;
        this.store.recordLarkReceipt(destination, reply.messageId, receipt, queued);
        newReceipt = true;
      }
      return receipt;
    })();
    const feedback = accepted.then(async (receipt) => {
      if (signal.aborted || !receipt) return;
      const queued = receipt === replyReceipts.queued.text;
      if (queued && !newReceipt) return;
      const reaction = larkReplyReaction(receipt);
      if (!reaction) return;
      const sender = await this.app.sender(config, signal);
      const reactionId = await sender.react(reply.messageId, reaction);
      if (queued && reactionId)
        this.store.recordLarkWaitReaction(destination, reply.messageId, reactionId);
    }).catch(() => {
      // An unavailable Lark API does not affect the Monitor queue or notification delivery.
    }).finally(() => {
      this.replies.delete(key);
    });
    this.replies.set(key, { accepted, feedback });
    // Image downloads and uploads can outlast the provider's event acknowledgement deadline.
    if (!background) await accepted;
  }
  private async receiveStart(
    config: NotificationConfig,
    reply: NonNullable<ReturnType<typeof larkReply>>,
    mentions: ReturnType<typeof larkStartMentions>,
    signal: AbortSignal,
  ) {
    const admin = this.db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin'");
    if (!admin.get(config.replyAdminId)) return;
    const sender = await this.app.sender(config, signal);
    const botId = mentions.length ? await sender.botOpenId() : undefined;
    const botMentions = mentions.filter(({ openId }) => openId === botId);
    if ((!reply.isPrivate && !botMentions.length) || signal.aborted || !admin.get(config.replyAdminId)) return;
    const { larkDestination: destination } = config;
    if (!this.store.claimLarkStart(destination, reply.messageId, START_UNKNOWN, reply.chatId)) return;
    const result = await this.dispatchStart(config, reply, sender, botMentions.map(({ key }) => key).filter(Boolean), signal);
    const { sessionId, workspaceId } = result;
    if (sessionId && workspaceId && this.workspaceName?.(workspaceId)) {
      this.store.finishLarkStart(destination, reply.messageId, result.text, { sessionId, workspaceId });
    } else {
      this.store.finishLarkStart(destination, reply.messageId, result.text);
    }
  }
  private resolveStartTarget(
    { larkStart: { defaultAlias, targets } }: NotificationConfig,
    input: string,
    hasAttachments: boolean,
    isPrivate: boolean,
  ): StartTarget | { text: string } {
    const named = namedTarget.exec(input);
    if (named) {
      const workspace = unquoteTargetName(named[1]);
      const projectName = unquoteTargetName(named[2]);
      const matches = this.workspacesNamed?.(workspace) ?? [];
      if (!matches.length) return { text: '找不到这个名称的工作空间，请核对 Monitor 中显示的名称。' };
      if (matches.length > 1) return { text: '有多个同名工作空间，请在 Monitor 选择工作空间并设置简称。' };
      if (projectName.length > 500) return { text: '项目名称过长，请在 Monitor 为这个项目设置简称。' };
      return {
        workspaceId: matches[0].id,
        project: { projectName },
        label: projectName,
        prompt: input.slice(named[0].length).trimStart(),
      };
    }
    const shortcut = /^([a-z0-9][a-z0-9_-]{0,15})([:：](?!\/)|(?=\s|$))/i.exec(input);
    const selected = targets.find(({ alias }) => alias === shortcut?.[1].toLowerCase());
    const explicitShortcut = !!shortcut?.[2];
    const target = selected ?? (explicitShortcut ? undefined : targets.find(({ alias }) => alias === defaultAlias));
    const prompt = selected && shortcut ? input.slice(shortcut[0].length).trimStart() : input;
    if ((!input && !hasAttachments) || !target) {
      const prefix = isPrivate ? '' : '@机器人 ';
      const choices = targets.map(({ alias, workspaceId, projectName }) => {
        const workspace = this.workspaceName?.(workspaceId) ?? '工作空间已移除';
        return `- \`${alias}\` ${markdownLabel(workspace)}${projectName ? ` / ${markdownLabel(projectName)}` : ''}${alias === defaultAlias ? '（默认）' : ''}`;
      });
      return { text: [
        explicitShortcut ? '找不到这个简称。' : targets.length ? '**可用会话目标**' : '当前未设置默认会话目标。',
        ...choices,
        ...(target ? [isPrivate ? '直接发送任务可使用默认目标。' : '直接 @ 机器人并写任务可使用默认目标。'] : []),
        ...(targets.length ? [`可发送 “${prefix}简称 任务内容” 指定目标。`] : []),
        `可发送 “${prefix}工作空间/项目 任务内容”。`,
      ].join('\n') };
    }
    return { workspaceId: target.workspaceId, project: { projectId: target.projectId }, label: target.projectName ?? target.alias, prompt };
  }
  private async dispatchStart(
    config: NotificationConfig,
    reply: NonNullable<ReturnType<typeof larkReply>>,
    sender: Awaited<ReturnType<LarkApp['sender']>>,
    mentionKeys: string[],
    signal: AbortSignal,
  ): Promise<{ text: string; workspaceId?: string; sessionId?: string }> {
    const { prompt: input, resources: ownResources, invalidResource } = larkStartContent(reply.message, mentionKeys);
    const target = this.resolveStartTarget(config, input,
      !!(ownResources.length || reply.parents.length || invalidResource), reply.isPrivate);
    if ('text' in target) return target;
    const { prompt } = target;
    const workspace = this.workspaceName?.(target.workspaceId);
    if (!workspace) return { text: '目标工作空间已移除，请在 Monitor 更新会话目标。' };
    if (invalidResource) return { text: '无法读取消息中的附件，会话未创建。' };
    if (prompt.length > 12000) return { text: '任务文字最多 12000 字符，会话未创建。' };
    if (this.replyDownloads >= 4 && (reply.parents.length || ownResources.length))
      return { text: '当前正在处理的附件过多，请稍后重新发送。' };
    const resources = [...ownResources];
    if (reply.parents.length || resources.length) {
      this.replyDownloads++;
      try {
        const quoted = reply.parent ?? reply.parents[0];
        if (quoted) {
          const original = await sender.message(quoted).catch(() => undefined);
          const referenced = larkQuotedResources(original, quoted, reply.chatId);
          if (!referenced) return { text: '无法读取被引用的文件或图片，会话未创建。请检查机器人的消息和附件权限。' };
          resources.unshift(...referenced);
        }
        const seen = new Set<string>();
        const unique = resources.filter((resource) => {
          const key = 'document' in resource
            ? `${resource.document.type}:${resource.document.token}`
            : `${resource.messageId}:${resource.key}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (unique.length > LARK_REPLY_MAX_ATTACHMENTS) return { text: replyReceipts.attachmentsTooLarge.text };
        const attachments = await sender.readReplyAttachments(unique);
        return await this.submitLarkStart(config, reply.messageId, target, workspace, prompt, attachments, signal);
      } catch (error) {
        if (error instanceof LarkReplyAttachmentsTooLarge) return { text: replyReceipts.attachmentsTooLarge.text };
        if (error instanceof LarkReplyDocumentError) return { text: replyReceipts.documentFailed.text };
        return { text: signal.aborted ? START_UNKNOWN : '无法读取消息中的附件，会话未创建。' };
      } finally {
        this.replyDownloads--;
      }
    }
    if (!prompt) return { text: '请在目标后写任务，或引用要提交的文件。' };
    return this.submitLarkStart(config, reply.messageId, target, workspace, prompt, [], signal);
  }
  private async submitLarkStart(
    config: NotificationConfig,
    messageId: string,
    target: StartTarget,
    workspace: string,
    prompt: string,
    attachments: LarkStartSubmission['attachments'],
    signal: AbortSignal,
  ) {
    const { workspaceId, project } = target;
    signal.throwIfAborted();
    const begunAt = Math.floor(Date.now() / 1000) * 1000;
    const starting = this.startingWorkspaces.get(workspaceId) ?? { active: 0, completions: new Map() };
    starting.active++;
    this.startingWorkspaces.set(workspaceId, starting);
    let created: LarkStartResult;
    try {
      created = await this.startSession!({
        workspaceId, ...project, prompt, attachments,
        userId: config.replyAdminId,
        requestId: larkRequestId(config.larkDestination, messageId),
      }, signal).catch((): LarkStartResult => ({ result: 'unknown' }));
      const current = this.store.config();
      if (created.sessionId && created.result === 'sent' && !signal.aborted && this.workspaceName?.(workspaceId) &&
          current.larkDestination === config.larkDestination && current.completionMode === 'watched' &&
          this.store.watch(workspaceId, created.sessionId, true, begunAt)) {
        for (const [key, event] of starting.completions) {
          if (event.sessionId !== created.sessionId || event.occurredAt < Math.max(begunAt, current.enabledAt)) continue;
          this.queueNotification(current, { id: workspaceId, name: workspace }, key, event);
          starting.completions.delete(key);
        }
      }
    } finally {
      if (--starting.active === 0) this.startingWorkspaces.delete(workspaceId);
    }
    const { result, sessionId, projectName } = created;
    if (result !== 'sent' || !sessionId) {
      const reasons: Partial<Record<LarkReplyReceipt, string>> = {
        offline: '工作空间已离线。Client 重新连接后，请重新发送任务。',
        unavailable: '工作空间或项目已不可用，请在 Monitor 更新会话目标。',
        upgrade: '请先更新此工作空间的 Monitor Client。',
        attachmentFailed: '附件未能保存到工作空间，会话未创建。',
        projectMissing: replyReceipts.projectMissing.text,
        projectAmbiguous: replyReceipts.projectAmbiguous.text,
        busy: '工作空间正在处理其他请求，请稍后重新发送。',
        failed: '会话创建失败，请在 Monitor 查看请求回执。',
      };
      return { text: `工作空间：${markdownLabel(workspace)}\n${reasons[result] ?? START_UNKNOWN}` };
    }
    const lines = [
      '**Codex 会话已启动**',
      `工作空间：${markdownLabel(workspace)}`,
      `项目：${markdownLabel(projectName ?? target.label)}`,
      `附件：${attachments.length} 个`,
    ];
    if (config.publicUrl) {
      const url = new URL(config.publicUrl);
      url.searchParams.set('workspace', workspaceId);
      url.searchParams.set('session', sessionId);
      lines.push(`[查看会话](<${url.href}>)`);
    }
    lines.push('引用此消息并 @ 机器人可以继续会话。');
    return { text: lines.join('\n'), workspaceId, sessionId };
  }
  private async dispatchReply(
    config: NotificationConfig,
    target: Pick<LarkReplySubmission, 'workspaceId' | 'sessionId'>,
    reply: NonNullable<ReturnType<typeof larkReply>>,
    signal: AbortSignal,
  ): Promise<LarkReplyReceipt> {
    const destination = config.larkDestination;
    const needsDownload = !!(reply.createdAt || reply.resources.length);
    if (needsDownload && this.replyDownloads >= 4) return 'busy';
    if (needsDownload) this.replyDownloads++;
    try {
      const sender = needsDownload ? await this.app.sender(config, signal) : undefined;
      let history: Awaited<ReturnType<typeof larkReplyHistory>> = [];
      if (reply.createdAt && sender) {
        try {
          history = await larkReplyHistory(reply, sender.history, (id) =>
            this.replies.has(`${destination}:${id}`) || this.starts.has(`${destination}:${id}`) ||
            !!this.store.larkReceipt(destination, id) || this.store.hasLarkStart(destination, id),
          );
        } catch (error) {
          // Applications with only group-mention access can still submit the explicit reply.
          if (!(error instanceof LarkDeliveryError) || error.code !== 230027) return 'historyFailed';
        }
      }
      const messages = [...history, reply];
      if (messages.some((message) => message.invalidResource)) return 'attachmentFailed';
      const prompt = messages.map((message) => message.prompt).filter(Boolean).join('\n\n');
      const seenDocuments = new Set<string>();
      const resources = messages.flatMap((message) => message.resources).filter((resource) => {
        if (!('document' in resource)) return true;
        const key = `${resource.document.type}:${resource.document.token}`;
        if (seenDocuments.has(key)) return false;
        seenDocuments.add(key);
        return true;
      });
      if ((!prompt && !resources.length) || prompt.length > 12000) return 'unsupported';
      if (resources.length > LARK_REPLY_MAX_ATTACHMENTS) return 'attachmentsTooLarge';
      let attachments: LarkReplySubmission['attachments'] = [];
      if (resources.length) {
        try {
          attachments = await sender!.readReplyAttachments(resources);
        } catch (error) {
          if (error instanceof LarkReplyAttachmentsTooLarge) return 'attachmentsTooLarge';
          return error instanceof LarkReplyDocumentError ? 'documentFailed' : 'attachmentFailed';
        }
      }
      if (signal.aborted) return 'failed';
      const { result } = await this.submitReply!({
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        userId: config.replyAdminId,
        requestId: larkRequestId(destination, reply.messageId),
        prompt,
        attachments,
        nextTurn: !!reply.createdAt,
      }, signal);
      return result;
    } finally {
      if (needsDownload) this.replyDownloads--;
    }
  }
  receive(workspace: { id: string; name: string }, report: NotificationReport) {
    const config = this.store.config();
    if (this.closed || report.revision !== config.revision) return false;
    const pending: CompletionNotification[] = [];
    const starting = this.startingWorkspaces.get(workspace.id);
    const earlyCompletions: { key: string; event: ReportedCompletion }[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of [
        ...(report.completions ?? []),
        ...report.events.filter((event) => event.kind === 'session.completed'),
      ]) {
        const notification = this.completions.record(workspace, event);
        if (notification) pending.push(notification);
      }
      for (const event of report.events) {
        if (!config.enabled) continue;
        const key = `${workspace.id}:${notificationKey(event)}`;
        if (event.kind === 'session.input_resolved') {
          this.store.cancelInput(key);
          continue;
        }
        if (
          event.occurredAt <
          (event.kind === 'session.completed' ? config.enabledAt : config.inputSince)
        )
          continue;
        if (
          event.kind === 'session.completed' &&
          config.completionMode === 'watched' &&
          !this.store.watched(workspace.id, event.sessionId, event.occurredAt)
        ) {
          if (starting) earlyCompletions.push({ key, event });
          continue;
        }
        this.queueNotification(config, workspace, key, event);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (starting) {
      for (const { key, event } of earlyCompletions) starting.completions.set(key, event);
      while (starting.completions.size > 128) starting.completions.delete(starting.completions.keys().next().value!);
    }
    this.completions.publish(pending);
    if (report.monitorError)
      this.monitorErrors.set(workspace.id, `${workspace.name}：${report.monitorError}`);
    else this.monitorErrors.delete(workspace.id);
    return true;
  }
  private queueNotification(
    config: NotificationConfig,
    workspace: { id: string; name: string },
    key: string,
    event: Exclude<NotificationEvent, { kind: 'session.input_resolved' }>,
  ) {
    this.store.enqueue({
      key,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      kind: event.kind,
      sessionId: event.sessionId,
      title: event.title,
      message: notificationMessage(event, workspace, config.publicUrl),
      ...(event.kind === 'session.completed' ? { turnId: event.turnId, occurredAt: event.occurredAt } : {}),
    }, config.revision);
  }
  forgetWorkspace(workspaceId: string) {
    this.store.cancelWorkspace(workspaceId);
    this.completions.forgetWorkspace(workspaceId);
    this.monitorErrors.delete(workspaceId);
  }
  poll() {
    if (this.closed) return Promise.resolve();
    if (this.readReplyStatus && !this.replyScan && this.replyDestination) {
      this.replyScan = this.scanLarkReplies()
        .catch(() => { /* Pending receipts are checked again on the next poll. */ })
        .finally(() => { this.replyScan = undefined; });
    }
    if (!this.startScan && this.replyDestination && this.startSession) {
      this.startScan = this.scanLarkStarts().catch(() => {}).finally(() => { this.startScan = undefined; });
    }
    if (this.busy) return this.busy;
    this.busy = this.tick()
      .catch(() => {
        /* Persisted work is retried on the next tick. */
      })
      .finally(() => {
        this.busy = undefined;
      });
    return this.busy;
  }
  private async scanLarkStarts() {
    const config = this.store.config();
    const destination = config.larkDestination;
    const signal = AbortSignal.any([this.abort.signal, this.destination.signal]);
    await Promise.allSettled(this.store.pendingLarkStarts(destination, Date.now()).map(async (start) => {
      const { messageId, workspaceId, sessionId, text, attempts, replyTo, chatId } = start;
      if (this.starts.has(`${destination}:${messageId}`)) return;
      try {
        const sender = await this.app.sender(config, signal);
        const cardId = await sender.replyCard(replyTo ?? messageId, larkRequestId(destination, messageId), text);
        if (signal.aborted) return;
        if (workspaceId && sessionId && this.workspaceName?.(workspaceId))
          this.store.recordLarkMessage(destination, cardId, workspaceId, sessionId, false, undefined, chatId ?? config.chatId);
        this.store.updateLarkStartDelivery(destination, messageId, 0);
      } catch {
        if (!signal.aborted)
          this.store.updateLarkStartDelivery(destination, messageId, attempts >= 3 ? 0 : Date.now() + 3000 * (attempts + 1));
      }
    }));
  }
  private async scanLarkReplies() {
    const config = this.store.config();
    const destination = config.larkDestination;
    const signal = AbortSignal.any([this.abort.signal, this.destination.signal, this.replyAuthorization.signal]);
    const now = Date.now();
    const checkedCards = new Set<string>();
    await Promise.allSettled(this.store.pendingLarkReplies(destination, now).map(async (reply) => {
      const { rowid, messageId, workspaceId, userId, reactionId, cardMessageId, cardUpdateToken, cardReplyText } = reply;
      if (cardMessageId) {
        if (checkedCards.has(cardMessageId)) return;
        checkedCards.add(cardMessageId);
      }
      let { receipt } = reply;
      this.store.delayLarkReplyCheck(destination, messageId, now + LARK_REPLY_POLL_MS);
      // Let the initial feedback record the waiting reaction before trying to replace it.
      if (this.replies.has(`${destination}:${messageId}`)) return;
      if (receipt === replyReceipts.queued.text) {
        const status = await this.readReplyStatus!(workspaceId, userId, larkRequestId(destination, messageId), signal);
        if (signal.aborted || !status) return;
        const { result, error } = status;
        const { text, emoji } = replyReceipts[result];
        if (!cardMessageId) {
          const sender = await this.app.sender(config, signal);
          await sender.react(messageId, emoji);
        }
        receipt = cardMessageId && result !== 'sent' ? cardReplyNotice(result, error) : text;
        this.store.updateLarkReceipt(destination, messageId, receipt);
      }
      if (signal.aborted) return;
      if (cardMessageId) {
        try {
          if (receipt !== replyReceipts.sent.text) {
            const sender = await this.app.sender(config, signal);
            await sender.replyText(cardMessageId, larkRequestId(destination, messageId), receipt);
          } else if (cardReplyText !== null &&
              !this.store.hasNewerLarkCardReply(destination, cardMessageId, rowid, receipt)) {
            const sender = await this.app.sender(config, signal);
            const chatId = this.store.larkTarget(destination, cardMessageId, true)?.chatId ?? config.chatId;
            await sender.completeCardReply(cardMessageId, chatId, { status: receipt, text: cardReplyText },
              this.store.larkCardText(destination, cardMessageId), cardUpdateToken ?? undefined);
          }
        } catch (error) {
          if (!(error instanceof LarkDeliveryError) || error.retryable) throw error;
        }
        if (signal.aborted) return;
      }
      if (reactionId) {
        const sender = await this.app.sender(config, signal);
        await sender.removeReaction(messageId, reactionId);
      }
      this.store.finishLarkReplyCheck(destination, messageId);
    }));
  }
  private async tick() {
    if (!this.store.config().enabled) return;
    const next = this.store.pending();
    if (next) await this.deliver(next);
  }
  private async deliver(delivery: PendingDelivery) {
    if (this.closed) return;
    const config = this.store.config();
    if (delivery.revision !== config.revision || !this.store.start(delivery.id)) return;
    const signal = AbortSignal.any([this.abort.signal, this.deliveryDestination.signal]);
    try {
      const warning =
        config.mode === 'app'
          ? await this.deliverApp(config, delivery, signal)
          : await sendLark(config, delivery.message, signal, this.transport, delivery.kind === 'session.completed');
      signal.throwIfAborted();
      if (!this.closed) this.store.sent(delivery.id, warning || '');
    } catch (error) {
      if (this.closed) return;
      const retryable = error instanceof LarkDeliveryError && error.retryable;
      const current = this.store.config();
      const retry =
        delivery.kind !== 'test' &&
        retryable &&
        delivery.attempts < 2 &&
        current.enabled &&
        current.revision === config.revision;
      this.store.failed(
        delivery.id,
        signal.aborted ? '通知接收配置已变更或关闭，投递结果未确认' : (error as Error).message,
        retry ? Date.now() + (delivery.attempts ? 30000 : 5000) : undefined,
      );
    }
  }
  private async deliverApp(
    config: NotificationConfig,
    delivery: PendingDelivery,
    signal: AbortSignal,
  ) {
    const sender = await this.app.sender(config, signal);
    if (config.appRecipientType === 'group') {
      return this.deliverAppTo(config, delivery, sender, { type: 'chat_id', id: config.chatId }, delivery.id, signal);
    }
    const sentTo = JSON.parse(delivery.larkSentTo) as Record<string, string>;
    const failures: LarkDeliveryError[] = [];
    for (const openId of config.replyOpenIds) {
      signal.throwIfAborted();
      if (Object.hasOwn(sentTo, openId)) continue;
      try {
        sentTo[openId] = await this.deliverAppTo(config, delivery, sender, { type: 'open_id', id: openId },
          larkRequestId(delivery.id, openId), signal);
        signal.throwIfAborted();
        this.store.larkDeliveryProgress(delivery.id, sentTo);
      } catch (error) {
        if (signal.aborted || !(error instanceof LarkDeliveryError)) throw error;
        failures.push(error);
      }
    }
    if (failures.length) {
      const reasons = [...new Set(failures.map(({ message }) => message))].join('；');
      throw new LarkDeliveryError(`已发送给 ${Object.keys(sentTo).length}/${config.replyOpenIds.length} 位私聊用户。${reasons}`,
        failures.some(({ retryable }) => retryable));
    }
    return [...new Set(Object.values(sentTo).filter(Boolean))].join('；');
  }
  private async deliverAppTo(
    config: NotificationConfig,
    delivery: PendingDelivery,
    sender: Awaited<ReturnType<LarkApp['sender']>>,
    recipient: LarkRecipient,
    uuid: string,
    signal: AbortSignal,
  ): Promise<string> {
    const completed = delivery.kind === 'session.completed';
    const completionActions = completed && larkRepliesEnabled(config);
    const completion = completionActions ? 'interactive' : completed ? 'read-only' : undefined;
    const { messageId, chatId } = await sender.card(recipient, uuid, delivery.message, completion);
    signal.throwIfAborted();
    if (delivery.kind === 'test') {
      await sender.attachment(recipient, `${uuid}-test`, {
        name: 'codex-monitor-test.txt',
        mime: 'text/plain',
        data: Buffer.from('Codex Monitor attachment test\n'),
      });
      return '';
    }
    const { workspaceId, sessionId, turnId, occurredAt } = delivery;
    const warnings = new Set<string>();
    if (workspaceId && sessionId) {
      if (messageId && chatId) {
        this.store.recordLarkMessage(config.larkDestination, messageId, workspaceId, sessionId, completionActions,
          completionActions ? delivery.id : undefined, chatId);
      } else if (recipient.type === 'open_id') {
        warnings.add('Lark 未返回私聊卡片的消息 ID 或聊天 ID，无法关联卡片操作');
      }
    }
    if (delivery.kind === 'session.completed' && delivery.eventKey)
      this.trackLarkRead(delivery.id, delivery.eventKey, messageId);
    if (!this.readAttachment || !workspaceId || !sessionId || !turnId || occurredAt === null)
      return [...warnings].join('；');
    for (let index = 0; index < NOTIFICATION_ATTACHMENT_LIMIT; index++) {
      signal.throwIfAborted();
      try {
        const file = await this.readAttachment(
          workspaceId,
          { sessionId, turnId, occurredAt, index },
          signal,
        );
        if (file === null) break;
        if (file === 'unavailable') {
          warnings.add('部分附件无法读取、格式不可用或超过大小限制');
          continue;
        }
        await sender.attachment(recipient, `${uuid}-${index}`, file);
      } catch (error) {
        if (signal.aborted || !(error instanceof LarkDeliveryError)) throw error;
        if (error.retryable && delivery.attempts < 2) throw error;
        warnings.add(error.message);
      }
    }
    return [...warnings].join('；');
  }
  private setLarkReadStatus(deliveryId: string, status: string) {
    this.larkReadStatus.delete(deliveryId);
    this.larkReadStatus.set(deliveryId, status);
    if (this.larkReadStatus.size > 100)
      this.larkReadStatus.delete(this.larkReadStatus.keys().next().value!);
  }
  private trackLarkRead(deliveryId: string, eventKey: string, messageId: string | undefined) {
    const id = this.completions.pendingId(eventKey);
    if (id === undefined) return;
    if (!messageId) {
      if (!this.larkReadCards.has(id))
        this.setLarkReadStatus(deliveryId, '无法查询已读，Lark 未返回有效的卡片消息 ID');
      return;
    }
    const tracked = this.larkReadCards.get(id);
    if (tracked) {
      tracked.messageIds.add(messageId);
      return;
    }
    this.larkReadCards.set(id, { deliveryId, messageIds: new Set([messageId]), expiresAt: Date.now() + LARK_READ_WINDOW_MS });
    this.setLarkReadStatus(deliveryId, 'Lark 已读查询等待首次检查');
    if (!this.larkReadTimer) {
      this.larkReadTimer = setInterval(() => {
        if (this.larkReadScan) return;
        this.larkReadScan = this.scanLarkReads()
          .catch(() => {
            // Retry provider failures on the next scan.
          })
          .finally(() => {
            this.larkReadScan = undefined;
            if (!this.larkReadCards.size) this.stopLarkReadTimer();
          });
      }, LARK_READ_POLL_MS);
      this.larkReadTimer.unref();
    }
  }
  private stopLarkReadTimer() {
    clearInterval(this.larkReadTimer);
    this.larkReadTimer = undefined;
  }
  private async scanLarkReads() {
    const { generation, notifications } = this.completions.snapshot();
    const now = Date.now();
    const pending = new Set(notifications.map(({ id }) => id));
    for (const [id, card] of this.larkReadCards) {
      if (pending.has(id) && card.expiresAt > now) continue;
      this.larkReadCards.delete(id);
      this.setLarkReadStatus(card.deliveryId, pending.has(id)
        ? 'Lark 已读查询已停止，卡片已超过 7 天'
        : 'Lark 已读查询已停止，网页通知已移除');
    }
    const cards = [...this.larkReadCards];
    if (!cards.length) return;

    const signal = AbortSignal.any([this.abort.signal, this.deliveryDestination.signal]);
    const sender = this.app.sender(this.store.config(), signal);
    await Promise.all(cards.map(async ([id, card]) => {
      let readError = '';
      for (const messageId of [...card.messageIds]) {
        try {
          const app = await sender;
          if (signal.aborted) return;
          if (!await app.isRead(messageId)) continue;
          if (signal.aborted || this.larkReadCards.get(id) !== card) return;
          this.setLarkReadStatus(card.deliveryId, 'Lark 已读，网页通知已关闭');
          this.completions.dismiss(generation, [id]);
          this.larkReadCards.delete(id);
          return;
        } catch (error) {
          readError = error instanceof LarkDeliveryError ? error.message : '请求失败';
          if (error instanceof LarkDeliveryError && (error.code === 230033 || error.code === 230110))
            card.messageIds.delete(messageId);
        }
      }
      if (signal.aborted || this.larkReadCards.get(id) !== card) return;
      this.setLarkReadStatus(card.deliveryId, readError ? `Lark 已读查询失败：${readError}` : 'Lark 暂无已读记录');
      if (!card.messageIds.size) this.larkReadCards.delete(id);
    }));
  }
  test() {
    if (this.testTask || Date.now() - this.lastTestAt < 5000) return undefined;
    const config = this.store.config();
    if (!notificationConfigured(config)) throw new Error('请先保存所选方式的通知配置');
    this.lastTestAt = Date.now();
    const id = this.store.enqueue(
      {
        kind: 'test',
        title: config.mode === 'app' ? '应用机器人测试通知' : 'Webhook 测试通知',
        message:
          config.mode === 'app'
            ? '✅ **Codex Monitor 测试通知**\n本次测试还会发送一个文本附件。'
            : '✅ **Codex Monitor 测试通知**\n飞书/Lark Webhook 连接测试成功。',
      },
      config.revision,
    )!;
    this.testTask = (async () => {
      await this.deliver(this.store.delivery(id)!);
      return this.store.delivery(id)!;
    })().finally(() => {
      this.testTask = undefined;
    });
    return this.testTask;
  }
  close() {
    this.closed = true;
    this.replyConnection?.close({ force: true });
    clearInterval(this.timer);
    this.stopLarkReadTimer();
    this.abort.abort();
    return Promise.allSettled([this.busy, this.testTask, this.larkReadScan, this.replyScan, this.startScan, ...this.starts.values(), ...[...this.replies.values()].map(({ feedback }) => feedback)]).then(() => {});
  }
}
