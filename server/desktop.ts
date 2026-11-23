import net from 'node:net';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ControlError, activeWriterError, compactingError } from './control-error.js';
import { NativeRpc, compactOwnedThread, interruptOwnedThread } from './native.js';
import type {
  CodexModel,
  SessionModelSettings,
  SessionMessageSettings,
  SessionCreationSettings,
  SessionStatus,
} from '../src/types.js';
import type { ApprovalControl, SessionPermissionMode } from '../src/approval-types.js';
export { ControlError } from './control-error.js';
export interface DesktopProject {
  id: string;
  name: string;
  path: string;
}
type DesktopThreadState = {
  status: string;
  turnId?: string;
  compacting?: boolean;
  owner?: 'monitor' | 'desktop';
  permissionMode?: Exclude<SessionPermissionMode, 'inherit'>;
  canAttemptResume?: boolean;
};

export function hasUnconfirmedWriter(state: DesktopThreadState, historyStatus: SessionStatus) {
  return state.status === 'notLoaded' && !state.canAttemptResume && historyStatus === 'running';
}

export interface DesktopControl {
  contextRequired?: boolean;
  approvals?: ApprovalControl;
  creationPermissions?: boolean;
  messagePermissions?: boolean;
  desktopChannel?: boolean;
  projects(context: string): Promise<DesktopProject[]>;
  models(): Promise<CodexModel[]>;
  state(
    context: string,
    threadId: string,
    options?: { inspectOwner?: boolean },
  ): Promise<DesktopThreadState>;
  send(
    context: string,
    threadId: string,
    prompt: string,
    settings?: SessionMessageSettings,
  ): Promise<{ threadId: string }>;
  create(
    context: string,
    projectId: string,
    prompt: string,
    settings?: SessionCreationSettings,
  ): Promise<{ threadId: string }>;
  goal(
    threadId: string,
    action: 'get' | 'set' | 'pause' | 'resume' | 'clear',
    objective?: string,
  ): Promise<any>;
  compact(threadId: string): Promise<void>;
  interrupt(
    threadId: string,
    turnId: string,
  ): Promise<{ interruptedTurnId: string | null; goalPauseError?: string }>;
  close?(): void;
}

const MAX_FRAME = 8 * 1024 * 1024;
function rejection(message: string) {
  return (
    compactingError(message) ??
    activeWriterError(message) ??
    new ControlError(message.slice(0, 500), false, 502)
  );
}

/** The desktop app owns routing to the live thread, including mid-turn input. */
export class DesktopBridge implements DesktopControl {
  readonly desktopChannel = true;
  private native: NativeRpc;
  constructor(
    private options: {
      pipe?: string;
      timeoutMs?: number;
      codexHome?: string;
      activity?: (threadId: string) => { turnId: string; compacting: boolean } | undefined;
    } = {},
  ) {
    this.native = new NativeRpc(options.codexHome);
  }

  private async connect(): Promise<net.Socket> {
    const configured = this.options.pipe || process.env.MONITOR_CODEX_PIPE;
    const inherited = process.env.CODEX_APP_TOOLS_PIPE_PATH;
    let paths = configured ? [configured] : inherited ? [inherited] : [];
    if (!configured && process.platform === 'win32') {
      const pipes = await readdir('\\\\.\\pipe\\').catch(() => [] as string[]);
      paths = [
        ...new Set([
          ...paths,
          ...pipes.filter((p) => p.startsWith('codex-app-tools-')).map((p) => `\\\\.\\pipe\\${p}`),
        ]),
      ];
    }
    const connected: net.Socket[] = [];
    for (const pipe of paths) {
      const socket = await new Promise<net.Socket | undefined>((resolve) => {
        const s = net.createConnection(pipe);
        const timer = setTimeout(() => {
          s.destroy();
          resolve(undefined);
        }, 1200);
        s.once('error', () => {
          clearTimeout(timer);
          s.destroy();
          resolve(undefined);
        });
        s.once('connect', () => {
          clearTimeout(timer);
          resolve(s);
        });
      });
      if (socket) connected.push(socket);
    }
    if (connected.length === 1) return connected[0];
    for (const socket of connected) socket.destroy();
    throw new ControlError(
      connected.length
        ? '检测到多个 Codex 桌面实例，请在本机配置 MONITOR_CODEX_PIPE。'
        : '无法连接 Codex 桌面版，请打开桌面应用后重试。',
    );
  }

  private async call(context: string, tool: string, args: Record<string, unknown>): Promise<any> {
    const socket = await this.connect();
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0),
        dispatched = false,
        settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish(new ControlError('Codex 暂未返回回执，发送结果待确认。请勿重复发送。', true, 504)),
        this.options.timeoutMs ?? 90000,
      );
      socket.on('error', () =>
        finish(
          new ControlError(
            dispatched
              ? '与 Codex 的连接中断，发送结果待确认。请勿重复发送。'
              : '连接 Codex 失败，请重试。',
            dispatched,
          ),
        ),
      );
      socket.on('close', () =>
        finish(new ControlError('Codex 连接已关闭，发送结果待确认。请勿重复发送。', dispatched)),
      );
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const length = buffer.readUInt32LE(0);
        if (length === 0 || length > MAX_FRAME)
          return finish(new ControlError('Codex 返回了无效回执，发送结果待确认。', true));
        if (buffer.length < 4 + length) return;
        try {
          const response = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
          if (response.id !== 1) throw new Error('Unexpected response');
          if (response.error)
            return finish(
              rejection('Codex 拒绝了请求：' + String(response.error.message).slice(0, 500)),
            );
          const result = response.result;
          const content = result?.contentItems
            ?.filter((i: any) => i.type === 'inputText')
            .map((i: any) => i.text)
            .join('\n');
          if (!result?.success)
            return finish(rejection(content || 'Codex 未能处理请求，请检查桌面应用。'));
          let parsed: unknown;
          try {
            parsed = JSON.parse(content);
          } catch {
            throw new Error('Unrecognized desktop response');
          }
          finish(undefined, parsed);
        } catch {
          finish(
            new ControlError('无法确认 Codex 回执，发送结果待确认。请勿重复发送。', true, 502),
          );
        }
      });
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            namespace: 'codex_app',
            tool,
            arguments: args,
            threadId: context,
            turnId: 'monitor-web',
            callId: 'monitor-web-' + randomUUID(),
            callerSource: 'codex',
            hostId: 'local',
          },
        }),
      );
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      dispatched = true;
      socket.write(frame);
    });
  }

  async projects(context: string) {
    const result = await this.call(context, 'list_projects', {});
    return (result.projects ?? [])
      .filter((p: any) => p.projectKind === 'local' && p.hostId === 'local')
      .map((p: any) => ({ id: p.projectId, name: p.label, path: p.path }));
  }
  async state(context: string, threadId: string) {
    // read_thread materializes a whole turn before truncating outputs, so even
    // turnLimit:1 can fail for a long-running thread. Listings return live
    // desktop status without reading that history.
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const result = await this.call(context, 'list_threads', {
        mode: 'history',
        source: 'codex',
        hostId: 'local',
        archived: false,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      const thread = result.threads?.find(
        (thread: any) =>
          thread.id === threadId && thread.kind === 'codex' && thread.hostId === 'local',
      );
      if (thread) {
        if (!['active', 'idle', 'notLoaded', 'systemError'].includes(thread.status))
          throw new ControlError('无法确认此会话的实时状态，请稍后重试。', false, 503);
        const activity = this.options.activity?.(threadId);
        return {
          status: thread.status as string,
          turnId: activity?.turnId,
          compacting: thread.status === 'active' && !!activity?.compacting,
        };
      }
      cursor = result.nextCursor;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor)))
        throw new ControlError('会话列表分页异常，无法确认实时状态。', false, 503);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    throw new ControlError('当前本机 Codex 中找不到此会话，无法发送。', false, 409);
  }
  async send(
    context: string,
    threadId: string,
    prompt: string,
    settings: SessionModelSettings = {},
  ) {
    const result = await this.call(context, 'send_message_to_thread', {
      threadId,
      hostId: 'local',
      prompt,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.thinking ? { thinking: settings.thinking } : {}),
    });
    if (result.threadId !== threadId)
      throw new ControlError('Codex 回执中的会话不匹配，发送结果待确认。', true, 502);
    return { threadId };
  }
  async models() {
    return this.native.models();
  }
  async create(
    context: string,
    projectId: string,
    prompt: string,
    settings: SessionCreationSettings = {},
  ) {
    if (
      settings.channel === 'desktop' &&
      settings.permissionMode &&
      settings.permissionMode !== 'inherit'
    )
      throw new ControlError('桌面通道沿用 Codex 桌面端的权限设置。', false, 400);
    const result = await this.call(context, 'create_thread', {
      prompt,
      target: { type: 'project', projectId, environment: { type: 'local' } },
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.thinking ? { thinking: settings.thinking } : {}),
    });
    if (!result.threadId)
      throw new ControlError('新会话的创建结果待确认，请检查桌面应用，勿重复创建。', true, 502);
    return { threadId: result.threadId as string };
  }
  async goal(
    threadId: string,
    action: 'get' | 'set' | 'pause' | 'resume' | 'clear',
    objective?: string,
  ) {
    if (action === 'get') return this.native.get(threadId);
    if (action === 'clear') {
      await this.native.clear(threadId);
      return null;
    }
    return this.native.set(
      threadId,
      action === 'set'
        ? { objective, status: 'active' }
        : { status: action === 'pause' ? 'paused' : 'active' },
    );
  }
  async compact(threadId: string) {
    await compactOwnedThread(threadId, this.options.codexHome);
  }
  async interrupt(threadId: string, turnId: string) {
    return interruptOwnedThread(threadId, turnId, this.options.codexHome);
  }
  close() {
    this.native.close();
  }
}
