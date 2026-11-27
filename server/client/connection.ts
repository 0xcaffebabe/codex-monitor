import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { WebSocket } from 'ws';
import type { AuthStore } from '../auth.js';
import { buildCommitAt } from '../build-info.js';
import type { Config } from '../config.js';
import { ControlError } from '../control-error.js';
import type { Identity } from '../http/access.js';
import type { WorkspaceServices } from '../workspace-runtime.js';
import {
  CHUNK_BYTES,
  MAX_FRAME,
  MAX_REQUESTS,
  PROTOCOL_VERSION,
  connectionProof,
  readFrame,
  sendFrame,
  startClientChannel,
  workspacePath,
  type Frame,
} from '../transport/protocol.js';
import { createClientRuntime } from './runtime.js';
import { clientConnectionUrl } from './config.js';
import { NotificationReporter } from '../notifications/reporter.js';
import type { LarkReplyAttachment } from '../notifications/lark-replies.js';
import {
  LEGACY_COMPLETION_SUMMARY_LIMIT,
  type NotificationReport,
} from '../notifications/events.js';
import { limitMarkdown } from '../notifications/markdown-limit.js';
import { HostResourceSampler } from './resources.js';
import { PrivacyWork } from './privacy-work.js';
import { HOST_RESOURCE_INTERVAL_MS } from '../../src/workspaces.js';
import type { ClientUpdateChannel, UpdateStatus } from './update-channel.js';

export type ClientOptions = {
  serverUrl: string;
  workspaceId: string;
  key: string;
  config: Config;
  services?: WorkspaceServices & { store?: AuthStore };
  turnOffDisplay?: (signal: AbortSignal) => Promise<void>;
  onStatus?: (status: 'connected' | 'disconnected', reason?: string) => void;
  reconnectMs?: number;
  updates?: ClientUpdateChannel;
};
type ActiveRequest = {
  abort: AbortController;
  ack?: () => void;
  body?: PassThrough;
  bodySize: number;
  received: number;
};
type Authorized = Extract<Frame, { type: 'authorized' }>['result'];

function handshakeRejection(status: number | undefined, serverProtocol: string | undefined) {
  if (
    serverProtocol &&
    /^\d{1,5}$/.test(serverProtocol) &&
    Number(serverProtocol) !== PROTOCOL_VERSION
  )
    return `HTTP ${status ?? 'unknown'}：协议版本不一致：Server ${Number(serverProtocol)}，Client ${PROTOCOL_VERSION}；请更新两端源码、重新构建并重启`;
  const hints: Record<number, string> = {
    401: '工作空间认证失败；请核对工作空间 ID、AES 密钥、两端协议版本和系统时间（允许偏差 60 秒）',
    403: '连接来源被拒绝；请检查 Server 的 MONITOR_ORIGINS 和代理访问规则',
    404: '找不到 Client 连接接口；请检查 Server 地址、版本和代理转发路径',
    409: '该工作空间已有 Client 在线；请停止重复进程，或为另一台机器创建独立工作空间',
  };
  return `HTTP ${status ?? 'unknown'}：${hints[status ?? 0] ?? 'WebSocket 握手被拒绝；请检查 Server 和代理的 WebSocket Upgrade 配置'}`;
}

export class MonitorClient {
  private socket?: WebSocket;
  private ready = false;
  private updateReporting = false;
  private longCompletionReplies = false;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private resourceTimer?: ReturnType<typeof setInterval>;
  private readonly privacyWork: PrivacyWork;
  private delay: number;
  private requests = new Map<string, ActiveRequest>();
  private helpReads = 0;
  private rpc = new Map<
    string,
    {
      resolve: (result: Authorized) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private runtime!: Awaited<ReturnType<typeof createClientRuntime>>;
  private reporter!: NotificationReporter;
  private notificationConfiguration = Promise.resolve();
  private notificationReports = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: (accepted: boolean) => void;
      reject: (error: Error) => void;
    }
  >();
  private url: URL;
  private constructor(private options: ClientOptions) {
    this.url = clientConnectionUrl(options);
    this.delay = options.reconnectMs ?? 1000;
    this.privacyWork = new PrivacyWork(options.turnOffDisplay);
    if (options.updates) options.updates.onStatus = (status) => this.reportUpdate(status);
  }

  private reportUpdate(status: UpdateStatus) {
    const socket = this.socket;
    if (socket && this.ready && this.updateReporting && !this.stopped)
      void sendFrame(socket, { type: 'client-update-status', ...status }).catch(() => socket.terminate());
  }
  static async start(options: ClientOptions) {
    const client = new MonitorClient(options);
    client.runtime = await createClientRuntime(options.config, {
      ...options.services,
      authorization: {
        device: async (identity) => {
          const result = await client.authorize({ grantId: identity.sessionId });
          return (
            !!result &&
            typeof result === 'object' &&
            result.user.id === identity.user.id &&
            result.user.role === 'admin'
          );
        },
        user: async (userId) => {
          const result = await client.authorize({ userId });
          if (!options.services?.store)
            client.runtime.access.db
              .prepare('UPDATE users SET role=? WHERE id=?')
              .run(result === true ? 'admin' : 'viewer', userId);
          return result === true;
        },
      },
    });
    client.reporter = new NotificationReporter(
      client.runtime.access.db,
      client.runtime.source,
      options.config.pollMs,
      (report) => client.reportNotifications(report),
    );
    client.connect();
    return client;
  }
  get connected() {
    return this.ready;
  }
  get source() {
    return this.runtime.source;
  }
  get notifications() {
    return this.reporter;
  }
  private reportNotifications(report: NotificationReport): Promise<boolean> {
    if (!this.ready || !this.socket)
      return Promise.reject(new Error('Notification server disconnected'));
    if (!this.longCompletionReplies) {
      const shorten = <T extends NotificationReport['events'][number]>(event: T): T =>
        event.kind === 'session.completed'
          ? {
              ...event,
              summary: limitMarkdown(
                event.summary,
                (reply) => reply.length <= LEGACY_COMPLETION_SUMMARY_LIMIT,
              ),
            }
          : event;
      report = {
        ...report,
        events: report.events.map(shorten),
        ...(report.completions && { completions: report.completions.map(shorten) }),
      };
    }
    const socket = this.socket,
      id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.notificationReports.delete(id);
        reject(new Error('Notification acknowledgement timed out'));
      }, 5000);
      this.notificationReports.set(id, { timer, resolve, reject });
      void sendFrame(socket, { type: 'notification-report', id, report }).catch((error) => {
        clearTimeout(timer);
        this.notificationReports.delete(id);
        reject(error);
      });
    });
  }
  private connect() {
    if (this.stopped) return;
    const proof = connectionProof(this.options.key, this.options.workspaceId);
    const socket = new WebSocket(this.url, {
      headers: { Authorization: proof },
      maxPayload: MAX_FRAME,
      perMessageDeflate: false,
      handshakeTimeout: 10000,
    });
    this.socket = socket;
    let alive = true;
    let encrypted = false;
    let failure = '';
    const safeDetail = (value: string) =>
      value
        .replaceAll(this.options.key, '[redacted]')
        .replaceAll(proof, '[redacted]')
        .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
        .slice(0, 500);
    const handshake = setTimeout(() => {
      if (!this.ready) {
        failure ||= '加密握手超时（15 秒）；请检查两端版本和 Server 日志';
        socket.terminate();
      }
    }, 15000);
    handshake.unref();
    socket.on('open', () => {
      this.heartbeat = setInterval(() => {
        if (!alive) {
          failure ||= '心跳超时；Server 未响应，请检查网络和代理连接超时设置';
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 15000);
      this.heartbeat.unref();
    });
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('Text frames required');
        if (!encrypted) {
          const channel = JSON.parse(raw.toString());
          if (
            channel?.type === 'channel' &&
            typeof channel.version === 'number' &&
            channel.version !== PROTOCOL_VERSION
          ) {
            failure = `协议版本不一致：Server ${channel.version}，Client ${PROTOCOL_VERSION}；请更新两端源码、重新构建并重启`;
            socket.close(1008, 'Unsupported protocol');
            return;
          }
          startClientChannel(socket, this.options.key, raw.toString(), proof);
          encrypted = true;
          void sendFrame(socket, {
            type: 'hello',
            capabilities: {
              completionNotifications: true,
              notificationAttachments: true,
              notificationMarkRead: true,
              notificationReplies: true,
              notificationReplyFiles: true,
              notificationReplyStatus: true,
              notificationReplyErrors: true,
              notificationStarts: true,
              notificationNamedStarts: true,
              larkHelp: true,
              privacyWork: process.platform === 'win32',
              clientUpdate: this.options.updates ? true : undefined,
            },
            version: PROTOCOL_VERSION,
            hostname: os.hostname(),
            platform: process.platform,
            buildCommitAt: buildCommitAt ?? undefined,
          }).catch(() => socket.terminate());
          return;
        }
        const frame = readFrame(socket, raw);
        if (frame.type === 'welcome') {
          if (this.ready || frame.workspaceId !== this.options.workspaceId)
            throw new Error('Invalid welcome');
          clearTimeout(handshake);
          this.longCompletionReplies = !!frame.capabilities?.longCompletionReplies;
          this.ready = true;
          this.updateReporting = !!frame.capabilities?.clientUpdate;
          if (this.options.updates?.status) this.reportUpdate(this.options.updates.status);
          this.delay = this.options.reconnectMs ?? 1000;
          if (frame.capabilities?.hostResources)
            this.startResourceReporting(
              socket,
              process.platform === 'win32' && !!frame.capabilities.hostUptime,
            );
          this.privacyWork.setEnabled(process.platform === 'win32' && !!frame.privacyWorkEnabled);
          this.options.onStatus?.('connected');
        } else if (!this.ready) throw new Error('Handshake required');
        else if (frame.type === 'client-update' && this.updateReporting && this.options.updates) {
          this.options.updates.start(frame.id);
        } else if (frame.type === 'privacy-work') {
          this.privacyWork.setEnabled(process.platform === 'win32' && frame.enabled, {
            runImmediately: true,
          });
        } else if (frame.type === 'notification-mark-read') {
          void this.runtime.markSessionRead(frame.sessionId).catch(() => {});
        } else if (frame.type === 'notification-policy') {
          this.notificationConfiguration = this.notificationConfiguration
            .then(async () => {
              if (socket !== this.socket || !this.ready || this.stopped) return;
              await this.reporter.configure(frame.policy, frame.baseline);
              await sendFrame(socket, {
                type: 'notification-policy-ack',
                revision: frame.policy.revision,
              });
              void this.reporter.poll();
            })
            .catch(() => socket.terminate());
        } else if (frame.type === 'notification-report-ack') {
          const pending = this.notificationReports.get(frame.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.notificationReports.delete(frame.id);
            pending.resolve(frame.accepted);
          }
        } else if (frame.type === 'authorized') {
          const rpc = this.rpc.get(frame.id);
          if (rpc) {
            clearTimeout(rpc.timer);
            this.rpc.delete(frame.id);
            rpc.resolve(frame.result);
          }
        } else if (frame.type === 'lark-help-read') {
          const respond = (snapshot?: Extract<Frame, { type: 'lark-help-result' }>['snapshot']) =>
            sendFrame(socket, { type: 'lark-help-result', id: frame.id, snapshot }).catch(() => {});
          if (this.helpReads >= 2) {
            void respond();
          } else {
            this.helpReads++;
            void this.runtime.larkHelpSnapshot(frame.details).catch(() => undefined)
              .then(respond).finally(() => this.helpReads--);
          }
        } else if (frame.type === 'notification-reply-status') {
          const { result, error } = this.runtime.larkReplyStatus(frame.userId, frame.requestId);
          void sendFrame(socket, { type: 'notification-reply-result', id: frame.id, result,
            ...(frame.includeError && error && { error }) })
            .catch(() => socket.terminate());
        } else if (
          frame.type === 'request' ||
          frame.type === 'notification-attachment' ||
          frame.type === 'notification-reply'
        ) {
          if (this.requests.has(frame.id)) throw new Error('Duplicate request');
          const bodySize = frame.type === 'request' ? frame.bodySize
            : frame.type === 'notification-reply'
              ? frame.attachments?.reduce((sum, file) => sum + file.size, 0)
                ?? frame.imageSizes?.reduce((sum, size) => sum + size, 0)
            : undefined;
          const upload = bodySize !== undefined;
          if (
            this.requests.size >= MAX_REQUESTS ||
            (frame.type === 'request' &&
              (!workspacePath(frame.method, frame.path) ||
              (upload && (frame.method !== 'POST' ||
                frame.path.split('?')[0] !== '/api/uploads' ||
                frame.body !== ''))))
          ) {
            void sendFrame(socket, {
              type: 'error',
              id: frame.id,
              message: '工作空间请求无效或数量过多',
            }).catch(() => {});
            return;
          }
          const active: ActiveRequest = {
            abort: new AbortController(),
            bodySize: bodySize ?? 0,
            received: 0,
            body: upload ? new PassThrough({ highWaterMark: CHUNK_BYTES }) : undefined,
          };
          active.abort.signal.addEventListener('abort', () => active.body?.destroy(), {
            once: true,
          });
          this.requests.set(frame.id, active);
          if (frame.type === 'notification-reply') void this.forwardLarkReply(socket, frame, active);
          else void this.forward(socket, frame, active);
        } else if (frame.type === 'body' || frame.type === 'body-end') {
          const active = this.requests.get(frame.id);
          if (!active || active.abort.signal.aborted) return;
          if (!active.body || active.body.writableEnded) throw new Error('Unexpected request body');
          if (frame.type === 'body-end') {
            if (active.received !== active.bodySize) throw new Error('Incomplete request body');
            active.body.end();
          } else {
            const chunk = Buffer.from(frame.data, 'base64');
            active.received += chunk.length;
            if (!chunk.length || chunk.length > CHUNK_BYTES || active.received > active.bodySize)
              throw new Error('Invalid request body size');
            const ack = () =>
              void sendFrame(socket, { type: 'body-ack', id: frame.id }).catch(() =>
                socket.terminate(),
              );
            if (active.body.write(chunk)) ack();
            else active.body.once('drain', ack);
          }
        } else if (frame.type === 'ack') {
          const active = this.requests.get(frame.id);
          active?.ack?.();
        } else if (frame.type === 'cancel') {
          this.requests.get(frame.id)?.abort.abort();
        } else throw new Error('Unexpected frame');
      } catch {
        failure ||= encrypted
          ? '加密通道数据无效；请核对两端版本和 AES 密钥'
          : '加密握手失败；请核对两端协议版本和 AES 密钥';
        socket.close(1008, 'Invalid protocol');
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      const serverProtocol = response.headers['x-codex-monitor-protocol'];
      failure = handshakeRejection(
        response.statusCode,
        typeof serverProtocol === 'string' ? serverProtocol : undefined,
      );
      response.resume();
      socket.terminate();
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      failure ||= safeDetail(`${error.code ? error.code + ': ' : ''}${error.message}`);
    });
    socket.on('close', (code, reason) => {
      clearTimeout(handshake);
      clearInterval(this.heartbeat);
      clearInterval(this.resourceTimer);
      this.privacyWork.setEnabled(false);
      this.ready = false;
      this.runtime.access.clear();
      this.runtime.terminals.closeAll();
      for (const active of this.requests.values()) active.abort.abort();
      for (const rpc of this.rpc.values()) {
        clearTimeout(rpc.timer);
        rpc.reject(new ControlError('工作空间连接已中断，请稍后重试。', false, 503));
      }
      this.rpc.clear();
      for (const pending of this.notificationReports.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Notification server disconnected'));
      }
      this.notificationReports.clear();
      const detail = failure || safeDetail(reason.toString());
      this.options.onStatus?.('disconnected', `WebSocket ${code}${detail ? ': ' + detail : ''}`);
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 30000);
      }
    });
  }
  private startResourceReporting(socket: WebSocket, readUptime: boolean) {
    clearInterval(this.resourceTimer);
    const sampler = new HostResourceSampler();
    let sampling = false;
    let sending = false;
    const report = async () => {
      if (sampling || socket !== this.socket || !this.ready || this.stopped) return;
      sampling = true;
      try {
        const sample = await sampler.sample(Date.now(), readUptime);
        if (socket !== this.socket || !this.ready || this.stopped) return;
        // Keep sampling across congestion, but never queue up obsolete resource reports.
        if (sending || socket.bufferedAmount > CHUNK_BYTES) return;
        sending = true;
        void sendFrame(socket, { type: 'host-resources', sample })
          .catch(() => {})
          .finally(() => {
            sending = false;
          });
      } finally {
        sampling = false;
      }
    };
    void report();
    this.resourceTimer = setInterval(report, HOST_RESOURCE_INTERVAL_MS);
    this.resourceTimer.unref();
  }
  private async forwardLarkReply(
    socket: WebSocket,
    frame: Extract<Frame, { type: 'notification-reply' }>,
    active: ActiveRequest,
  ) {
    const signal = active.abort.signal;
    try {
      const attachments: LarkReplyAttachment[] = [];
      if (active.body) {
        const data = Buffer.allocUnsafe(active.bodySize);
        let received = 0;
        for await (const chunk of active.body as AsyncIterable<Buffer>) {
          chunk.copy(data, received);
          received += chunk.length;
        }
        if (received !== data.length) throw new Error('Incomplete Lark reply attachments');
        let offset = 0;
        const files = frame.attachments ?? frame.imageSizes!.map((size) => ({ size, name: undefined }));
        for (const { size, name } of files) {
          attachments.push({ data: data.subarray(offset, offset + size), name });
          offset += size;
        }
      }
      signal.throwIfAborted();
      this.runtime.access.syncUser(frame.user);
      const { error, ...receipt } = frame.sessionId
        ? await this.runtime.sendLarkReply(frame.user.id, frame.sessionId, frame, attachments, signal)
        : await this.runtime.startLarkSession(
            frame.user,
            frame.projectId ? { projectId: frame.projectId } : { projectName: frame.projectName! },
            frame, attachments, signal,
          );
      await sendFrame(socket, { type: 'notification-reply-result', id: frame.id, ...receipt,
        ...(frame.includeError && error && { error }) });
    } catch {
      if (!signal.aborted) await sendFrame(socket, {
        type: 'notification-reply-result', id: frame.id, result: 'unknown',
      }).catch(() => {});
    } finally {
      this.requests.delete(frame.id);
    }
  }

  private authorize(input: { grantId?: string; userId?: string }): Promise<Authorized> {
    if (!this.ready || !this.socket)
      return Promise.reject(new ControlError('工作空间离线，等待重新连接。', false, 503));
    const socket = this.socket,
      id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpc.delete(id);
        reject(new ControlError('Server 权限复核超时。', false, 503));
      }, 5000);
      this.rpc.set(id, { resolve, reject, timer });
      void sendFrame(socket, { type: 'authorize', id, ...input }).catch((error) => {
        clearTimeout(timer);
        this.rpc.delete(id);
        reject(error);
      });
    });
  }
  private async forward(
    socket: WebSocket,
    frame: Extract<Frame, { type: 'request' | 'notification-attachment' }>,
    active: ActiveRequest,
  ) {
    let lease: { token: string; close: () => unknown } | undefined;
    const signal = active.abort.signal;
    try {
      let response: Response;
      if (frame.type === 'notification-attachment') {
        const file = await this.runtime.notificationAttachments.read(frame, signal);
        response = file && file !== 'unavailable'
          ? new Response(new Uint8Array(file.data), {
              headers: { 'content-type': file.mime, 'x-attachment-name': encodeURIComponent(file.name) },
            })
          : new Response(null, { status: file === 'unavailable' ? 422 : 404 });
      } else {
        const result = await this.authorize({ grantId: frame.grantId });
        if (signal.aborted) return;
        if (!result || typeof result !== 'object') {
          await sendFrame(socket, { type: 'response', id: frame.id, status: 401, headers: {} });
          await sendFrame(socket, { type: 'end', id: frame.id });
          return;
        }
        lease = this.runtime.access.open(result as Identity);
        const headers: Record<string, string> = { Authorization: `Bearer ${lease.token}` };
        for (const name of ['content-type', 'x-upload-type'])
          if (frame.headers[name]) headers[name] = frame.headers[name];
        response = await fetch(this.runtime.url + frame.path, {
          method: frame.method,
          headers,
          body: active.body
            ? (Readable.toWeb(active.body) as ReadableStream<Uint8Array>)
            : frame.method === 'GET'
              ? undefined
              : Buffer.from(frame.body, 'base64'),
          ...(active.body ? { duplex: 'half' } : {}),
          signal,
          redirect: 'error',
        });
      }
      const responseHeaders: Record<string, string> = {};
      for (const name of ['content-type', 'content-disposition', 'retry-after'])
        if (response.headers.has(name)) responseHeaders[name] = response.headers.get(name)!;
      if (frame.type === 'notification-attachment' && response.headers.has('x-attachment-name'))
        responseHeaders['x-attachment-name'] = response.headers.get('x-attachment-name')!;
      await sendFrame(socket, {
        type: 'response',
        id: frame.id,
        status: response.status,
        headers: responseHeaders,
      });
      const reader = response.body?.getReader();
      try {
        if (reader)
          for (;;) {
            const { value: raw, done } = await reader.read();
            if (done) break;
            const buffer = Buffer.from(raw);
            for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
              if (signal.aborted) return;
              // One unacknowledged chunk per response bounds buffering on slow browsers.
              await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                  done();
                  reject(new Error('Browser response timed out'));
                }, 120000);
                const abort = () => {
                  done();
                  reject(new Error('Request canceled'));
                };
                const done = () => {
                  clearTimeout(timeout);
                  signal.removeEventListener('abort', abort);
                  active.ack = undefined;
                };
                active.ack = () => {
                  done();
                  resolve();
                };
                signal.addEventListener('abort', abort, { once: true });
                void sendFrame(socket, {
                  type: 'data',
                  id: frame.id,
                  data: buffer.subarray(offset, offset + CHUNK_BYTES).toString('base64'),
                }).catch((error) => {
                  done();
                  reject(error);
                });
              });
            }
          }
      } finally {
        reader?.releaseLock();
      }
      await sendFrame(socket, { type: 'end', id: frame.id });
    } catch {
      if (!signal.aborted)
        await sendFrame(socket, {
          type: 'error',
          id: frame.id,
          message: 'Client 请求失败；若已提交操作，请查询原请求回执。',
        }).catch(() => {});
    } finally {
      active.abort.abort();
      lease?.close();
      if (this.requests.get(frame.id) === active) this.requests.delete(frame.id);
    }
  }
  /** Disconnecting never replays an HTTP request. Persistent receipt IDs handle recovery. */
  reconnect() {
    this.socket?.terminate();
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.resourceTimer);
    this.privacyWork.setEnabled(false);
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.terminate();
      });
    }
    await this.notificationConfiguration;
    await this.reporter.close();
    await this.runtime.close();
  }
}
