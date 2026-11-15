import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { z } from 'zod';

export const imagePreviewQuery = {
  variant: z.enum(['thumbnail', 'preview', 'original']).optional(),
  format: z.enum(['avif', 'webp', 'original']).optional(),
};
export type ImageVariant = 'thumbnail' | 'preview' | 'original';
export type ImageFormat = 'avif' | 'webp' | 'original';
export type ImageMedia = { mime: string } & ({ file: string } | { data: Buffer });
type EncodedImage = { mime: string; data: Buffer };
type CachedImage = { image: EncodedImage | null; expires: number };
const MAX_BYTES = 32 * 1024 * 1024;

function isAnimatedPng(data: Buffer) {
  // libvips can expose only APNG's first frame in metadata. acTL must precede IDAT.
  for (let offset = 8; offset + 12 <= data.length;) {
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + data.readUInt32BE(offset);
  }
  return false;
}

/** Workspace-local derivatives only. Callers must resolve and authorize the source on every read. */
export class ImagePreviews {
  private cache = new Map<string, CachedImage>();
  private pending = new Map<string, Promise<EncodedImage | null>>();
  private waiting: (() => void)[] = [];
  private active = 0;
  private bytes = 0;
  private pendingBytes = 0;
  private closed = false;

  constructor(private maxBytes = MAX_BYTES) {}

  async render(
    media: ImageMedia,
    variant?: ImageVariant,
    format?: ImageFormat,
  ): Promise<ImageMedia> {
    if (this.closed || !variant || variant === 'original' || !format || format === 'original')
      return media;
    let fingerprint: string, size: number;
    if ('file' in media) {
      const info = await stat(media.file);
      size = info.size;
      fingerprint = JSON.stringify([media.file, size, info.mtimeMs, info.ctimeMs, info.ino]);
    } else {
      size = media.data.length;
      fingerprint = createHash('sha256').update(media.data).digest('hex');
    }
    if (size > 20 * 1024 * 1024) return media;
    const key = `${format}:${variant}:${media.mime}:${fingerprint}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.image ?? media;
    }
    if (cached) this.remove(key);
    let job = this.pending.get(key);
    if (!job) {
      // Bound native work and queued source buffers during image-heavy scrolling.
      const retained = 'data' in media ? size : 0;
      if (this.pending.size >= 24 || this.pendingBytes + retained > 64 * 1024 * 1024) return media;
      this.pendingBytes += retained;
      job = this.schedule(() => this.encode(media, variant, format, size))
        .then((image) => {
          if (!this.closed && (!image || image.data.length <= this.maxBytes)) {
            this.cache.set(key, { image, expires: Date.now() + 5 * 60 * 1000 });
            this.bytes += image?.data.length ?? 0;
            while (this.bytes > this.maxBytes || this.cache.size > 128)
              this.remove(this.cache.keys().next().value!);
          }
          return image;
        })
        .finally(() => {
          this.pending.delete(key);
          this.pendingBytes -= retained;
        });
      this.pending.set(key, job);
    }
    return (await job) ?? media;
  }

  private remove(key: string) {
    this.bytes -= this.cache.get(key)?.image?.data.length ?? 0;
    this.cache.delete(key);
  }

  private schedule(work: () => Promise<EncodedImage | null>): Promise<EncodedImage | null> {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.active++;
        void (this.closed ? Promise.resolve(null) : work()).then(resolve, reject).finally(() => {
          this.active--;
          this.waiting.shift()?.();
        });
      };
      if (this.active < 2) run();
      else this.waiting.push(run);
    });
  }

  private async encode(
    media: ImageMedia,
    variant: Exclude<ImageVariant, 'original'>,
    format: Exclude<ImageFormat, 'original'>,
    originalSize: number,
  ): Promise<EncodedImage | null> {
    try {
      const input =
        'file' in media
          ? media.mime === 'image/png'
            ? await readFile(media.file)
            : media.file
          : media.data;
      if (media.mime === 'image/png' && Buffer.isBuffer(input) && isAnimatedPng(input)) return null;
      const image = sharp(input, {
        limitInputPixels: 32_000_000,
        failOn: 'warning',
      }).timeout({ seconds: 5 });
      const metadata = await image.metadata();
      // Preserve animated GIF, WebP and APNG instead of silently freezing the first frame.
      if ((metadata.pages ?? 1) > 1) return null;
      image.rotate().resize({
        width: variant === 'thumbnail' ? 720 : 2560,
        height: variant === 'thumbnail' ? 480 : 2560,
        fit: 'inside',
        withoutEnlargement: true,
      });
      const data = await (
        format === 'avif'
          ? image.avif({ quality: 60, effort: 2, chromaSubsampling: '4:4:4', bitdepth: 8 })
          : image.webp({ quality: 80, effort: 3 })
      ).toBuffer();
      // Tiny/already optimized files must not get larger just to change their format.
      return data.length < originalSize ? { data, mime: `image/${format}` } : null;
    } catch {
      // Unsupported decoders, malformed files and encoding timeouts retain the existing preview.
      return null;
    }
  }

  close() {
    this.closed = true;
    this.cache.clear();
    this.bytes = 0;
  }
}
