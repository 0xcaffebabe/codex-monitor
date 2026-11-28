import { apiBlob } from '../api';
import { workspaceSignal, workspaceUrl } from '../workspace-scope';

// Decode once per document; fetch() does not advertise browser image codec support.
const probes = {
  avif: 'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAAB0AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAlbWRhdBIACgc4AAaQENBpMhAZQmMEwAA0AACQQMkcYIpq',
  webp: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=',
};
let preferred: Promise<'avif' | 'webp' | 'original'> | undefined;
function canDecode(format: keyof typeof probes) {
  return new Promise<boolean>((resolve) => {
    const image = new Image();
    const finish = (supported: boolean) => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      resolve(supported);
    };
    const timer = setTimeout(() => finish(false), 1500);
    image.onload = () => finish(image.naturalWidth > 0);
    image.onerror = () => finish(false);
    image.src = `data:image/${format};base64,${probes[format]}`;
  });
}
function preferredFormat() {
  return (preferred ??= (async () =>
    (await canDecode('avif')) ? 'avif' : (await canDecode('webp')) ? 'webp' : 'original')());
}

export async function fetchImagePreview(
  route: string,
  variant: 'thumbnail' | 'preview' | 'original',
  signal: AbortSignal,
) {
  const url = workspaceUrl(route);
  signal = workspaceSignal(route, signal)!;
  const format = variant === 'original' ? 'original' : await preferredFormat();
  signal.throwIfAborted();
  const query = new URLSearchParams({ variant, format });
  return apiBlob(`${url}${url.includes('?') ? '&' : '?'}${query}`, { signal }, '图片加载失败');
}
