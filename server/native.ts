import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ControlError, activeWriterError, compactingError } from './control-error.js';
import { reasoningEfforts, type CodexModel, type ReasoningEffort } from '../src/types.js';
import os from 'node:os';
import { macBundledCli, macDesktopBundle } from './macos-paths.js';
import { windowsCliPaths } from './windows-paths.js';

const readMethods = new Set([
  'initialize',
  'thread/goal/get',
  'model/list',
  'thread/read',
  'thread/loaded/list',
  'config/read',
  'project/list',
  'project/read',
]);

async function* cliPaths(signal: AbortSignal): AsyncGenerator<string> {
  const explicit = process.env.MONITOR_CODEX_CLI;
  if (explicit) {
    if (!existsSync(explicit))
      throw new ControlError('配置的 Codex CLI 不存在，请检查 MONITOR_CODEX_CLI。');
    yield explicit;
    return;
  }
  const inherited = process.env.CODEX_APP_RUNTIME_CLI_PATH;
  if (inherited && existsSync(inherited)) yield inherited;
  if (process.platform === 'win32') {
    yield* windowsCliPaths(process.env, { signal });
    return;
  }
  if (process.platform === 'darwin') {
    const bundle = macDesktopBundle();
    if (bundle) yield macBundledCli(bundle)!;
  }
  yield 'codex';
}

export async function launchAppServer(
  executables: AsyncIterable<string> | Iterable<string>,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  launch: (
    file: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams = spawn,
) {
  const attempted = new Set<string>();
  let firstFailure: unknown;
  for await (const executable of executables) {
    signal.throwIfAborted();
    const key = process.platform === 'win32' ? executable.toLowerCase() : executable;
    if (attempted.has(key)) continue;
    attempted.add(key);
    try {
      const child = launch(executable, ['app-server', '--listen', 'stdio://'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      await once(child, 'spawn');
      return child;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') throw error;
      firstFailure ??= error;
    }
  }
  signal.throwIfAborted();
  if (firstFailure) throw firstFailure;
  throw new ControlError('找不到 Codex 命令行，请在本机配置 MONITOR_CODEX_CLI。');
}

function stopProcess(child: ChildProcessWithoutNullStreams) {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.kill();
  child.unref();
}

function launchError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new ControlError(
    `无法启动 Codex 服务${code ? `（${code}）` : ''}，请检查本机 Codex CLI。`,
  );
}

/** CLI app-server connection with separate client calls and server approval callbacks. */
export class NativeRpc {
  private process?: ChildProcessWithoutNullStreams;
  private startup?: AbortController;
  private ready?: Promise<ChildProcessWithoutNullStreams>;
  private disposed = false;
  private nextId = 1;
  private serverRequests = new Map<string, AbortController>();
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      method: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private codexHome?: string,
    private launch?: () => ChildProcessWithoutNullStreams,
    private events?: {
      notification?: (method: string, params: any) => void;
      disconnected?: () => void;
      request?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
    },
  ) {}
  private start() {
    if (this.disposed)
      return Promise.reject(new ControlError('会话运行时已释放，请重新连接。', false, 503));
    if (this.ready) return this.ready;
    const startup = new AbortController();
    this.startup = startup;
    this.ready = this.initialize(startup.signal).catch((error) => {
      if (this.startup === startup) this.close();
      throw error;
    });
    return this.ready;
  }
  private async initialize(signal: AbortSignal) {
    let child: ChildProcessWithoutNullStreams;
    try {
      child =
        this.launch?.() ??
        (await launchAppServer(
          cliPaths(signal),
          { ...process.env, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) },
          signal,
        ));
    } catch (error) {
      throw error instanceof ControlError ? error : launchError(error);
    }
    if (signal.aborted) {
      child.on('error', () => {});
      stopProcess(child);
      signal.throwIfAborted();
    }
    this.process = child;
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    lines.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        if (typeof response.method === 'string') {
          if (response.id !== undefined) {
            const key = `${typeof response.id}:${response.id}`;
            if (this.serverRequests.has(key)) return;
            const controller = new AbortController();
            this.serverRequests.set(key, controller);
            const reply = (value: object) => {
              if (controller.signal.aborted || this.process !== child || !child.stdin.writable)
                return;
              child.stdin.write(JSON.stringify({ id: response.id, ...value }) + '\n', () => {});
            };
            void Promise.resolve()
              .then(() => {
                if (!this.events?.request)
                  throw new Error(
                    'Codex Monitor cannot answer this interactive request. Use an interactive Codex client.',
                  );
                return this.events.request(response.method, response.params, controller.signal);
              })
              .then(
                (result) => reply({ result }),
                (error) =>
                  reply({
                    error: {
                      code: -32601,
                      message:
                        error instanceof Error ? error.message : 'Unsupported interactive request',
                    },
                  }),
              )
              .finally(() => {
                if (this.serverRequests.get(key) === controller) this.serverRequests.delete(key);
              });
          } else {
            if (response.method === 'serverRequest/resolved') {
              const key = `${typeof response.params?.requestId}:${response.params?.requestId}`;
              this.serverRequests.get(key)?.abort();
              this.serverRequests.delete(key);
            }
            this.events?.notification?.(response.method, response.params);
          }
          return;
        }
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error) {
          const message = String(response.error.message);
          pending.reject(
            compactingError(message) ??
              activeWriterError(message) ??
              new ControlError('Codex 操作失败：' + message.slice(0, 300), false, 502),
          );
        } else pending.resolve(response.result);
      } catch {
        /* Non-response diagnostic lines cannot resolve a request. */
      }
    });
    const disconnected = (initializationError: ControlError) => {
      lines.close();
      // A previous process can emit exit after its replacement has started.
      if (this.process === child) this.close(initializationError);
    };
    child.stdin.on('error', (error) => disconnected(launchError(error)));
    child.on('error', (error) => disconnected(launchError(error)));
    child.on('exit', (code, signal) =>
      disconnected(
        new ControlError(
          `Codex 服务在启动时退出（${signal ?? `退出码 ${code ?? '未知'}`}），请检查本机 Codex CLI。`,
        ),
      ),
    );
    await this.requestRaw(child, 'initialize', {
      clientInfo: { name: 'codex_monitor', version: '1.1.0' },
      capabilities: {
        experimentalApi: true,
        ...(this.events?.request ? { requiredHumanApproval: true } : {}),
      },
    });
    if (this.process !== child) throw new ControlError('Codex 服务在启动时断开，请重试。');
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    this.startup = undefined;
    return child;
  }
  async request(method: string, params: object): Promise<any> {
    return this.requestRaw(await this.start(), method, params);
  }
  private requestRaw(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: object,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.process !== child) {
        reject(new ControlError('Codex 服务连接已关闭，请重试。', false, 503));
        return;
      }
      const initializing = method === 'initialize';
      const readOnly = readMethods.has(method);
      const id = this.nextId++,
        timer = setTimeout(
          () => {
            this.pending.delete(id);
            reject(
              new ControlError(
                initializing
                  ? 'Codex 服务启动超时，请重试。'
                  : readOnly
                    ? '读取 Codex 超时，请重试。'
                    : '操作结果待确认，请查询后再操作。',
                !readOnly,
                504,
              ),
            );
          },
          initializing ? 60_000 : method === 'thread/compact/start' ? 90_000 : 30_000,
        );
      this.pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            initializing
              ? launchError(error)
              : new ControlError('Codex 服务连接中断，请查询后重试。', !readOnly),
          );
        }
      });
    });
  }
  async models(): Promise<CodexModel[]> {
    const child = await this.start();
    const models = new Map<string, CodexModel>(),
      cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.requestRaw(child, 'model/list', {
        includeHidden: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result?.data)) throw new ControlError('Codex 模型列表无效，请重试。');
      for (const entry of result.data) {
        if (!entry || entry.hidden || typeof entry.model !== 'string' || !entry.model.trim())
          continue;
        models.set(entry.model, {
          model: entry.model,
          displayName: typeof entry.displayName === 'string' ? entry.displayName : entry.model,
          supportedReasoningEfforts: Array.isArray(entry.supportedReasoningEfforts)
            ? [
                ...new Set<ReasoningEffort>(
                  entry.supportedReasoningEfforts
                    .map((option: any) => option?.reasoningEffort)
                    .filter((effort: any) => reasoningEfforts.includes(effort)),
                ),
              ]
            : [],
        });
      }
      cursor = result.nextCursor ?? undefined;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor)))
        throw new ControlError('Codex 模型列表分页异常，请重试。');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models.values()];
  }
  async get(threadId: string) {
    return (await this.request('thread/goal/get', { threadId })).goal;
  }
  async set(threadId: string, input: { objective?: string; status?: string }) {
    // Human input is recorded by the desktop owner; this helper must not acquire
    // that thread's live writer to append an origin:user instruction.
    return (await this.request('thread/goal/set', { threadId, ...input })).goal;
  }
  async clear(threadId: string) {
    return this.request('thread/goal/clear', { threadId });
  }
  /** Permanently release an idle runtime and wait until its writer process exits. */
  async dispose() {
    this.disposed = true;
    const child = this.process;
    if (!child || child.exitCode != null || child.signalCode != null) {
      this.close();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let force: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(force);
        resolve();
      };
      child.once('exit', finish);
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        force = setTimeout(() => {
          child.off('exit', finish);
          reject(new ControlError('CLI 尚未退出，无法确认写入权已释放。'));
        }, 1000);
        force.unref();
      }, 3000);
      this.close();
    });
  }
  close(initializationError?: ControlError) {
    const child = this.process;
    this.process = undefined;
    this.ready = undefined;
    this.startup?.abort(new ControlError('Codex 服务启动已取消，请重试。'));
    this.startup = undefined;
    for (const controller of this.serverRequests.values()) controller.abort();
    this.serverRequests.clear();
    this.events?.disconnected?.();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const startupFailure = pending.method === 'initialize' ? initializationError : undefined;
      pending.reject(
        startupFailure ??
          new ControlError('Codex 服务连接中断，请查询后重试。', !readMethods.has(pending.method)),
      );
    }
    this.pending.clear();
    if (child) stopProcess(child);
  }
}

/** Ask the existing desktop thread owner to compact its own live context. */
export async function compactOwnedThread(threadId: string, codexHome?: string, endpoint?: string) {
  await requestOwnedThread(
    threadId,
    'thread-follower-compact-thread',
    {},
    1,
    '压缩',
    codexHome,
    endpoint,
  );
}

/** Match the desktop stop action, including pausing an active goal. */
export async function interruptOwnedThread(
  threadId: string,
  turnId: string,
  codexHome?: string,
  endpoint?: string,
): Promise<{ interruptedTurnId: string | null; goalPauseError?: string }> {
  const result = await requestOwnedThread(
    threadId,
    'thread-follower-interrupt-turn',
    { mode: 'user-stop', expectedTurnId: turnId },
    4,
    '停止',
    codexHome,
    endpoint,
  );
  if (result.interruptedTurnId !== null && result.interruptedTurnId !== turnId)
    throw new ControlError('无法确认停止回执，请检查会话状态，勿重复操作。', true, 502);
  return {
    interruptedTurnId: result.interruptedTurnId,
    ...(typeof result.goalPauseError === 'string'
      ? { goalPauseError: result.goalPauseError.slice(0, 300) }
      : {}),
  };
}

export async function requestOwnedThread(
  threadId: string,
  method: string,
  params: object,
  version: number,
  label: string,
  codexHome?: string,
  endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\codex-ipc'
    : path.join(
        codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
        'ipc',
        'ipc.sock',
      ),
  readOnly = false,
) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let bytes = Buffer.alloc(0),
      clientId = 'initializing-client',
      dispatched = false,
      done = false;
    const initializeId = randomUUID(),
      discoverId = randomUUID(),
      operationId = randomUUID();
    const finish = (error?: Error, result: Record<string, any> = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          new ControlError(
            `${label}结果待确认，请先检查会话记录，勿重复执行。`,
            dispatched && !readOnly,
            504,
          ),
        ),
      90000,
    );
    const send = (value: object) => {
      const body = Buffer.from(JSON.stringify(value)),
        frame = Buffer.alloc(body.length + 4);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      socket.write(frame);
    };
    const request = (requestId: string, method: string, params: object, targetClientId?: string) =>
      send({
        type: 'request',
        requestId,
        sourceClientId: clientId,
        version: method === 'initialize' ? 0 : requestId === operationId ? version : 1,
        method,
        params,
        ...(targetClientId ? { targetClientId } : {}),
        timeoutMs: requestId === discoverId ? 2000 : 60000,
      });
    socket.on('connect', () => request(initializeId, 'initialize', { clientType: 'desktop' }));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        new ControlError(
          '无法连接会话控制服务，请打开 Codex 桌面版。',
          dispatched && !readOnly,
          503,
          !dispatched && ['ENOENT', 'ECONNREFUSED'].includes(error.code || '')
            ? 'owner_unavailable'
            : undefined,
        ),
      ),
    );
    socket.on('close', () =>
      finish(new ControlError(`会话控制连接中断，请检查${label}结果。`, dispatched)),
    );
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 4) {
        const size = bytes.readUInt32LE();
        if (size === 0 || size > 16 * 1024 * 1024)
          return finish(new ControlError(`会话控制回执无效，请检查${label}结果。`, dispatched));
        if (bytes.length < size + 4) return;
        let message: any;
        try {
          message = JSON.parse(bytes.subarray(4, 4 + size).toString());
        } catch {
          return finish(new ControlError('会话控制回执无效。', dispatched));
        }
        bytes = bytes.subarray(size + 4);
        if (message.type === 'client-discovery-request') {
          send({
            type: 'client-discovery-response',
            requestId: message.requestId,
            response: { canHandle: false },
          });
          continue;
        }
        if (
          message.type !== 'response' ||
          ![initializeId, discoverId, operationId].includes(message.requestId)
        )
          continue;
        if (message.resultType !== 'success')
          return finish(
            new ControlError(
              message.error === 'no-client-found'
                ? `请先在 Codex 桌面版打开此会话，再执行${label}。`
                : `${label}请求未成功：` + String(message.error).slice(0, 300),
              dispatched && !readOnly,
              409,
              message.error === 'no-client-found' ? 'no_owner' : undefined,
            ),
          );
        if (message.requestId === initializeId) {
          if (typeof message.result?.clientId !== 'string' || !message.result.clientId)
            return finish(new ControlError('会话控制初始化回执无效。', false, 502));
          clientId = message.result.clientId;
          request(discoverId, 'thread-owner-discovery', {
            hostId: 'local',
            conversationId: threadId,
          });
        } else if (message.requestId === discoverId) {
          if (typeof message.handledByClientId !== 'string' || !message.handledByClientId)
            return finish(new ControlError('无法确认会话所属客户端，请刷新后重试。', false, 502));
          dispatched = true;
          request(
            operationId,
            method,
            { conversationId: threadId, ...params },
            message.handledByClientId,
          );
        } else if (
          readOnly ||
          message.result?.ok === true ||
          Object.hasOwn(message.result ?? {}, 'result')
        )
          finish(undefined, message.result);
        else
          finish(new ControlError(`无法确认${label}回执，请检查会话记录，勿重复操作。`, true, 502));
      }
    });
  });
}
