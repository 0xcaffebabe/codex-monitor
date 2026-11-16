import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DesktopControl, DesktopProject } from './desktop.js';
import { ControlError } from './control-error.js';
import {
  NativeRpc,
  requestOwnedThread,
  interruptOwnedThread,
  compactOwnedThread,
} from './native.js';
import type { SessionModelSettings, SessionCreationSettings } from '../src/types.js';
import { NativeApprovals } from './native-approvals.js';
import { generateSessionTitle } from './session-title.js';

type Activity = { turnId: string; running: boolean; compacting: boolean };
type Options = {
  codexHome: string;
  activity: (id: string) => Activity | undefined;
  onCreated?: (id: string) => void;
  projectPath?: string;
};
type NativeControl = Pick<NativeRpc, 'request' | 'models' | 'get' | 'set' | 'clear' | 'close'> & {
  dispose?: () => Promise<void>;
};

function noOwner(error: unknown) {
  return (
    error instanceof ControlError && ['no_owner', 'owner_unavailable'].includes(error.code || '')
  );
}

/** Share the CLI app-server and approval callbacks across Windows and macOS,
 * while routing desktop-owned threads to their existing owner. */
export class NativeDesktopControl implements DesktopControl {
  readonly contextRequired = false;
  readonly creationPermissions = true;
  readonly approvals = new NativeApprovals();
  private fileChanges = new Map<string, unknown>();
  private native: NativeControl;
  private runtimes = new Map<string, NativeControl>();
  private pendingRuntimes = new Set<NativeControl>();
  private turns = new Map<string, { turnId: string; running: boolean; compacting: boolean }>();
  private compacting = new Set<string>();
  private closed = false;
  private lanes = new Map<string, Promise<void>>();
  private titleJobs = new Map<string, AbortController>();

  constructor(
    private options: Options,
    private dependencies: {
      native?: NativeControl;
      owner?: typeof requestOwnedThread;
      launch?: ConstructorParameters<typeof NativeRpc>[1];
      generateTitle?: typeof generateSessionTitle;
    } = {},
  ) {
    this.native = dependencies.native ?? new NativeRpc(options.codexHome);
  }

  private createRuntime() {
    if (this.closed) throw new ControlError('客户端正在停止。', false, 503);
    const identity: { id?: string } = {};
    let runtime: NativeControl;
    runtime =
      this.dependencies.native && !this.dependencies.launch
        ? this.dependencies.native
        : new NativeRpc(this.options.codexHome, this.dependencies.launch, {
            request: (method, params, signal) => {
              if (!identity.id || (params as any)?.threadId !== identity.id)
                throw new ControlError('审批请求不属于此会话运行时。', false, 409);
              return this.approvals.request(
                method,
                params,
                signal,
                this.fileChanges.get(
                  `${(params as any)?.threadId}:${(params as any)?.turnId}:${(params as any)?.itemId}`,
                ),
              );
            },
            disconnected: () => {
              if (identity.id)
                for (const key of this.fileChanges.keys())
                  if (key.startsWith(`${identity.id}:`)) this.fileChanges.delete(key);
              if (identity.id && this.runtimes.get(identity.id) === runtime) {
                this.runtimes.delete(identity.id);
                this.turns.delete(identity.id);
                this.compacting.delete(identity.id);
              }
            },
            notification: (method, params) => {
              if (method === 'item/started' && params.item?.type === 'fileChange') {
                this.fileChanges.set(
                  `${params.threadId}:${params.turnId}:${params.item.id}`,
                  params.item.changes,
                );
                this.approvals.updateFileChanges(
                  params.threadId,
                  params.turnId,
                  params.item.id,
                  params.item.changes,
                );
              }
              if (method === 'item/fileChange/patchUpdated') {
                this.fileChanges.set(
                  `${params.threadId}:${params.turnId}:${params.itemId}`,
                  params.changes,
                );
                this.approvals.updateFileChanges(
                  params.threadId,
                  params.turnId,
                  params.itemId,
                  params.changes,
                );
              }
              if (method === 'turn/started' || method === 'turn/completed') {
                if (method === 'turn/completed') {
                  this.approvals.cancelTurn(params.threadId, params.turn.id);
                  for (const key of this.fileChanges.keys())
                    if (key.startsWith(`${params.threadId}:${params.turn.id}:`))
                      this.fileChanges.delete(key);
                }
                this.turns.set(params.threadId, {
                  turnId: params.turn.id,
                  running: method === 'turn/started',
                  compacting: false,
                });
                if (method === 'turn/completed') this.compacting.delete(params.threadId);
                if (method === 'turn/completed')
                  void this.releaseIdle(params.threadId, params.turn.id).catch(() => {});
              }
              if (method === 'item/started' && params.item?.type === 'contextCompaction') {
                this.turns.set(params.threadId, {
                  turnId: params.turnId,
                  running: true,
                  compacting: true,
                });
              }
            },
          });
    this.pendingRuntimes.add(runtime);
    return {
      runtime,
      register: (id: string) => {
        identity.id = id;
        this.pendingRuntimes.delete(runtime);
        this.runtimes.set(id, runtime);
      },
      discard: async () => {
        this.pendingRuntimes.delete(runtime);
        await (runtime.dispose?.() ?? runtime.close());
      },
    };
  }

  async projects(_context: string): Promise<DesktopProject[]> {
    const projects: DesktopProject[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.native.request('project/list', {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result.data))
        throw new ControlError('Codex 项目列表无效，请升级桌面版后重试。', false, 502);
      for (const entry of result.data) {
        const root = this.options.projectPath
          ? entry?.roots?.find(
              (r: any) =>
                typeof r?.path === 'string' && path.resolve(r.path) === this.options.projectPath,
            )?.path
          : entry?.roots?.[0]?.path;
        if (typeof entry?.id === 'string' && typeof root === 'string' && path.isAbsolute(root))
          projects.push({
            id: entry.id,
            name: typeof entry.name === 'string' ? entry.name : path.basename(root),
            path: root,
          });
      }
      cursor = result.nextCursor ?? undefined;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor)))
        throw new ControlError('Codex 项目列表分页异常。', false, 502);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return projects;
  }

  models() {
    return this.native.models();
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const job = (this.lanes.get(id) ?? Promise.resolve()).then(() => {
      if (this.closed) throw new ControlError('客户端正在停止。', false, 503);
      return action();
    });
    const lane = job.then(
      () => {},
      () => {},
    );
    this.lanes.set(id, lane);
    void lane.then(() => {
      if (this.lanes.get(id) === lane) this.lanes.delete(id);
    });
    return job;
  }

  private releaseIdle(id: string, turnId: string) {
    return this.serial(id, async () => {
      if (
        !this.runtimes.has(id) ||
        this.turns.get(id)?.turnId !== turnId ||
        this.turns.get(id)?.running
      )
        return;
      // Keep an active goal's runtime alive. Completed/paused threads release
      // their writer so the desktop can resume them without a writer conflict.
      if ((await this.native.get(id))?.status === 'active') return;
      const runtime = this.runtimes.get(id)!;
      const { thread } = await runtime.request('thread/read', {
        threadId: id,
        includeTurns: false,
      });
      if (thread.status?.type === 'active' || this.closed) return;
      // unsubscribe only removes notifications in some CLI builds. Process exit
      // is the reliable writer boundary and affects only this idle thread.
      this.runtimes.delete(id);
      await (runtime.dispose?.() ?? runtime.close());
    });
  }

  private owner(threadId: string, method: string, params = {}, version = 1, readOnly = false) {
    return (this.dependencies.owner ?? requestOwnedThread)(
      threadId,
      method,
      params,
      version,
      '会话操作',
      this.options.codexHome,
      undefined,
      readOnly,
    );
  }

  async state(_context: string, threadId: string) {
    const runtime = this.runtimes.get(threadId);
    let result: any;
    try {
      result = await (runtime ?? this.native).request('thread/read', {
        threadId,
        includeTurns: false,
      });
    } catch (error) {
      if (!runtime || this.runtimes.get(threadId) === runtime) throw error;
      result = await this.native.request('thread/read', { threadId, includeTurns: false });
    }
    const { thread } = result;
    if (thread?.id !== threadId) throw new ControlError('Codex 返回了错误的会话。', false, 502);
    const local = this.turns.get(threadId) ?? this.options.activity(threadId);
    if (this.runtimes.has(threadId) && thread.status?.type !== 'notLoaded') {
      return {
        status: thread.status.type,
        turnId: local?.turnId,
        compacting:
          this.compacting.has(threadId) ||
          (thread.status.type === 'active' &&
            (!!local?.compacting || !!this.options.activity(threadId)?.compacting)),
      };
    }
    if (runtime && this.runtimes.get(threadId) === runtime) {
      this.runtimes.delete(threadId);
      await (runtime.dispose?.() ?? runtime.close());
    }
    const persisted = this.options.activity(threadId);
    if (persisted && !persisted.running)
      return { status: 'notLoaded', turnId: persisted.turnId, compacting: false };
    try {
      // This read confirms a live owner without loading history or claiming its writer.
      await this.owner(threadId, 'thread-follower-read-model-settings', {}, 1, true);
      const activity = this.options.activity(threadId);
      return {
        status: activity?.running ? 'active' : 'idle',
        turnId: activity?.turnId,
        compacting: !!activity?.compacting,
      };
    } catch (error) {
      if (!noOwner(error)) throw error;
      return { status: 'notLoaded', turnId: local?.turnId, compacting: false };
    }
  }

  send(context: string, threadId: string, prompt: string, settings: SessionModelSettings = {}) {
    return this.serial(threadId, () => this.sendNow(context, threadId, prompt, settings));
  }

  private async sendNow(
    _context: string,
    threadId: string,
    prompt: string,
    settings: SessionModelSettings,
  ) {
    const input = [{ type: 'text', text: prompt }];
    const request = {
      threadId,
      input,
      clientUserMessageId: randomUUID(),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.thinking ? { effort: settings.thinking } : {}),
    };
    let runtime = this.runtimes.get(threadId);
    if (!runtime) {
      try {
        const receipt = await this.owner(
          threadId,
          'thread-follower-start-turn',
          { turnStart: { request } },
          2,
        );
        if (typeof receipt.result?.turn?.id !== 'string')
          throw new ControlError('桌面发送回执无效，请检查原请求，勿重复发送。', true, 502);
        return { threadId };
      } catch (error) {
        if (!noOwner(error)) throw error;
      }
      if (this.closed) throw new ControlError('客户端正在停止，消息未发送。', false, 503);
      const created = this.createRuntime();
      try {
        await created.runtime.request('thread/resume', { threadId, excludeTurns: true });
        created.register(threadId);
        runtime = created.runtime;
      } catch (error) {
        await created.discard();
        throw error;
      }
    }
    const { turn } = await runtime.request('turn/start', request);
    if (!turn?.id) throw new ControlError('发送回执无效，请检查会话，勿重复发送。', true, 502);
    if (this.turns.get(threadId)?.turnId !== turn.id)
      this.turns.set(threadId, {
        turnId: turn.id,
        running: turn.status === 'inProgress',
        compacting: false,
      });
    return { threadId };
  }

  private async nameNewSession(threadId: string, cwd: string, prompt: string, model?: string) {
    if (this.closed || this.titleJobs.has(threadId)) return;
    const job = new AbortController();
    this.titleJobs.set(threadId, job);
    try {
      const name = await (this.dependencies.generateTitle ?? generateSessionTitle)({
        codexHome: this.options.codexHome,
        cwd,
        prompt,
        model,
        signal: job.signal,
      });
      if (!name || this.closed || job.signal.aborted) return;
      // Read metadata without acquiring the conversation's writer. Preserve any
      // name the user or the desktop saved while generation was in progress.
      const { thread } = await this.native.request('thread/read', {
        threadId,
        includeTurns: false,
      });
      if (this.closed || job.signal.aborted || thread?.id !== threadId || thread.name?.trim())
        return;
      await this.native.request('thread/name/set', { threadId, name });
    } catch (error) {
      if (!this.closed && !job.signal.aborted)
        console.warn(
          '自动生成会话标题失败：',
          threadId,
          error instanceof Error ? error.message : error,
        );
    } finally {
      this.titleJobs.delete(threadId);
    }
  }

  async create(
    context: string,
    projectId: string,
    prompt: string,
    settings: SessionCreationSettings = {},
  ) {
    const project = (await this.projects(context)).find((project) => project.id === projectId);
    if (!project) throw new ControlError('项目不可用，请刷新项目列表。', false, 400);
    const created = this.createRuntime();
    const permissionMode = settings.permissionMode ?? 'danger-full-access';
    const fullAccess = permissionMode === 'danger-full-access';
    let thread: any;
    try {
      ({ thread } = await created.runtime.request('thread/start', {
        cwd: project.path,
        projectId,
        ...(permissionMode !== 'inherit'
          ? {
              sandbox: fullAccess
                ? 'danger-full-access'
                : permissionMode === 'read-only'
                  ? 'read-only'
                  : 'workspace-write',
              approvalPolicy: fullAccess ? 'never' : 'on-request',
              approvalsReviewer: 'user',
              ...(!fullAccess
                ? {
                    config: {
                      'sandbox_workspace_write.network_access':
                        permissionMode === 'workspace-write-network',
                    },
                  }
                : {}),
            }
          : {}),
        ...(settings.model ? { model: settings.model } : {}),
      }));
    } catch (error) {
      await created.discard();
      throw error;
    }
    if (!thread?.id) {
      await created.discard();
      throw new ControlError('新建会话回执无效，请检查会话列表，勿重复创建。', true, 502);
    }
    created.register(thread.id);
    this.options.onCreated?.(thread.id);
    try {
      await this.send(context, thread.id, prompt, settings);
    } catch {
      throw new ControlError(
        `会话 ${thread.id} 已创建，但首条消息结果待确认，请打开此会话检查，勿重复创建。`,
        true,
        502,
      );
    }
    void this.nameNewSession(thread.id, project.path, prompt, settings.model);
    return { threadId: thread.id };
  }

  async goal(
    threadId: string,
    action: 'get' | 'set' | 'pause' | 'resume' | 'clear',
    objective?: string,
  ) {
    const runtime = this.runtimes.get(threadId);
    const rpc = runtime ?? this.native;
    if (action === 'get') return this.native.get(threadId);
    if (action === 'clear') {
      await rpc.clear(threadId);
      const turn = this.turns.get(threadId);
      if (turn && !turn.running) void this.releaseIdle(threadId, turn.turnId).catch(() => {});
      return null;
    }
    const result = await rpc.set(
      threadId,
      action === 'set'
        ? { objective, status: 'active' }
        : { status: action === 'pause' ? 'paused' : 'active' },
    );
    const turn = this.turns.get(threadId);
    if (action === 'pause' && turn && !turn.running)
      void this.releaseIdle(threadId, turn.turnId).catch(() => {});
    return result;
  }

  compact(threadId: string) {
    return this.serial(threadId, () => this.compactNow(threadId));
  }

  private async compactNow(threadId: string) {
    let runtime = this.runtimes.get(threadId);
    if (!runtime) {
      try {
        await compactOwnedThread(threadId, this.options.codexHome);
        return;
      } catch (error) {
        if (!noOwner(error)) throw error;
      }
      if (this.closed) throw new ControlError('客户端正在停止，压缩未提交。', false, 503);
      const created = this.createRuntime();
      try {
        await created.runtime.request('thread/resume', { threadId, excludeTurns: true });
        created.register(threadId);
        runtime = created.runtime;
      } catch (error) {
        await created.discard();
        throw error;
      }
    }
    this.compacting.add(threadId);
    try {
      await runtime.request('thread/compact/start', { threadId });
    } catch (error) {
      this.compacting.delete(threadId);
      throw error;
    }
  }

  async interrupt(threadId: string, turnId: string) {
    const before = await this.native.get(threadId);
    let result: { interruptedTurnId: string | null; goalPauseError?: string };
    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      const state = await this.state(threadId, threadId);
      if (state.turnId !== turnId)
        throw new ControlError('当前轮次已变化，请刷新后重试。', false, 409);
      if (state.status !== 'active') return { interruptedTurnId: null };
      await runtime.request('turn/interrupt', { threadId, turnId });
      result = { interruptedTurnId: turnId };
    } else result = await interruptOwnedThread(threadId, turnId, this.options.codexHome);
    if (result.interruptedTurnId && before?.status === 'active') {
      try {
        const current = await this.native.get(threadId);
        if (
          current?.status === 'active' &&
          current.objective === before.objective &&
          current.createdAt === before.createdAt
        ) {
          const latest = this.runtimes.has(threadId)
            ? this.turns.get(threadId)
            : this.options.activity(threadId);
          if (latest?.turnId !== turnId) throw new Error('停止后轮次已变化，未改动新的目标。');
          await (this.runtimes.get(threadId) ?? this.native).set(threadId, { status: 'paused' });
        }
        const confirmed = await this.native.get(threadId);
        if (confirmed?.status === 'active') throw new Error('目标仍在运行，请手动暂停目标。');
        delete result.goalPauseError;
      } catch {
        result.goalPauseError = '无法确认目标已暂停，请刷新目标状态。';
      }
    }
    if (result.interruptedTurnId) void this.releaseIdle(threadId, turnId).catch(() => {});
    return result;
  }

  close() {
    this.closed = true;
    for (const job of this.titleJobs.values()) job.abort();
    this.titleJobs.clear();
    this.approvals.close();
    this.fileChanges.clear();
    for (const runtime of new Set([
      this.native,
      ...this.runtimes.values(),
      ...this.pendingRuntimes,
    ])) {
      if (runtime.dispose) void runtime.dispose().catch(() => {});
      else runtime.close();
    }
    this.runtimes.clear();
    this.pendingRuntimes.clear();
  }
}
