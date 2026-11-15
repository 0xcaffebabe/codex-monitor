import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Express, Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { AuthStore } from '../auth.js';
import { admin, fail } from '../http/access.js';
import {
  CHUNK_BYTES,
  MAX_BODY,
  MAX_FRAME,
  MAX_REQUESTS,
  PROTOCOL_VERSION,
  readFrame,
  sendFrame,
  startServerChannel,
  workspacePath,
  type Frame,
} from '../transport/protocol.js';
import { WorkspaceStore } from './store.js';
import type { NotificationService } from '../notifications/service.js';
import type { NotificationPolicy } from '../notifications/events.js';

type Pending = {
  res: Response;
  token: string;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
  waiting: boolean;
  stream: boolean;
  bodyAck?: { resolve: () => void; reject: (error: Error) => void };
  drainAck?: () => void;
};
type Peer = {
  workspaceId: string;
  socket: WebSocket;
  ready: boolean;
  alive: boolean;
  hostname: string;
  platform: string;
  pending: Map<string, Pending>;
  grants: Map<string, string>;
  notificationPolicies: Map<number, { timer: ReturnType<typeof setTimeout>; done: () => void }>;
};
const nameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

/** One authenticated, outbound client connection per registered workspace. */
export class WorkspaceGateway {
  readonly store: WorkspaceStore;
  private peers = new Map<string, Peer>();
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    perMessageDeflate: false,
  });
  private timer: ReturnType<typeof setInterval>;
  private authorizationTimer: ReturnType<typeof setInterval>;
  private uploadCount = 0;
  private userUploads = new Map<string, number>();
  private closed = false;
  constructor(
    private auth: AuthStore,
    private notifications: NotificationService,
  ) {
    this.store = new WorkspaceStore(auth.db);
    this.timer = setInterval(() => {
      for (const [id, peer] of this.peers) {
        if (!peer.alive) {
          peer.socket.terminate();
          continue;
        }
        peer.alive = false;
        peer.socket.ping();
        if (peer.ready) this.store.seen(id, peer.hostname, peer.platform);
      }
    }, 15000);
    this.timer.unref();
    this.authorizationTimer = setInterval(() => {
      for (const peer of this.peers.values())
        for (const [id, request] of peer.pending)
          if (!this.auth.authenticate(request.token)) this.unauthorized(peer, id, request);
    }, 1000);
    this.authorizationTimer.unref();
  }
  list() {
    return this.store
      .list()
      .map((workspace) => ({ ...workspace, online: !!this.peers.get(workspace.id)?.ready }));
  }
  disconnect(id: string) {
    const peer = this.peers.get(id);
    if (peer) {
      peer.ready = false;
      peer.socket.terminate();
    }
  }
  configureNotifications(policy: NotificationPolicy, baseline: boolean) {
    return Promise.allSettled(
      [...this.peers.values()]
        .filter((peer) => peer.ready)
        .map((peer) => this.sendNotificationPolicy(peer, policy, baseline)),
    ).then(() => {});
  }
  private sendNotificationPolicy(peer: Peer, policy: NotificationPolicy, baseline: boolean) {
    return new Promise<void>((resolve) => {
      peer.notificationPolicies.get(policy.revision)?.done();
      const done = () => {
        clearTimeout(timer);
        peer.notificationPolicies.delete(policy.revision);
        resolve();
      };
      const timer = setTimeout(done, 5000);
      peer.notificationPolicies.set(policy.revision, { timer, done });
      void sendFrame(peer.socket, { type: 'notification-policy', policy, baseline }).catch(() => {
        done();
        peer.socket.terminate();
      });
    });
  }
  attach(server: Server, allowed: (req: IncomingMessage) => boolean) {
    const upgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
      const reject = (status: number) => {
        socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (this.closed || !allowed(req)) return reject(403);
      let url: URL;
      try {
        url = new URL(req.url || '', 'http://localhost');
      } catch {
        return reject(400);
      }
      if (
        url.pathname !== '/api/clients/connect' ||
        [...url.searchParams.keys()].some((key) => key !== 'workspace')
      )
        return reject(404);
      const id = url.searchParams.get('workspace') || '';
      const header = req.headers.authorization || '';
      const key = this.store.authenticate(id, header);
      if (!key) return reject(401);
      if (this.peers.has(id)) return reject(409);
      this.wss.handleUpgrade(req, socket, head, (websocket) =>
        this.accept(id, websocket, key, header),
      );
    };
    server.on('upgrade', upgrade);
    return () => server.off('upgrade', upgrade);
  }
  private accept(id: string, socket: WebSocket, key: string, proof: string) {
    const peer: Peer = {
      workspaceId: id,
      socket,
      ready: false,
      alive: true,
      hostname: '',
      platform: '',
      pending: new Map(),
      grants: new Map(),
      notificationPolicies: new Map(),
    };
    this.peers.set(id, peer);
    const handshake = setTimeout(() => {
      if (!peer.ready) socket.terminate();
    }, 5000);
    handshake.unref();
    socket.on('pong', () => {
      peer.alive = true;
    });
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('Text frames required');
        const frame = readFrame(socket, raw);
        if (!peer.ready) {
          if (frame.type !== 'hello' || frame.version !== PROTOCOL_VERSION)
            throw new Error('Unsupported protocol');
          peer.ready = true;
          peer.hostname = frame.hostname;
          peer.platform = frame.platform;
          clearTimeout(handshake);
          this.store.seen(id, frame.hostname, frame.platform);
          void sendFrame(socket, {
            type: 'welcome',
            version: PROTOCOL_VERSION,
            workspaceId: id,
          })
            .then(() => this.sendNotificationPolicy(peer, this.notifications.policy(), false))
            .catch(() => socket.terminate());
          return;
        }
        this.receive(peer, frame);
      } catch {
        socket.close(1008, 'Invalid protocol');
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(handshake);
      if (this.peers.get(id) === peer) this.peers.delete(id);
      for (const [requestId, request] of peer.pending)
        this.finish(
          peer,
          requestId,
          request,
          503,
          '工作空间已离线；操作可能已提交，请重新连接后查询原请求回执。',
        );
      peer.grants.clear();
      for (const policy of peer.notificationPolicies.values()) policy.done();
    });
    startServerChannel(socket, key, proof);
  }
  private receive(peer: Peer, frame: Frame) {
    if (frame.type === 'notification-policy-ack') {
      peer.notificationPolicies.get(frame.revision)?.done();
      return;
    }
    if (frame.type === 'notification-report') {
      const workspace = this.store.get(peer.workspaceId);
      if (!workspace || this.peers.get(peer.workspaceId) !== peer || !peer.ready)
        throw new Error('Workspace registration revoked');
      const accepted = this.notifications.receive(workspace, frame.report);
      void sendFrame(peer.socket, { type: 'notification-report-ack', id: frame.id, accepted })
        .then(() =>
          accepted
            ? undefined
            : this.sendNotificationPolicy(peer, this.notifications.policy(), false),
        )
        .catch(() => peer.socket.terminate());
      return;
    }
    if (frame.type === 'authorize') {
      const token = frame.grantId ? peer.grants.get(frame.grantId) : undefined;
      const result = frame.grantId
        ? token
          ? this.auth.authenticate(token)
          : null
        : !!(
            frame.userId &&
            this.auth.db
              .prepare("SELECT 1 FROM users WHERE id=? AND role='admin'")
              .get(frame.userId)
          );
      void sendFrame(peer.socket, { type: 'authorized', id: frame.id, result }).catch(() =>
        peer.socket.terminate(),
      );
      return;
    }
    if (!['response', 'data', 'end', 'error', 'body-ack'].includes(frame.type))
      throw new Error('Unexpected message');
    if (!('id' in frame)) return;
    const request = peer.pending.get(frame.id);
    if (!request) return; // A canceled browser may still have one chunk in flight.
    if (!this.auth.authenticate(request.token)) return this.unauthorized(peer, frame.id, request);
    const { res } = request;
    if (frame.type === 'body-ack') {
      if (!request.bodyAck) throw new Error('Unexpected body acknowledgement');
      const ack = request.bodyAck;
      request.bodyAck = undefined;
      request.timer.refresh();
      ack.resolve();
    } else if (frame.type === 'response') {
      if (request.started) throw new Error('Duplicate response');
      request.started = true;
      res.status(frame.status);
      for (const name of ['content-type', 'content-disposition', 'retry-after'])
        if (frame.headers[name]) res.setHeader(name, frame.headers[name]);
      if (request.stream) res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    } else if (frame.type === 'data') {
      if (!request.started || request.waiting) throw new Error('Invalid chunk sequence');
      const buffer = Buffer.from(frame.data, 'base64');
      if (buffer.length > CHUNK_BYTES) throw new Error('Chunk too large');
      request.waiting = true;
      const ack = () => {
        request.waiting = false;
        if (peer.pending.has(frame.id))
          void sendFrame(peer.socket, { type: 'ack', id: frame.id }).catch(() =>
            peer.socket.terminate(),
          );
      };
      if (res.write(buffer)) ack();
      else request.drainAck = ack;
      request.timer.refresh();
    } else if (frame.type === 'end') {
      this.finish(peer, frame.id, request);
    } else if (frame.type === 'error') {
      this.finish(peer, frame.id, request, 502, frame.message);
    }
  }
  private unauthorized(peer: Peer, id: string, request: Pending) {
    if (request.stream && request.started) request.res.write('event: unauthorized\ndata: {}\n\n');
    this.finish(peer, id, request, 401, '登录已过期，请重新登录');
    void sendFrame(peer.socket, { type: 'cancel', id }).catch(() => {});
  }
  private finish(peer: Peer, id: string, request: Pending, status?: number, error?: string) {
    if (peer.pending.get(id) !== request) return;
    clearTimeout(request.timer);
    peer.pending.delete(id);
    request.bodyAck?.reject(new Error('Request finished'));
    request.bodyAck = undefined;
    request.drainAck = undefined;
    if (request.res.destroyed) return;
    if (status && !request.res.headersSent) fail(request.res, status, error!);
    else if (status && !request.stream) request.res.destroy();
    else request.res.end();
  }
  install(app: Express) {
    app.get('/api/workspaces', (_req, res) => res.json({ workspaces: this.list() }));
    app.post('/api/workspaces', admin, (req, res) => {
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) return fail(res, 400, '请输入 1–80 字符的工作空间名称');
      try {
        res.status(201).json(this.store.create(parsed.data.name));
      } catch (error) {
        fail(res, 409, (error as Error).message);
      }
    });
    app.patch('/api/workspaces/:workspace', admin, (req, res) => {
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) return fail(res, 400, '工作空间名称无效');
      if (!this.store.rename(String(req.params.workspace), parsed.data.name))
        return fail(res, 404, '找不到工作空间');
      res.json({ ok: true });
    });
    app.post('/api/workspaces/:workspace/rotate-key', admin, (req, res) => {
      const id = String(req.params.workspace);
      if (id === 'local') return fail(res, 409, '本机工作空间密钥由一体启动配置管理');
      const key = this.store.rotate(id);
      if (!key) return fail(res, 404, '找不到工作空间');
      this.disconnect(id);
      res.json({ key });
    });
    app.delete('/api/workspaces/:workspace', admin, (req, res) => {
      const id = String(req.params.workspace);
      if (id === 'local') return fail(res, 409, '本机工作空间由一体启动配置管理');
      if (!this.store.remove(id)) return fail(res, 404, '找不到工作空间');
      this.notifications.forgetWorkspace(id);
      this.disconnect(id);
      res.status(204).end();
    });
    app.use('/api/workspaces/:workspace', (req, res) => {
      void this.proxy(req, res);
    });
  }
  private async proxy(req: Request, res: Response) {
    const id = String(req.params.workspace),
      peer = this.peers.get(id);
    if (!this.store.get(id)) return fail(res, 404, '找不到工作空间');
    if (!peer?.ready) return fail(res, 503, '工作空间已离线，等待 client 重新连接');
    const route = '/api' + req.url;
    if (!workspacePath(req.method, route)) return fail(res, 404, '工作空间接口不存在');
    if (
      req.identity!.user.role !== 'admin' &&
      (req.method !== 'GET' || /^\/api\/(?:control|uploads)(?:[/?]|$)/.test(route))
    )
      return fail(res, 403, '此操作需要管理员权限');
    if (peer.pending.size >= MAX_REQUESTS) return fail(res, 429, '工作空间请求过多，请稍后重试');
    const upload = req.method === 'POST' && route.split('?')[0] === '/api/uploads';
    const binary = !!req.is('application/octet-stream');
    if (binary && !upload) return fail(res, 415, '二进制内容仅支持附件上传');
    const userId = req.identity!.user.id;
    if (upload && (this.uploadCount >= 4 || (this.userUploads.get(userId) || 0) >= 2))
      return fail(res, 429, '同时上传的附件过多');
    if (upload) {
      this.uploadCount++;
      this.userUploads.set(userId, (this.userUploads.get(userId) || 0) + 1);
      // Capacity covers buffering, tunnel delivery and the client's response.
      res.once('close', () => {
        this.uploadCount--;
        const count = (this.userUploads.get(userId) || 1) - 1;
        if (count) this.userUploads.set(userId, count);
        else this.userUploads.delete(userId);
      });
    }
    try {
      let body = Buffer.alloc(0);
      if (binary) {
        const chunks: Buffer[] = [];
        let size = 0;
        if (Number(req.headers['content-length']) > MAX_BODY)
          return fail(res, 413, '单个附件不能超过 20 MB');
        req.setTimeout(120000, () => req.destroy());
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) return fail(res, 413, '单个附件不能超过 20 MB');
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      } else if (req.body !== undefined) body = Buffer.from(JSON.stringify(req.body));
      if (!this.auth.authenticate(req.token!)) return fail(res, 401, '登录已过期，请重新登录');
      if (res.destroyed || this.peers.get(id) !== peer || !peer.ready)
        return fail(res, 503, '工作空间连接已中断');
      if (peer.pending.size >= MAX_REQUESTS) return fail(res, 429, '工作空间请求过多，请稍后重试');
      const requestId = randomUUID();
      const request: Pending = {
        res,
        token: req.token!,
        started: false,
        waiting: false,
        stream: route.split('?')[0] === '/api/stream',
        timer: setTimeout(() => {
          this.finish(peer, requestId, request, 504, '工作空间响应超时，请查询原操作回执');
          void sendFrame(peer.socket, { type: 'cancel', id: requestId }).catch(() => {});
        }, 120000),
      };
      request.timer.unref();
      peer.pending.set(requestId, request);
      // compression forwards drain listeners to Gzip; res.once cannot remove them there.
      // One listener per response also prevents repeated chunks retaining old callbacks.
      res.on('drain', () => {
        const ack = request.drainAck;
        request.drainAck = undefined;
        ack?.();
      });
      // The client receives an opaque device ID; browser bearer credentials stay here.
      if (peer.grants.size >= 500 && !peer.grants.has(req.identity!.sessionId)) {
        for (const [key, token] of peer.grants)
          if (!this.auth.authenticate(token)) peer.grants.delete(key);
        if (peer.grants.size >= 500)
          return this.finish(peer, requestId, request, 429, '连接设备过多');
      }
      peer.grants.set(req.identity!.sessionId, req.token!);
      res.on('close', () => {
        if (!peer.pending.has(requestId)) return;
        this.finish(peer, requestId, request);
        void sendFrame(peer.socket, { type: 'cancel', id: requestId }).catch(() => {});
      });
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'x-upload-type'])
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      try {
        await sendFrame(peer.socket, {
          type: 'request',
          id: requestId,
          grantId: req.identity!.sessionId,
          method: req.method as 'GET',
          path: route,
          headers,
          body: binary ? '' : body.toString('base64'),
          ...(binary ? { bodySize: body.length } : {}),
        });
        if (binary) {
          for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
            if (!peer.pending.has(requestId)) return;
            await new Promise<void>((resolve, reject) => {
              request.bodyAck = { resolve, reject };
              void sendFrame(peer.socket, {
                type: 'body',
                id: requestId,
                data: body.subarray(offset, offset + CHUNK_BYTES).toString('base64'),
              }).catch(reject);
            });
          }
          if (peer.pending.has(requestId))
            await sendFrame(peer.socket, { type: 'body-end', id: requestId });
        }
      } catch {
        this.finish(peer, requestId, request, 503, '工作空间连接已中断，请查询原操作回执');
      }
    } catch {
      if (!res.headersSent && !res.destroyed)
        fail(res, 400, '请求传输失败，请重新连接后查询原操作回执');
    }
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.authorizationTimer);
    for (const peer of this.peers.values()) {
      for (const policy of peer.notificationPolicies.values()) policy.done();
      peer.socket.terminate();
    }
    this.wss.close();
  }
}
