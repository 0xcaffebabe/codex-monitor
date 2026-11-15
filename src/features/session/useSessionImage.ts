import { useEffect, useRef, useState } from 'react';
import { clearToken, getToken } from '../../api';
import type { SessionImageRef } from '../../types';
import { workspaceUrl } from '../../workspace-scope';

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
    [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const { id, name, index, source } = image;
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
    void (async () => {
      try {
        const response = await fetch(
          workspaceUrl(
            source === 'computer-use'
              ? `/api/sessions/${sessionId}/computer-use/${encodeURIComponent(id)}/images/${index ?? 0}`
              : `/api/sessions/${sessionId}/images/${encodeURIComponent(id)}${index === undefined ? '' : `?index=${index}`}`,
          ),
          {
            headers: { Authorization: `Bearer ${getToken()}` },
            signal: controller.signal,
            cache: 'no-store',
          },
        );
        if (response.status === 401) clearToken();
        if (!response.ok) {
          let message = '图片加载失败';
          try {
            message = (await response.json()).error || message;
          } catch {}
          throw new Error(message);
        }
        const blob = await response.blob();
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
  }, [visible, sessionId, id, index, source]);
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
  return { url, error, open, setOpen, ref, name, onImageError };
}
