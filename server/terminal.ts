import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTerminalProcess } from './terminal-process.js';
import {
  isAuthorizedDevice,
  type ControlAuthorization,
  type Identity,
  type WorkspaceAuth,
} from './authorization.js';
import type { CodexSource } from './source.js';
import type { ProjectTerminal, TerminalOutput } from '../src/terminal-types.js';

const BUFFER_LIMIT = 256 * 1024;
const READ_LIMIT = 64 * 1024;
const IDLE_MS = 10 * 60 * 1000;

export class TerminalError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

type Entry = {
  info: ProjectTerminal;
  owner: Identity;
  pty: ReturnType<typeof createTerminalProcess>;
  buffer: string;
  start: number;
  end: number;
  touched: number;
  checking: boolean;
  killed: boolean;
};

/** Terminals belong to a login device and execute only on the owning workspace client. */
export class ProjectTerminals {
  private entries = new Map<string, Entry>();
  private pending = 0;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private auth: WorkspaceAuth,
    private source: Pick<CodexSource, 'get' | 'refresh'>,
    private authorization?: ControlAuthorization,
  ) {
    this.timer = setInterval(() => {
      for (const [id, entry] of this.entries) {
        if (Date.now() - entry.touched > (entry.info.running ? IDLE_MS : 60000)) {
          this.remove(id);
          continue;
        }
        if (!entry.checking) {
          entry.checking = true;
          void this.authorize(entry.owner)
            .catch(() => this.remove(id))
            .finally(() => {
              entry.checking = false;
            });
        }
      }
    }, 1000);
    this.timer.unref();
  }
  async authorize(identity: Identity) {
    if (!(await isAuthorizedDevice(this.auth.db, identity, this.authorization, () => !this.closed)))
      throw new TerminalError('登录或终端操作权限已失效，请重新登录。', 403);
  }
  async open(identity: Identity, sessionId: string, id: string, cols: number, rows: number) {
    await this.authorize(identity);
    const previous = this.entries.get(id);
    if (previous) return { ...this.owned(identity, sessionId, id).info };
    // Include creations waiting for filesystem/authorization checks in the capacity bound.
    if (
      this.entries.size + this.pending >= 16 ||
      [...this.entries.values()].filter((entry) => entry.owner.user.id === identity.user.id)
        .length +
        this.pending >=
        4
    )
      throw new TerminalError('打开的终端过多，请先关闭不需要的终端。', 429);
    this.pending++;
    try {
      await this.source.refresh(true);
      const session = await this.source.get(sessionId);
      if (!session) throw new TerminalError('找不到此会话', 404);
      if (!session.cwd || !path.isAbsolute(session.cwd))
        throw new TerminalError('此会话没有可用的项目目录。');
      let cwd: string;
      try {
        cwd = await realpath(session.cwd);
        if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
      } catch {
        throw new TerminalError('项目目录不存在或无法访问，请检查工作空间中的目录。');
      }
      await this.authorize(identity);
      // Concurrent retries with the same ID create one process.
      if (this.entries.has(id)) return { ...this.owned(identity, sessionId, id).info };
      const windows = process.platform === 'win32';
      const info: ProjectTerminal = {
        id,
        sessionId,
        cwd,
        shell: windows ? 'PowerShell' : path.basename(process.env.SHELL || '/bin/bash'),
        running: true,
        exitCode: null,
      };
      const pty = createTerminalProcess(
        { cwd, cols, rows },
        (value) => {
          entry.buffer += value;
          entry.end += value.length;
          if (entry.buffer.length > BUFFER_LIMIT) {
            entry.buffer = entry.buffer.slice(-BUFFER_LIMIT);
            entry.start = entry.end - entry.buffer.length;
          }
        },
        (exitCode) => {
          info.running = false;
          info.exitCode = exitCode;
          this.kill(entry);
        },
      );
      const entry: Entry = {
        info,
        owner: identity,
        pty,
        buffer: '',
        start: 0,
        end: 0,
        touched: Date.now(),
        checking: false,
        killed: false,
      };
      this.entries.set(id, entry);
      try {
        await pty.ready;
      } catch {
        this.remove(id);
        throw new TerminalError('无法启动项目终端，请检查工作空间的 Shell 环境。', 503);
      }
      try {
        await this.authorize(identity);
        if (!this.entries.has(id)) throw new TerminalError('终端已关闭，请重新打开。');
      } catch (error) {
        this.remove(id);
        throw error;
      }
      this.auth.log('terminal.open', identity.user.username, '');
      return { ...info };
    } finally {
      this.pending--;
    }
  }
  private owned(identity: Identity, sessionId: string, id: string) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.info.sessionId !== sessionId ||
      entry.owner.user.id !== identity.user.id ||
      entry.owner.sessionId !== identity.sessionId
    )
      throw new TerminalError('终端已关闭或不属于当前登录设备，请重新打开。', 404);
    entry.touched = Date.now();
    return entry;
  }
  read(identity: Identity, sessionId: string, id: string, after: number): TerminalOutput {
    const entry = this.owned(identity, sessionId, id);
    if (after > entry.end) throw new TerminalError('终端输出位置无效。', 400);
    const offset = Math.max(after, entry.start);
    let next = Math.min(entry.end, offset + READ_LIMIT);
    // Keep Unicode code points intact when a read ends between a surrogate pair.
    const code = entry.buffer.charCodeAt(next - entry.start - 1);
    if (next < entry.end && code >= 0xd800 && code <= 0xdbff) next--;
    return {
      ...entry.info,
      data: entry.buffer.slice(offset - entry.start, next - entry.start),
      next,
      truncated: after < entry.start,
    };
  }
  write(identity: Identity, sessionId: string, id: string, data: string) {
    const entry = this.owned(identity, sessionId, id);
    if (!entry.info.running) throw new TerminalError('终端进程已退出，请重新打开。');
    if (!entry.pty.write(data)) throw new TerminalError('终端连接已中断，请重新打开。');
  }
  resize(identity: Identity, sessionId: string, id: string, cols: number, rows: number) {
    const entry = this.owned(identity, sessionId, id);
    if (entry.info.running) entry.pty.resize(cols, rows);
  }
  removeOwned(identity: Identity, sessionId: string, id: string) {
    if (!this.entries.has(id)) return;
    this.owned(identity, sessionId, id);
    this.remove(id);
  }
  private remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.kill(entry);
  }
  private kill(entry: Entry) {
    if (entry.killed) return;
    entry.killed = true;
    try {
      entry.pty.kill();
    } catch {
      /* The process may already have exited. */
    }
  }
  closeAll() {
    for (const id of this.entries.keys()) this.remove(id);
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.closeAll();
  }
}
