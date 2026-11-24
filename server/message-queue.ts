import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ControlError, hasUnconfirmedWriter, type DesktopControl } from './desktop.js';
import type { CodexSource } from './source.js';
import type { ReasoningEffort, SessionMessageSettings } from '../src/types.js';
import { validateModelSettings } from './model-settings.js';
import { sessionPermissionModes } from '../src/approval-types.js';

export type ControlLane = <T>(threadId: string, operation: () => Promise<T>) => Promise<T>;
const waitingMessage = '消息已排队，等待上下文压缩结束后自动发送。';
const desktopWaitingMessage = '桌面通道消息已排队，等待当前执行结束后交接桌面。';

/** Only queued inputs can be resumed. A dispatched input always needs a definite receipt. */
export class MessageQueue {
  private closed = false;
  private workers = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private db: DatabaseSync,
    private source: CodexSource,
    private bridge: DesktopControl,
    private context: (target?: string) => Promise<string>,
    private inLane: ControlLane,
    private authorizeUser?: (userId: string) => Promise<boolean>,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS control_message_queue (
      request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, prompt TEXT NOT NULL, ip TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS control_message_queue_thread ON control_message_queue(thread_id);`);
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(control_message_queue)')
        .all()
        .map((row) => row.name),
    );
    for (const name of ['model', 'thinking', 'channel', 'permission_mode'])
      if (!columns.has(name)) db.exec(`ALTER TABLE control_message_queue ADD COLUMN ${name} TEXT`);
    db.prepare(
      "DELETE FROM control_message_queue WHERE request_id NOT IN (SELECT id FROM control_requests WHERE state='queued')",
    ).run();
    this.timer = setInterval(() => this.drain(), 1500);
    this.timer.unref();
    queueMicrotask(() => this.drain());
  }

  private receipt(userId: string, requestId: string, initial = false) {
    const row = this.db
      .prepare('SELECT state,result_json FROM control_requests WHERE id=? AND user_id=?')
      .get(requestId, userId);
    if (!row) throw new ControlError('找不到该发送请求', false, 404);
    const result = row.result_json ? JSON.parse(String(row.result_json)) : {};
    const httpStatus =
      row.state === 'succeeded' || row.state === 'cancelled'
        ? 200
        : row.state === 'queued' || row.state === 'pending'
          ? 202
          : row.state === 'unknown' && !initial
            ? 409
            : result.httpStatus || 502;
    return { ...result, state: String(row.state), requestId, httpStatus };
  }

  async submit(
    userId: string,
    ip: string,
    threadId: string,
    input: { requestId: string; prompt: string } & SessionMessageSettings,
  ) {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          threadId,
          input.prompt,
          ...(input.model ? [{ model: input.model, thinking: input.thinking }] : []),
          ...(input.channel ? [{ channel: input.channel }] : []),
          ...(input.permissionMode ? [{ permissionMode: input.permissionMode }] : []),
        ]),
      )
      .digest('hex');
    const existing = this.db
      .prepare('SELECT user_id,fingerprint FROM control_requests WHERE id=?')
      .get(input.requestId);
    if (existing) {
      if (existing.user_id !== userId || existing.fingerprint !== fingerprint)
        throw new ControlError('请求 ID 已被使用，请刷新后重试。', false, 409);
    } else {
      this.db.exec('BEGIN');
      try {
        this.db
          .prepare('INSERT INTO control_requests VALUES(?,?,?,?,?,?)')
          .run(
            input.requestId,
            userId,
            fingerprint,
            'queued',
            JSON.stringify({ threadId, message: '消息已加入队列，将按顺序自动发送。' }),
            Date.now(),
          );
        this.db
          .prepare(
            'INSERT INTO control_message_queue (request_id,thread_id,prompt,ip,model,thinking,channel,permission_mode) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            input.requestId,
            threadId,
            input.prompt,
            ip,
            input.model ?? null,
            input.thinking ?? null,
            input.channel ?? null,
            input.permissionMode ?? null,
          );
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    // Keep fast sends synchronous, but return a receipt promptly while a thread is busy.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.start(threadId),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return this.receipt(userId, input.requestId, !existing);
  }

  cancel(userId: string, requestId: string) {
    const result = this.receipt(userId, requestId);
    if (result.state === 'pending')
      return { ...result, httpStatus: 409, error: '消息正在提交，已无法取消，请等待发送结果。' };
    if (result.state !== 'queued') return result;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          "UPDATE control_requests SET state='cancelled',result_json=? WHERE id=? AND state='queued'",
        )
        .run(JSON.stringify({ message: '已取消排队，消息未发送。' }), requestId);
      this.db.prepare('DELETE FROM control_message_queue WHERE request_id=?').run(requestId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.receipt(userId, requestId);
  }

  private drain() {
    if (this.closed) return;
    const threads = this.db
      .prepare(
        "SELECT DISTINCT thread_id FROM control_message_queue q JOIN control_requests r ON r.id=q.request_id WHERE r.state='queued'",
      )
      .all();
    for (const row of threads) void this.start(String(row.thread_id));
  }
  private start(threadId: string) {
    if (this.closed) return Promise.resolve();
    const active = this.workers.get(threadId);
    if (active) return active;
    const job = this.inLane(threadId, () => this.deliver(threadId))
      .catch(() => {
        // Unclaimed inputs remain queued; claimed inputs are never automatically replayed.
      })
      .finally(() => this.workers.delete(threadId));
    this.workers.set(threadId, job);
    return job;
  }
  private finish(requestId: string, state: string, result: object) {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          "UPDATE control_requests SET state=?,result_json=? WHERE id=? AND state IN ('queued','pending')",
        )
        .run(state, JSON.stringify(result), requestId);
      this.db.prepare('DELETE FROM control_message_queue WHERE request_id=?').run(requestId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private waiting(requestId: string, threadId: string, message = waitingMessage) {
    this.db
      .prepare(
        "UPDATE control_requests SET state='queued',result_json=? WHERE id=? AND state IN ('queued','pending')",
      )
      .run(JSON.stringify({ threadId, message }), requestId);
  }
  private async deliver(threadId: string) {
    if (this.closed) return;
    const row = this.db
      .prepare(
        `SELECT q.*, r.user_id, u.role, u.username FROM control_message_queue q
       JOIN control_requests r ON r.id=q.request_id LEFT JOIN users u ON u.id=r.user_id
       WHERE q.thread_id=? AND r.state='queued' ORDER BY q.rowid LIMIT 1`,
      )
      .get(threadId);
    if (!row) return;
    const requestId = String(row.request_id);
    const session = await this.source.get(threadId);
    if (this.closed) return;
    if (
      (!this.authorizeUser && row.role !== 'admin') ||
      !session ||
      session.archived ||
      session.subagent
    ) {
      this.finish(requestId, 'failed', {
        httpStatus: !this.authorizeUser && row.role !== 'admin' ? 403 : 409,
        error:
          !this.authorizeUser && row.role !== 'admin'
            ? '发送权限已失效，排队消息未发送。'
            : '会话已不可发送，排队消息未发送。',
      });
      return;
    }
    let caller: string, state: Awaited<ReturnType<DesktopControl['state']>>;
    const stateOptions = row.channel === 'desktop' ? { inspectOwner: true } : undefined;
    try {
      caller = await this.context(threadId);
      if (this.closed) return;
      state = await this.bridge.state(caller, threadId, stateOptions);
    } catch {
      if (!this.closed) this.waiting(requestId, threadId, '暂时无法连接 Codex，消息保留在队列中。');
      return;
    }
    if (this.closed) return;
    const permissionMode = sessionPermissionModes.find((mode) => mode === row.permission_mode);
    if (row.permission_mode && (!permissionMode || !this.bridge.messagePermissions || row.channel === 'desktop')) {
      this.finish(requestId, 'failed', {
        httpStatus: 409,
        error: '无法应用所选会话权限，消息未发送。',
      });
      return;
    }
    const settings: SessionMessageSettings = {
      ...(row.model ? { model: String(row.model) } : {}),
      ...(row.thinking ? { thinking: String(row.thinking) as ReasoningEffort } : {}),
      ...(row.channel === 'desktop' ? { channel: 'desktop' as const } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    };
    if (settings.channel === 'desktop' && !this.bridge.desktopChannel) {
      this.finish(requestId, 'failed', {
        httpStatus: 409,
        error: '此客户端暂不支持桌面通道，请更新客户端后重试。',
      });
      return;
    }
    // Only monitor-owned runtimes need a handoff; desktop turns accept mid-turn input.
    if (
      settings.channel === 'desktop' &&
      ((state.status === 'active' && state.owner === 'monitor') ||
        (state.status === 'notLoaded' && session.status === 'running'))
    ) {
      this.waiting(requestId, threadId, desktopWaitingMessage);
      return;
    }
    if (settings.model && !state.compacting && state.status !== 'active') {
      try {
        await validateModelSettings(this.bridge, settings);
        if (this.closed) return;
        // Model discovery can take time; only a new turn may change its settings.
        state = await this.bridge.state(caller, threadId, stateOptions);
      } catch (error) {
        if (!this.closed)
          this.finish(requestId, 'failed', {
            httpStatus: error instanceof ControlError ? error.status : 503,
            error:
              error instanceof ControlError
                ? error.message
                : '暂时无法验证模型设置，消息未发送，请重试。',
          });
        return;
      }
    }
    if (this.closed) return;
    await this.source.refresh(true);
    const current = await this.source.get(threadId);
    if (this.closed) return;
    if (!current || current.archived || current.subagent) {
      this.finish(requestId, 'failed', {
        httpStatus: 409,
        error: '会话已不可发送，排队消息未发送。',
      });
      return;
    }
    if (permissionMode && (state.owner === 'desktop' || state.compacting || !['idle', 'notLoaded'].includes(state.status))) {
      this.finish(requestId, 'failed', {
        httpStatus: 409,
        error: state.owner === 'desktop'
          ? '此会话由 Codex 桌面端持有，请在桌面端切换权限。'
          : '仅可在会话空闲时切换权限，消息未发送。',
      });
      return;
    }
    if (state.compacting) {
      this.waiting(requestId, threadId);
      return;
    }
    if (
      settings.channel === 'desktop' &&
      ((state.status === 'active' && state.owner === 'monitor') ||
        (state.status === 'notLoaded' && current.status === 'running'))
    ) {
      this.waiting(requestId, threadId, desktopWaitingMessage);
      return;
    }
    if (settings.model && state.status === 'active') {
      this.finish(requestId, 'failed', {
        httpStatus: 409,
        error: '会话已开始执行，请等待结束后切换模型，或选择沿用当前会话设置追加消息。',
      });
      return;
    }
    if (hasUnconfirmedWriter(state, current.status)) {
      this.finish(requestId, 'failed', {
        httpStatus: 409,
        error: '该会话正在其他客户端中执行，无法从当前桌面版追加消息。',
      });
      return;
    }
    // A remote client must confirm the server's current account permission before dispatch.
    // A broken connection throws and leaves an unclaimed input queued until reconnect.
    if (this.authorizeUser && !(await this.authorizeUser(String(row.user_id)))) {
      this.finish(requestId, 'failed', {
        httpStatus: 403,
        error: '发送权限已失效，排队消息未发送。',
      });
      return;
    }
    if (this.closed) return;
    // The claim is persisted immediately before dispatch. A crash after this point is uncertain.
    const claimed = this.db
      .prepare(
        "UPDATE control_requests SET state='pending',result_json=? WHERE id=? AND state='queued' AND user_id IN (SELECT id FROM users WHERE role='admin')",
      )
      .run(JSON.stringify({ threadId, message: '正在向 Codex 提交消息…' }), requestId);
    if (!claimed.changes) return;
    try {
      const result = await this.bridge.send(caller, threadId, String(row.prompt), settings);
      if (result.threadId !== threadId)
        throw new ControlError('Codex 回执中的会话不匹配，发送结果待确认。', true, 502);
    } catch (error) {
      if (this.closed) return;
      if (error instanceof ControlError && !error.uncertain && error.code === 'compacting') {
        this.waiting(requestId, threadId);
        return;
      }
      if (error instanceof ControlError && !error.uncertain && error.code === 'desktop_busy') {
        this.waiting(requestId, threadId, error.message);
        return;
      }
      const failure =
        error instanceof ControlError
          ? error
          : new ControlError('发送结果待确认，请检查会话记录，勿重复发送。', true, 502);
      this.finish(requestId, failure.uncertain ? 'unknown' : 'failed', {
        error: failure.message,
        httpStatus: failure.status,
      });
      return;
    }
    if (this.closed) return;
    this.finish(requestId, 'succeeded', {
      threadId,
      mode: state.status === 'active' ? 'append' : 'start',
      previousTurnId: state.turnId,
      acceptedAt: Date.now(),
    });
    this.db
      .prepare('INSERT INTO audit(at,action,username,ip) VALUES(?,?,?,?)')
      .run(Date.now(), 'message_sent', row.username!, row.ip!);
    await this.source.refresh(true);
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
}
