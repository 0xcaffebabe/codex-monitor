import { useEffect, useRef, useState } from 'react';
import { fetchImagePreview } from '../../shared/image-preview';
import type { SessionImageRef } from '../../types';

export type SessionImageProps = {
  sessionId: string;
  image: SessionImageRef;
  inline?: boolean;
  portalTarget?: Element;
};
export function useSessionImage({ sessionId, image }: SessionImageProps) {
  const [visible, setVisible] = useState(false),
    [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [open, setOpen] = useState(false),
    [previewUrl, setPreviewUrl] = useState(''),
    [previewError, setPreviewError] = useState(''),
    [previewLoading, setPreviewLoading] = useState(false),
    [original, setOriginal] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const { id, name, index, source } = image;
  const route =
    source === 'computer-use'
      ? `/api/sessions/${sessionId}/computer-use/${encodeURIComponent(id)}/images/${index ?? 0}`
      : `/api/sessions/${sessionId}/images/${encodeURIComponent(id)}${index === undefined ? '' : `?index=${index}`}`;
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '150px' },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let objectUrl = '';
    setError('');
    setUrl('');
    setOpen(false);
    setOriginal(false);
    setPreviewUrl('');
    void (async () => {
      try {
        const blob = await fetchImagePreview(route, 'thumbnail', controller.signal);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, route]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let objectUrl = '';
    setPreviewUrl('');
    setPreviewError('');
    setPreviewLoading(true);
    void fetchImagePreview(route, original ? 'original' : 'preview', controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
        setPreviewError('');
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setPreviewError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setPreviewUrl('');
    };
  }, [open, original, route]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);

  const onImageError = () => {
    setError('图片文件损坏或无法显示');
    setUrl('');
    setOpen(false);
  };
  const onPreviewError = () => {
    setPreviewUrl('');
    setPreviewError(original ? '原图无法显示' : '图片无法显示，可尝试查看原图');
  };
  return {
    url,
    error,
    open,
    setOpen,
    ref,
    name,
    onImageError,
    previewUrl,
    previewError,
    previewLoading,
    original,
    setOriginal,
    onPreviewError,
  };
}
