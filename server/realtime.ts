import type { Express, Response } from 'express';
import type { WorkspaceAuth } from './http/access.js';
import { validId, type CodexSource } from './source.js';

type Client = {
  response: Response;
  token: string;
  threadId?: string;
  fingerprint: string;
  version: string;
  tick: number;
};

/** All viewers share one index read per tick and one version check per selected chat. */
export function installRealtime(
  app: Express,
  auth: WorkspaceAuth,
  source: CodexSource,
  pollMs: number,
) {
  const clients = new Set<Client>(),
    counts = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined,
    busy = false,
    closed = false;
  const send = (client: Client, event: string, data: unknown) => {
    const response = client.response;
    if (
      !response.destroyed &&
      !response.writableEnded &&
      !response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    )
      response.destroy();
  };
  const poll = async () => {
    if (busy || closed || !clients.size) return;
    busy = true;
    try {
      const authorized = [...clients].filter((client) => {
        if (auth.authenticate(client.token)) return true;
        send(client, 'unauthorized', {});
        client.response.end();
        return false;
      });
      if (!authorized.length) return;
      const overview = await source.overview();
      if (closed) return;
      const list = await source.list({ limit: 1, archived: 'all', sort: 'recent' });
      const fingerprint = `${overview.total}-${overview.running}-${list.sessions[0]?.updatedAt}`;
      const versions = new Map<string, string>();
      const failed = new Set<string>();
      for (const client of authorized) {
        if (closed) return;
        if (client.threadId && !versions.has(client.threadId) && !failed.has(client.threadId)) {
          try {
            versions.set(client.threadId, await source.version(client.threadId));
          } catch {
            failed.add(client.threadId);
          }
        }
      }
      if (closed) return;
      for (const client of authorized) {
        if (!clients.has(client)) continue;
        // A device may have been revoked while a slow source read was in flight.
        if (!auth.authenticate(client.token)) {
          send(client, 'unauthorized', {});
          client.response.end();
          continue;
        }
        const version = client.threadId ? versions.get(client.threadId) || '' : '';
        if (client.threadId && failed.has(client.threadId)) {
          send(client, 'source-error', { error: '此会话暂时不可读，正在重试' });
          continue;
        }
        const changed = fingerprint !== client.fingerprint || version !== client.version;
        client.fingerprint = fingerprint;
        client.version = version;
        if (changed)
          send(client, 'update', { sessionId: client.threadId, version, at: Date.now() });
        else if (++client.tick % 10 === 0) send(client, 'heartbeat', { at: Date.now() });
      }
    } catch {
      if (!closed)
        for (const client of clients)
          send(client, 'source-error', { error: '数据源暂时不可用，正在重试' });
    } finally {
      busy = false;
    }
  };
  app.get('/api/stream', (req, res) => {
    const id = typeof req.query.session === 'string' ? req.query.session : undefined;
    if (id && !validId(id)) return res.status(400).json({ error: '会话 ID 无效' });
    if (closed) return res.status(503).json({ error: '服务正在停止' });
    const sid = req.identity!.sessionId;
    if (clients.size >= 50 || (counts.get(sid) || 0) >= 5)
      return res.status(429).json({ error: '实时连接数量已达上限' });
    const client: Client = {
      response: res,
      token: req.token!,
      threadId: id,
      fingerprint: '',
      version: '',
      tick: 0,
    };
    clients.add(client);
    counts.set(sid, (counts.get(sid) || 0) + 1);
    res.on('close', () => {
      clients.delete(client);
      const remaining = (counts.get(sid) || 1) - 1;
      if (remaining) counts.set(sid, remaining);
      else counts.delete(sid);
      if (!clients.size) {
        clearInterval(timer);
        timer = undefined;
      }
    });
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    send(client, 'ready', { at: Date.now() });
    timer ??= setInterval(() => void poll(), pollMs);
    timer.unref();
  });
  return () => {
    closed = true;
    clearInterval(timer);
    for (const client of clients) client.response.end();
    clients.clear();
    counts.clear();
  };
}
