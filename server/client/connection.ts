import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { WebSocket } from 'ws';
import type { AuthStore } from '../auth.js';
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
import type { NotificationReport } from '../notifications/events.js';

export type ClientOptions = {
  serverUrl: string;
  workspaceId: string;
  key: string;
  config: Config;
  services?: WorkspaceServices & { store?: AuthStore };
  onStatus?: (status: 'connected' | 'disconnected', reason?: string) => void;
  reconnectMs?: number;
};
type ActiveRequest = {
  abort: AbortController;
  ack?: () => void;
  body?: PassThrough;
  bodySize: number;
  received: number;
};
type Authorized = Extract<Frame, { type: 'authorized' }>['result'];

export class MonitorClient {
  private socket?: WebSocket;
  private ready = false;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private delay: number;
  private requests = new Map<string, ActiveRequest>();
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
    const handshake = setTimeout(() => {
      if (!this.ready) socket.terminate();
    }, 15000);
    handshake.unref();
    socket.on('open', () => {
      this.heartbeat = setInterval(() => {
        if (!alive) {
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
          startClientChannel(socket, this.options.key, raw.toString(), proof);
          encrypted = true;
          void sendFrame(socket, {
            type: 'hello',
            version: PROTOCOL_VERSION,
            hostname: os.hostname(),
            platform: process.platform,
          }).catch(() => socket.terminate());
          return;
        }
        const frame = readFrame(socket, raw);
        if (frame.type === 'welcome') {
          if (this.ready || frame.workspaceId !== this.options.workspaceId)
            throw new Error('Invalid welcome');
          clearTimeout(handshake);
          this.ready = true;
          this.delay = this.options.reconnectMs ?? 1000;
          this.options.onStatus?.('connected');
        } else if (!this.ready) throw new Error('Handshake required');
        else if (frame.type === 'notification-policy') {
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
        } else if (frame.type === 'request') {
          if (this.requests.has(frame.id)) throw new Error('Duplicate request');
          const upload = frame.bodySize !== undefined;
          if (
            this.requests.size >= MAX_REQUESTS ||
            !workspacePath(frame.method, frame.path) ||
            (upload &&
              (frame.method !== 'POST' ||
                frame.path.split('?')[0] !== '/api/uploads' ||
                frame.body !== ''))
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
            bodySize: frame.bodySize ?? 0,
            received: 0,
            body: upload ? new PassThrough({ highWaterMark: CHUNK_BYTES }) : undefined,
          };
          active.abort.signal.addEventListener('abort', () => active.body?.destroy(), {
            once: true,
          });
          this.requests.set(frame.id, active);
          void this.forward(socket, frame, active);
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
        socket.close(1008, 'Invalid protocol');
      }
    });
    socket.on('error', () => {});
    socket.on('close', (code) => {
      clearTimeout(handshake);
      clearInterval(this.heartbeat);
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
      this.options.onStatus?.('disconnected', `WebSocket ${code}`);
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 30000);
      }
    });
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
    frame: Extract<Frame, { type: 'request' }>,
    active: ActiveRequest,
  ) {
    let lease: { token: string; close: () => unknown } | undefined;
    const signal = active.abort.signal;
    try {
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
      const response = await fetch(this.runtime.url + frame.path, {
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
      const responseHeaders: Record<string, string> = {};
      for (const name of ['content-type', 'content-disposition', 'retry-after'])
        if (response.headers.has(name)) responseHeaders[name] = response.headers.get(name)!;
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
