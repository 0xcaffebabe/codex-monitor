import { useEffect, useState } from 'react';
import { getToken } from '../../api';
import { imageType } from './attachment-model';
import type { Attachment } from './types';
import { workspaceUrl } from '../../workspace-scope';

export type ThumbnailProps = { attachment: Attachment };
export function useThumbnail({ attachment }: ThumbnailProps) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!imageType(attachment.type)) return;
    const controller = new AbortController();
    let objectUrl = '';
    void fetch(workspaceUrl(`/api/uploads/${attachment.id}`), {
      headers: { Authorization: `Bearer ${getToken()}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.type }));
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.type]);

  return { url };
}
