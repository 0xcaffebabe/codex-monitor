import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ControlError } from './control-error.js';
import { reasoningEfforts, type CodexModel, type ReasoningEffort } from '../src/types.js';

const readMethods = new Set(['initialize', 'thread/goal/get', 'model/list']);

function cliPath() {
  const explicit = process.env.MONITOR_CODEX_CLI || process.env.CODEX_APP_RUNTIME_CLI_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  if (process.platform !== 'win32') return 'codex';
  const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  const paths = existsSync(root)
    ? readdirSync(root)
        .map((name) => path.join(root, name, 'codex.exe'))
        .filter(existsSync)
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (!paths[0]) throw new ControlError('找不到 Codex 命令行，请在本机配置 MONITOR_CODEX_CLI。');
  return paths[0];
}

/** Read models and operate on persisted goals without resuming or taking over a thread. */
export class NativeRpc {
  private process?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      readOnly: boolean;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private codexHome?: string,
    private launch?: () => ChildProcessWithoutNullStreams,
  ) {}
  private start() {
    if (this.ready) return this.ready;
    const child =
      this.launch?.() ??
      spawn(cliPath(), ['app-server', '--listen', 'stdio://'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) },
      });
    this.process = child;
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    lines.on('line', (line) => {
      try {
        const response = JSON.parse(line),
          pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error)
          pending.reject(
            new ControlError(
              'Codex 操作失败：' + String(response.error.message).slice(0, 300),
              false,
              502,
            ),
          );
        else pending.resolve(response.result);
      } catch {
        /* Non-response diagnostic lines cannot resolve a request. */
      }
    });
    const disconnected = () => {
      lines.close();
      // A previous process can emit exit after its replacement has started.
      if (this.process === child) this.close();
    };
    child.stdin.on('error', disconnected);
    child.on('error', disconnected);
    child.on('exit', disconnected);
    this.ready = this.requestRaw('initialize', {
      clientInfo: { name: 'codex_monitor', version: '1.1.0' },
      capabilities: { experimentalApi: true },
    })
      .then(() => {
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      })
      .catch((error) => {
        if (this.process === child) this.close();
        throw error;
      });
    return this.ready;
  }
  private requestRaw(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = this.process;
      if (!child) {
        reject(new ControlError('Codex 服务连接已关闭，请重试。', false, 503));
        return;
      }
      const id = this.nextId++,
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new ControlError(
              readMethods.has(method)
                ? '读取 Codex 超时，请重试。'
                : '操作结果待确认，请查询后再操作。',
              !readMethods.has(method),
              504,
            ),
          );
        }, 30000);
      this.pending.set(id, { resolve, reject, timer, readOnly: readMethods.has(method) });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new ControlError('Codex 服务连接中断，请查询后重试。', !readMethods.has(method)));
        }
      });
    });
  }
  async models(): Promise<CodexModel[]> {
    await this.start();
    const models = new Map<string, CodexModel>(),
      cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.requestRaw('model/list', {
        includeHidden: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result.data)) throw new ControlError('Codex 模型列表无效，请重试。');
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
    await this.start();
    return (await this.requestRaw('thread/goal/get', { threadId })).goal;
  }
  async set(threadId: string, input: { objective?: string; status?: string }) {
    await this.start();
    // Human input is recorded by the desktop owner; this helper must not acquire
    // that thread's live writer to append an origin:user instruction.
    return (await this.requestRaw('thread/goal/set', { threadId, ...input })).goal;
  }
  async clear(threadId: string) {
    await this.start();
    return this.requestRaw('thread/goal/clear', { threadId });
  }
  close() {
    const child = this.process;
    this.process = undefined;
    this.ready = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ControlError('Codex 服务连接中断，请查询后重试。', !pending.readOnly));
    }
    this.pending.clear();
    if (child) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
      child.unref();
    }
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

async function requestOwnedThread(
  threadId: string,
  method: string,
  params: object,
  version: number,
  label: string,
  codexHome?: string,
  endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\codex-ipc'
    : path.join(codexHome || process.env.CODEX_HOME || '', 'ipc', 'ipc.sock'),
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
          new ControlError(`${label}结果待确认，请先检查会话记录，勿重复执行。`, dispatched, 504),
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
        timeoutMs: 60000,
      });
    socket.on('connect', () => request(initializeId, 'initialize', { clientType: 'desktop' }));
    socket.on('error', () =>
      finish(new ControlError('无法连接会话控制服务，请打开 Codex 桌面版。', dispatched)),
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
              dispatched,
              409,
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
        } else if (message.result?.ok === true) finish(undefined, message.result);
        else
          finish(new ControlError(`无法确认${label}回执，请检查会话记录，勿重复操作。`, true, 502));
      }
    });
  });
}
