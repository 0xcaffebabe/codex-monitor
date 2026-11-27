import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LarkStartTarget } from '../../src/types.js';
import { gitCommitShortcuts } from '../../src/shared/git-commit-shortcuts.js';
import type { HelpSnapshot } from './help-snapshot.js';
import { larkCard, larkReplyForm } from './lark.js';
import type { larkCardAction, LarkActionResponse } from './lark-replies.js';
import type { NotificationConfig } from './store.js';

type Workspace = { id: string; name: string; online: boolean; readable: boolean };
type Session = HelpSnapshot['running'][number] & { workspace: Workspace };
type Menu = {
  commandId: string;
  chatId: string;
  owner: string;
  expires: number;
  projects: Map<string, LarkStartTarget>;
  sessions: Map<string, Session>;
};
type Event = NonNullable<ReturnType<typeof larkCardAction>>;
type Actions = {
  workspaces: () => Workspace[];
  read: (workspaceId: string, details: boolean, signal: AbortSignal) => Promise<HelpSnapshot | undefined>;
  start: (target: LarkStartTarget, workspace: Workspace, prompt: string) => LarkActionResponse;
  send: (target: { workspaceId: string; sessionId: string }, prompt: string) => Promise<LarkActionResponse>;
};

const lifetime = 30 * 60 * 1000;
const prefix = 'monitor_help_';
const optionLimit = 20;
const selectField = 'monitor_selection';
const callbackValue = z.object({
  help: z.string().max(30),
  target: z.string().max(100).optional(),
  shortcut: z.string().max(30).optional(),
});
const formValues = z.object({
  [selectField]: z.string().max(100).optional(),
  [larkReplyForm.inputName]: z.string().max(larkReplyForm.maxLength).trim().min(1).optional(),
});
const statuses: Record<Session['status'], string> = {
  running: '运行中', waiting: '待处理', completed: '已完成', failed: '失败',
  interrupted: '已中断', idle: '空闲', stale: '状态待确认',
};
const plain = (content: string) => ({ tag: 'plain_text', content });
const label = (value: string) => value.replace(/\s+/g, ' ').trim();
const markdownLabel = (value: string) => label(value).replace(/[\\`*_[\]<>~]/g, '\\$&');
const panel = (text: string) => larkCard(text, true).body.elements[0];
const action = (text: string, help: string, target?: string, shortcut?: string) => ({
  tag: 'button', text: plain(text), behaviors: [{ type: 'callback', value: { help, target, shortcut } }],
});
const homeButton = () => action('返回首页', 'home');
const link = (text: string, url: string) => ({
  tag: 'button', text: plain(text), behaviors: [{ type: 'open_url', default_url: url }],
});
const options = (items: { value: string; text: string }[], selected?: string) => ({
  tag: 'select_static', name: selectField, width: 'fill', required: true,
  placeholder: plain('请选择'),
  initial_option: selected,
  options: items.map(({ value, text }) => ({ value, text: plain(label(text).slice(0, 120)) })),
});
const promptInput = () => ({
  tag: 'input', name: larkReplyForm.inputName, placeholder: plain('输入任务或后续消息'),
  input_type: 'multiline_text', rows: 2, width: 'fill', required: true, max_length: larkReplyForm.maxLength,
});
const form = (name: string, text: string, ...elements: object[]) => ({
  tag: 'form', name: prefix + name + '_form', elements: [
    ...elements,
    { tag: 'button', name: prefix + name, text: plain(text), type: 'primary', form_action_type: 'submit' },
  ],
});

function card(title: string, ...elements: object[]) {
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: plain(title), template: 'blue' },
    body: { elements },
  };
}
function show(data: object): LarkActionResponse {
  return { card: { type: 'raw', data } };
}
function error(content: string): LarkActionResponse {
  return { toast: { type: 'error', content } };
}
function url(config: NotificationConfig, params: Record<string, string | undefined> = {}) {
  if (!config.publicUrl) return;
  const result = new URL(config.publicUrl);
  for (const [key, value] of Object.entries(params)) if (value) result.searchParams.set(key, value);
  return result.href;
}
function blank(config: NotificationConfig, title: string, message: string) {
  const monitor = url(config);
  return card(title, panel(message), ...(monitor ? [link('打开 Monitor', monitor)] : []), homeButton());
}
function home(config: NotificationConfig) {
  const monitor = url(config);
  return card('Codex Monitor',
    action('新建会话', 'new'),
    action('继续会话', 'sessions'),
    action('任务动态', 'activity'),
    action('工作空间', 'workspaces'),
    ...(monitor ? [link('打开 Monitor', monitor)] : []),
  );
}
function workspaceState(workspace: Workspace) {
  if (!workspace.online) return '离线';
  return workspace.readable ? '在线' : '在线 · 请更新 Client';
}

export class LarkHelp {
  private menus = new Map<string, Menu>();

  async open(config: NotificationConfig, commandId: string, chatId: string, owner: string,
    send: (card: object) => Promise<string>, signal: AbortSignal) {
    const now = Date.now();
    for (const [key, menu] of this.menus) {
      if (menu.expires <= now) this.menus.delete(key);
      else if (key.startsWith(config.larkDestination + ':') && menu.commandId === commandId) return;
    }
    const messageId = await send(home(config));
    if (signal.aborted) return;
    this.menus.set(config.larkDestination + ':' + messageId, {
      commandId, chatId, owner, expires: Date.now() + lifetime, projects: new Map(), sessions: new Map(),
    });
    while (this.menus.size > 128) this.menus.delete(this.menus.keys().next().value!);
  }

  async handle(config: NotificationConfig, event: Event, actions: Actions, signal: AbortSignal) {
    const value = callbackValue.safeParse(event.action.value).data;
    const name = event.action.name?.startsWith(prefix) ? event.action.name.slice(prefix.length) : undefined;
    if (!value && !name) return;
    const menu = this.menus.get(config.larkDestination + ':' + event.messageId);
    if (menu && menu.chatId !== event.chatId) return;
    if (!menu || menu.expires <= Date.now()) return error('菜单已过期，请重新发送 help。');
    if (menu.owner !== event.openId) return error('只有这张菜单卡片的发起者可以操作。');
    const input = formValues.safeParse(event.action.form_value).data;
    const workspaces = actions.workspaces();
    switch (name ?? value?.help) {
      case 'home': return show(home(config));
      case 'new': return show(this.newSession(config, workspaces, menu));
      case 'start': {
        const prompt = input?.[larkReplyForm.inputName];
        if (!prompt) return error('请输入任务内容，最多 1000 个字符。');
        const target = menu.projects.get(input?.[selectField] ?? '');
        const current = config.larkStart.targets.find((item) => item.alias === target?.alias);
        if (!target || !current || current.workspaceId !== target.workspaceId || current.projectId !== target.projectId)
          return error('项目已变更，请重新打开「新建会话」。');
        const workspace = workspaces.find(({ id }) => id === current.workspaceId);
        if (!workspace?.online) return error('工作空间已离线，请选择在线工作空间。');
        return actions.start(current, workspace, prompt);
      }
      case 'workspaces': return show(this.workspaces(config, workspaces));
      case 'workspace': {
        const workspace = workspaces.find(({ id }) => id === input?.[selectField]);
        if (!workspace?.readable) return error('此工作空间已离线或需要更新 Client。');
        return show(await this.list(config, menu, [workspace], false, actions.read, signal));
      }
      case 'sessions': return show(await this.list(config, menu, workspaces, false, actions.read, signal));
      case 'activity': return show(await this.list(config, menu, workspaces, true, actions.read, signal));
      case 'session': {
        const token = input?.[selectField] ?? '';
        const session = menu.sessions.get(token);
        if (!session) return error('请重新选择会话。');
        if (!workspaces.some(({ id, online }) => id === session.workspace.id && online))
          return error('该会话的工作空间已离线。');
        return show(this.session(config, session, token));
      }
      default: {
        const sending = name?.startsWith('send_');
        if (!sending && value?.help !== 'git') return error('此菜单操作已不可用，请重新发送 help。');
        const session = menu.sessions.get((sending ? name!.slice(5) : value?.target) ?? '');
        if (!session) return error('请重新选择会话。');
        const prompt = sending ? input?.[larkReplyForm.inputName]
          : gitCommitShortcuts.find(({ id }) => id === value?.shortcut)?.prompt;
        if (!prompt) return error('请输入消息，最多 1000 个字符。');
        return actions.send({ workspaceId: session.workspace.id, sessionId: session.id }, prompt);
      }
    }
  }

  private newSession(config: NotificationConfig, workspaces: Workspace[], menu: Menu) {
    const choices = config.larkStart.targets.flatMap((target) => {
      const workspace = workspaces.find(({ id, online }) => id === target.workspaceId && online);
      return workspace ? [{ target, text: workspace.name + ' / ' + (target.projectName ?? target.alias) + ' · ' + target.alias }] : [];
    }).sort((a, b) => Number(b.target.alias === config.larkStart.defaultAlias) - Number(a.target.alias === config.larkStart.defaultAlias));
    if (!choices.length) return blank(config, '新建会话', '没有在线的已配置项目。可在 Monitor 的「群聊新建会话目标」中管理项目。');
    const projects = choices.slice(0, optionLimit).map(({ target, text }) => {
      const value = randomUUID();
      menu.projects.set(value, target);
      return { text, value, alias: target.alias };
    });
    while (menu.projects.size > 100) menu.projects.delete(menu.projects.keys().next().value!);
    return card('新建会话', form('start', '创建会话',
      options(projects, projects.find(({ alias }) => alias === config.larkStart.defaultAlias)?.value),
      promptInput()), homeButton());
  }

  private workspaces(config: NotificationConfig, workspaces: Workspace[]) {
    if (!workspaces.length) return blank(config, '工作空间', '暂无工作空间。');
    const lines = workspaces.slice(0, optionLimit).map((workspace) => '- ' + markdownLabel(workspace.name) + ' · ' + workspaceState(workspace));
    if (workspaces.length > optionLimit) lines.push('显示前 ' + optionLimit + ' 个工作空间。');
    const choices = workspaces.filter(({ readable }) => readable).slice(0, optionLimit);
    return card('工作空间', panel(lines.join('\n')), ...(choices.length ? [
      form('workspace', '查看会话', options(choices.map(({ id, name }) => ({ value: id, text: name })))),
    ] : []), action('刷新', 'workspaces'), homeButton());
  }

  private async list(config: NotificationConfig, menu: Menu, workspaces: Workspace[], details: boolean,
    read: Actions['read'], signal: AbortSignal) {
    const snapshots = await Promise.all(workspaces.map(async (workspace) => ({
      workspace, snapshot: workspace.readable ? await read(workspace.id, details, signal).catch(() => undefined) : undefined,
    })));
    signal.throwIfAborted();
    const title = details ? '任务动态' : '继续会话';
    const lines: string[] = [];
    const running: Session[] = [], waiting: Session[] = [], ended: Session[] = [];
    const pending: { session: Session; type: string; request?: string }[] = [];
    const counts = { running: 0, waiting: 0, ended: 0 };
    const missing: string[] = [];
    for (const { workspace, snapshot } of snapshots) {
      if (!snapshot) {
        missing.push(markdownLabel(workspace.name) + ' (' + (workspace.readable ? '读取失败' : workspaceState(workspace)) + ')');
        continue;
      }
      running.push(...snapshot.running.map((session) => ({ ...session, workspace })));
      waiting.push(...snapshot.waiting.map((session) => ({ ...session, workspace })));
      ended.push(...snapshot.ended.map((session) => ({ ...session, workspace })));
      for (const key of ['running', 'waiting', 'ended'] as const) counts[key] += snapshot.counts[key];
      pending.push(...snapshot.approvals.map(({ session }) => ({ session: { ...session, workspace }, type: '待审批' })));
      pending.push(...(snapshot.questions ?? []).map(({ id, session }) => ({
        session: { ...session, workspace }, type: '待回答', request: id,
      })));
      if (details && snapshot.questions === null) lines.push(markdownLabel(workspace.name) + ' 的待答复问题暂不可读。');
    }
    const byUpdated = (a: Session, b: Session) => b.updatedAt - a.updatedAt;
    running.sort(byUpdated);
    waiting.sort(byUpdated);
    ended.sort(byUpdated);
    if (details) {
      lines.unshift('**运行中 ' + counts.running + ' · 待处理 ' + counts.waiting + ' · 近 24 小时结束 ' + counts.ended + '**');
      const entry = (session: Session, type: string, request?: string, result?: boolean) => {
        const text = markdownLabel(session.title || '未命名会话');
        const href = url(config, {
          workspace: session.workspace.id, session: session.id, view: 'attention',
          request, result: result ? session.latestTurn || 'latest' : undefined,
        });
        return '- ' + type + ' · ' + markdownLabel(session.workspace.name) + ' / ' + (href ? '[' + text + '](<' + href + '>)' : text);
      };
      pending.sort((a, b) => byUpdated(a.session, b.session));
      lines.push(...pending.slice(0, 6).map(({ session, type, request }) => entry(session, type, request)));
      const pendingIds = new Set(pending.map(({ session }) => session.workspace.id + '/' + session.id));
      lines.push(...waiting.filter((session) => !pendingIds.has(session.workspace.id + '/' + session.id))
        .slice(0, 4).map((session) => entry(session, '待处理')));
      lines.push(...running.slice(0, 4).map((session) => entry(session, '运行中')));
      lines.push(...ended.slice(0, 4).map((session) => entry(session, statuses[session.status], undefined, true)));
    }
    if (missing.length) lines.push('状态不可用：' + missing.slice(0, 8).join('、') + (missing.length > 8 ? '等工作空间' : ''));
    const sessions = [...running, ...waiting, ...ended].slice(0, optionLimit);
    const choices = sessions.map((session) => {
      const value = randomUUID();
      menu.sessions.set(value, session);
      return { value, text: statuses[session.status] + ' · ' + session.workspace.name + ' / ' + session.project + ' / ' + session.title };
    });
    while (menu.sessions.size > 100) menu.sessions.delete(menu.sessions.keys().next().value!);
    if (!choices.length && !details) lines.unshift('暂无可选会话。');
    const monitor = url(config, { view: 'attention' });
    return card(title, ...(lines.length ? [panel(lines.join('\n'))] : []), ...(choices.length ? [
      form('session', '打开所选会话', options(choices)),
    ] : []), ...(details ? [action('刷新', 'activity')] : [action('刷新全部会话', 'sessions')]),
    ...(details && monitor ? [link('打开网页任务动态', monitor)] : []), homeButton());
  }

  private session(config: NotificationConfig, session: Session, token: string) {
    const href = url(config, { workspace: session.workspace.id, session: session.id });
    return card('会话操作', panel([
      '**' + markdownLabel(session.title || '未命名会话') + '**',
      '工作空间：' + markdownLabel(session.workspace.name),
      '项目：' + markdownLabel(session.project || '未知'),
      '状态：' + statuses[session.status],
    ].join('\n')),
    form('send_' + token, '发送到会话', promptInput()),
    ...gitCommitShortcuts.map(({ id, label }) => action(label, 'git', token, id)),
    ...(href ? [link('打开会话', href)] : []), action('返回会话列表', 'sessions'), homeButton());
  }
}
