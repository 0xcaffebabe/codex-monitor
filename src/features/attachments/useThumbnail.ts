import { useEffect, useState } from 'react';
import { fetchImagePreview } from '../../shared/image-preview';
import { workspaceUrl } from '../../workspace-scope';
import { imageType } from './attachment-model';
import type { Attachment } from './types';

export type ThumbnailProps = { attachment: Attachment; workspaceId?: string };
export function useThumbnail({ attachment, workspaceId }: ThumbnailProps) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!imageType(attachment.type)) return;
    const controller = new AbortController();
    let objectUrl = '';
    setUrl('');
    const route = `/api/uploads/${attachment.id}`;
    void fetchImagePreview(workspaceId ? workspaceUrl(route, workspaceId) : route, 'thumbnail', controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.type, workspaceId]);

  return { url };
}
