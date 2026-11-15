import path from 'node:path';
import { open, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export class MediaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function normalizeImagePath(file: string) {
  if (file.startsWith('file:')) {
    try {
      const url = new URL(file);
      if (url.hostname && url.hostname !== 'localhost') throw new Error();
      file = fileURLToPath(url);
    } catch {
      throw new MediaError(403, '图片路径不允许');
    }
  }
  file = file.replace(/^\\\\\?\\/, '');
  if (
    !path.isAbsolute(file) ||
    file.startsWith('\\\\') ||
    file.startsWith('//') ||
    (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(file))
  )
    throw new MediaError(403, '图片路径不允许');
  return file;
}
function imageMime(header: Buffer) {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6))) return 'image/gif';
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  if (header.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (
    header.toString('ascii', 4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(header.toString('ascii', 8, 12))
  )
    return 'image/avif';
  return '';
}
export function recordedImage(dataUrl: string) {
  if (dataUrl.length > 28 * 1024 * 1024) return null;
  const match = /^data:image\/(png|jpeg|webp|gif|bmp|avif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
    dataUrl,
  );
  if (!match) return null;
  const data = Buffer.from(match[2], 'base64'),
    mime = imageMime(data.subarray(0, 16));
  if (!mime || data.length > 20 * 1024 * 1024) return null;
  return { data, mime };
}
export async function localImage(file: string) {
  file = normalizeImagePath(file);
  let resolved: string;
  try {
    resolved = await realpath(file);
  } catch {
    throw new MediaError(404, '图片文件不存在或已移动');
  }
  if (
    !['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].includes(
      path.extname(resolved).toLowerCase(),
    )
  )
    throw new MediaError(415, '此图片格式暂不支持');
  const info = await stat(resolved);
  if (!info.isFile()) throw new MediaError(404, '图片文件不存在');
  if (info.size > 20 * 1024 * 1024) throw new MediaError(413, '图片超过 20 MB，暂不预览');
  const handle = await open(resolved, 'r');
  const header = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const mime = imageMime(header);
  if (!mime) throw new MediaError(415, '该记录未指向有效的图片文件');
  return { file: resolved, mime };
}
