import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionFileLink, SessionFilePreview } from '../src/file-preview-types.js';
import type { Config } from './config.js';
import { imageMime, MediaError } from './media.js';
import type { CodexSource } from './source.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_CHARS = 256 * 1024;
const MAX_LINE_CHARS = 8 * 1024;
const MAX_LINES = 2000;
const downloads = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx']);
const drive = /^[a-z]:[\\/]/i;
const deviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])\s*(?:\.|$)/i;

function localAbsolute(file: string) {
  if (!path.isAbsolute(file) || /^[\\/]{2}|[\x00-\x1f\x7f]/.test(file)) return false;
  if (process.platform !== 'win32') return !/^\/[a-z]:[\\/]/i.test(file);
  return (
    drive.test(file) &&
    !/[<>:"|?*]/.test(file.slice(2)) &&
    !file
      .slice(3)
      .split(/[\\/]/)
      .some((entry) => deviceName.test(entry))
  );
}

function resolveFile(file: string, cwd: string) {
  if (process.platform === 'win32') file = file.replace(/^\/(?=[a-z]:[\\/])/i, '');
  if (/^[\\/]{2}/.test(file) || (process.platform !== 'win32' && drive.test(file)))
    throw new MediaError(403, '文件路径与此主机的本地路径不匹配');
  if (path.isAbsolute(file)) {
    if (!localAbsolute(file)) throw new MediaError(403, '此文件路径不可预览');
    return path.normalize(file);
  }
  if (!localAbsolute(cwd)) throw new MediaError(404, '会话工作目录不可用');
  const resolved = path.resolve(cwd, file);
  if (!localAbsolute(resolved)) throw new MediaError(403, '此文件路径不可预览');
  return resolved;
}

function within(root: string, file: string) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function readBytes(handle: FileHandle, size: number, signal: AbortSignal) {
  const data = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(
      data,
      offset,
      Math.min(size - offset, 256 * 1024),
      offset,
    );
    if (!bytesRead) break;
    offset += bytesRead;
  }
  signal.throwIfAborted();
  return data.subarray(0, offset);
}

function textPreview(data: Buffer, link: SessionFileLink) {
  const utf16 =
    data[0] === 0xff && data[1] === 0xfe
      ? 'utf-16le'
      : data[0] === 0xfe && data[1] === 0xff
        ? 'utf-16be'
        : undefined;
  let text: string;
  try {
    text = new TextDecoder(utf16 ?? 'utf-8', { fatal: true }).decode(data);
  } catch {
    throw new MediaError(415, '此文件格式或文本编码暂不支持预览');
  }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text))
    throw new MediaError(415, '此二进制文件格式暂不支持预览');
  text = text.replace(/\r\n?/g, '\n');
  const startLine = Math.max(1, (link.line ?? 1) - 20);
  let offset = 0;
  for (let line = 1; line < startLine; line++) {
    const end = text.indexOf('\n', offset);
    if (end === -1) throw new MediaError(416, '引用行已超出当前文件的行数');
    offset = end + 1;
  }
  const maxLines = link.line
    ? Math.min(MAX_LINES, Math.max(180, (link.endLine ?? link.line) - startLine + 41))
    : MAX_LINES;
  const lines: string[] = [];
  let remaining = MAX_CHARS;
  let partial = startLine > 1;
  while (offset <= text.length && lines.length < maxLines && remaining > 0) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline;
    const limit = Math.min(remaining, MAX_LINE_CHARS);
    const length = Math.min(end - offset, limit);
    lines.push(text.slice(offset, offset + length));
    remaining -= length + 1;
    partial ||= length < end - offset;
    offset = end + 1;
  }
  if (link.line && link.line >= startLine + lines.length)
    throw new MediaError(416, '引用行已超出当前文件的行数');
  return {
    lines,
    startLine,
    line: link.line,
    endLine: link.endLine,
    partial: partial || offset <= text.length,
  };
}

export type FilePreviewView = 'preview' | 'image' | 'download';
type BinaryPreview = { data: Buffer; mime: string; name: string };

export class SessionFilePreviews {
  private pending = 0;
  private privatePaths: string[];

  constructor(
    private source: Pick<CodexSource, 'fileLink'>,
    config: Config,
  ) {
    this.privatePaths = [
      ...new Set(
        [
          config.codexHome,
          config.dataDir,
          path.join(homedir(), '.codex'),
          '.monitor',
          '.monitor-client',
          '.env',
          process.env.MONITOR_CLIENT_KEY_FILE,
          process.env.MONITOR_TLS_KEY,
        ]
          .filter((entry): entry is string => !!entry)
          .map((entry) => path.resolve(entry)),
      ),
    ];
  }

  private async resolve(file: string) {
    if (this.privatePaths.some((root) => within(root, file)))
      throw new MediaError(403, '此文件位于受保护的私有目录');
    const resolved = await realpath(file);
    if (!localAbsolute(resolved)) throw new MediaError(403, '此文件路径不可预览');
    const roots = await Promise.all(
      this.privatePaths.map((root) => realpath(root).catch(() => root)),
    );
    if (roots.some((root) => within(root, resolved)))
      throw new MediaError(403, '此文件位于受保护的私有目录');
    return resolved;
  }

  async read(
    sessionId: string,
    itemId: string,
    linkId: string,
    view: FilePreviewView,
    signal: AbortSignal,
  ): Promise<SessionFilePreview | BinaryPreview> {
    if (this.pending >= 4) throw new MediaError(429, '文件预览请求过多，请稍后重试');
    this.pending++;
    let handle: FileHandle | undefined;
    try {
      const target = await this.source.fileLink(sessionId, itemId, linkId);
      if (!target) throw new MediaError(404, '找不到这条文件引用，或会话内容已更新');
      const resolved = await this.resolve(resolveFile(target.link.path, target.cwd));
      const before = await stat(resolved);
      if (!before.isFile()) throw new MediaError(415, '此链接未指向普通文件');
      signal.throwIfAborted();
      handle = await open(
        resolved,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const info = await handle.stat();
      const current = await this.resolve(resolved);
      const after = await stat(current);
      if (
        !info.isFile() ||
        current !== resolved ||
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        info.dev !== after.dev ||
        info.ino !== after.ino
      )
        throw new MediaError(409, '文件路径已变化，请重新打开');
      const size = info.size;
      if (size > MAX_BYTES) throw new MediaError(413, '文件超过 20 MiB，暂无法打开');
      const name = path.basename(resolved);
      const extension = path.extname(name).toLowerCase();
      const metadata = { name, path: resolved, size };
      if (downloads.has(extension)) {
        if (view === 'preview') return { ...metadata, kind: 'download' };
        if (view === 'download')
          return {
            name,
            mime: 'application/octet-stream',
            data: await readBytes(handle, size, signal),
          };
      }
      const mime = imageMime(await readBytes(handle, Math.min(size, 16), signal));
      if (mime) {
        if (view === 'preview') return { ...metadata, kind: 'image' };
        if (view === 'image') return { name, mime, data: await readBytes(handle, size, signal) };
      }
      if (view !== 'preview') throw new MediaError(415, '此文件类型无法按所选方式打开');
      const kind =
        ['.md', '.markdown'].includes(extension) && !target.link.line ? 'markdown' : 'text';
      return {
        ...metadata,
        kind,
        ...textPreview(await readBytes(handle, size, signal), target.link),
      };
    } catch (error) {
      signal.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new MediaError(404, '文件不存在或已移动');
      if (code === 'EACCES' || code === 'EPERM')
        throw new MediaError(403, '此主机没有读取该文件的权限');
      if (code === 'EINVAL' || code === 'ELOOP' || code === 'ENAMETOOLONG')
        throw new MediaError(403, '此文件路径不可预览');
      throw error;
    } finally {
      try {
        await handle?.close();
      } finally {
        this.pending--;
      }
    }
  }
}
