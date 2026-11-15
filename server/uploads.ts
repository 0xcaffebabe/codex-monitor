import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ControlError } from './control-error.js';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_ACTIVE_UPLOADS = 4;
export type Attachment = { id: string; name: string; size: number; type: string };

function safeName(value: string) {
  const name = path
    .basename(value.replaceAll('\\', '/'))
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 160);
  return !name || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
    ? `file-${name || 'upload'}`
    : name;
}

/** Files are private local inputs for Codex, never exposed by the static server. */
export class UploadStore {
  readonly directory: string;
  private active = new Map<string, number>();
  private activeCount = 0;
  private closed = false;
  private streams = new Set<Transform>();
  constructor(
    private db: DatabaseSync,
    dataDir: string,
  ) {
    const key = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16);
    this.directory = path.join(os.tmpdir(), `codex-monitor-uploads-${key}`);
    db.exec(`CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      filename TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL,
      request_id TEXT, created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS uploads_user ON uploads(user_id);`);
  }

  async receive(req: Request, userId: string, originalName: string): Promise<Attachment> {
    if (this.closed) throw new ControlError('服务正在停止，请稍后重新上传。', false, 503);
    const declaredSize = Number(req.headers['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES)
      throw new ControlError('单个附件不能超过 20 MB。', false, 413);
    if (this.activeCount >= MAX_ACTIVE_UPLOADS || (this.active.get(userId) || 0) >= 2)
      throw new ControlError('同时上传的附件过多，请等待当前上传完成。', false, 429);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID(),
      name = safeName(originalName),
      filename = `${id}-${name}`;
    const file = path.join(this.directory, filename);
    const type = String(req.headers['x-upload-type'] || 'application/octet-stream').slice(0, 120);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(
          size > MAX_UPLOAD_BYTES ? new ControlError('单个附件不能超过 20 MB。', false, 413) : null,
          chunk,
        );
      },
    });
    this.activeCount++;
    this.streams.add(limit);
    this.active.set(userId, (this.active.get(userId) || 0) + 1);
    const timeout = setTimeout(
      () => limit.destroy(new ControlError('附件上传超时，请重新上传。', false, 408)),
      120000,
    );
    timeout.unref();
    try {
      // Keep the request socket open so an over-limit stream can receive a JSON error.
      req.pipe(limit);
      const abort = () => limit.destroy(new Error('Upload aborted'));
      req.once('aborted', abort);
      try {
        await pipeline(limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      } finally {
        req.removeListener('aborted', abort);
        req.unpipe(limit);
      }
      if (this.closed) throw new ControlError('服务正在停止，请稍后重新上传。', false, 503);
      this.db
        .prepare('INSERT INTO uploads VALUES(?,?,?,?,?,?,NULL,?)')
        .run(id, userId, name, filename, size, type, Date.now());
      return { id, name, size, type };
    } catch (error) {
      try {
        unlinkSync(file);
      } catch {}
      throw error;
    } finally {
      clearTimeout(timeout);
      this.streams.delete(limit);
      this.activeCount--;
      const remaining = (this.active.get(userId) || 1) - 1;
      if (remaining) this.active.set(userId, remaining);
      else this.active.delete(userId);
    }
  }

  close() {
    this.closed = true;
    for (const stream of this.streams)
      stream.destroy(new ControlError('服务正在停止，请稍后重新上传。', false, 503));
  }

  private row(userId: string, id: string) {
    const row = this.db.prepare('SELECT * FROM uploads WHERE id=? AND user_id=?').get(id, userId);
    if (!row) throw new ControlError('附件不存在或不属于当前账户，请重新上传。', false, 400);
    return row;
  }

  private inUse(requestId: unknown) {
    if (!requestId) return false;
    const row = this.db
      .prepare('SELECT state FROM control_requests WHERE id=?')
      .get(String(requestId));
    return !!row && !['failed', 'cancelled'].includes(String(row.state));
  }

  file(userId: string, id: string) {
    const row = this.row(userId, id);
    const file = path.join(this.directory, String(row.filename));
    try {
      const relative = path.relative(realpathSync(this.directory), realpathSync(file));
      if (
        !relative ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !statSync(file).isFile()
      )
        throw new Error('Invalid upload path');
    } catch {
      throw new ControlError(`附件“${row.name}”已失效，请移除后重新上传。`, false, 400);
    }
    return { path: file, name: String(row.name) };
  }

  compose(userId: string, requestId: string, prompt: string, ids: string[] = []) {
    if (!ids.length) return prompt;
    const rows = ids.map((id) => this.row(userId, id));
    for (const row of rows) {
      if (row.request_id !== requestId && this.inUse(row.request_id))
        throw new ControlError('附件已用于另一条消息，请重新上传。', false, 409);
      // Repeated receipt queries must work even if the system has since removed a temp file.
      if (row.request_id === requestId && this.inUse(requestId)) continue;
      this.file(userId, String(row.id));
    }
    const bind = this.db.prepare('UPDATE uploads SET request_id=? WHERE id=? AND user_id=?');
    for (const row of rows) bind.run(requestId, row.id!, userId);
    const files = rows.map((row) => path.join(this.directory, String(row.filename)));
    return `${prompt.trim()}${prompt.trim() ? '\n\n' : ''}附件（已上传到本机临时目录）：\n${files.map((file) => `- ${file}`).join('\n')}`;
  }

  remove(userId: string, id: string) {
    const row = this.row(userId, id);
    if (this.inUse(row.request_id))
      throw new ControlError('附件已随消息提交，不能移除。', false, 409);
    try {
      unlinkSync(path.join(this.directory, String(row.filename)));
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.db.prepare('DELETE FROM uploads WHERE id=? AND user_id=?').run(id, userId);
  }
}

export function installUploads(app: Express, uploads: UploadStore) {
  const admin = (req: Request, res: Response, next: NextFunction) =>
    req.identity?.user.role === 'admin'
      ? next()
      : res.status(403).json({ error: '上传附件需要管理员权限' });
  const name = z.object({ name: z.string().min(1).max(500) }).strict();
  app.post('/api/uploads', admin, async (req, res) => {
    const parsed = name.safeParse(req.query);
    if (!parsed.success || !req.is('application/octet-stream'))
      return res.status(400).json({ error: '请提供文件名和有效的附件内容。' });
    try {
      res.status(201).json(await uploads.receive(req, req.identity!.user.id, parsed.data.name));
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  app.delete('/api/uploads/:id', admin, (req, res) => {
    try {
      uploads.remove(req.identity!.user.id, String(req.params.id));
      res.status(204).end();
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  app.get('/api/uploads/:id', admin, (req, res) => {
    try {
      const file = uploads.file(req.identity!.user.id, String(req.params.id));
      res.attachment(file.name).type('application/octet-stream').sendFile(file.path);
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
}
