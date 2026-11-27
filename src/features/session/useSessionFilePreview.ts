import { useEffect, useRef, useState } from 'react';
import { api, apiBlob } from '../../api';
import type { SessionFilePreview } from '../../file-preview-types';
import { fetchImagePreview } from '../../shared/image-preview';
import { workspaceUrl } from '../../workspace-scope';

export function useSessionFilePreview(
  sessionId: string,
  itemId: string,
  linkId: string,
  workspaceId?: string,
) {
  const endpoint = `/api/sessions/${sessionId}/file-preview/${encodeURIComponent(itemId)}/${linkId}`;
  const route = workspaceId ? workspaceUrl(endpoint, workspaceId) : endpoint;
  const [preview, setPreview] = useState<{ file: SessionFilePreview; imageUrl?: string }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const downloadRequest = useRef<AbortController>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let imageUrl: string | undefined;
    setPreview(undefined);
    setError('');
    void (async () => {
      try {
        const file = await api<SessionFilePreview>(route, { signal });
        if (file.kind === 'image') {
          const blob = await fetchImagePreview(`${route}?view=image`, 'preview', signal);
          if (signal.aborted) return;
          imageUrl = URL.createObjectURL(blob);
        }
        if (!signal.aborted) setPreview({ file, imageUrl });
      } catch (error) {
        if (!signal.aborted) setError((error as Error).message);
      }
    })();
    return () => {
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [route, attempt]);

  useEffect(() => () => downloadRequest.current?.abort(), [route]);

  async function download() {
    if (preview?.file.kind !== 'download' || downloadRequest.current) return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    setDownloading(true);
    setDownloadError('');
    try {
      const blob = await apiBlob(`${route}?view=download`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = preview.file.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      if (!controller.signal.aborted) setDownloadError((error as Error).message);
    } finally {
      downloadRequest.current = null;
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  return {
    preview,
    error,
    retry: () => setAttempt((value) => value + 1),
    downloading,
    downloadError,
    download,
    onImageError: () => setError('图片文件损坏或无法显示'),
  };
}
