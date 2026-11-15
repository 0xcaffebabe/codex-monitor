import { useEffect, useState } from 'react';
import { fetchImagePreview } from '../../shared/image-preview';
import { imageType } from './attachment-model';
import type { Attachment } from './types';

export type ThumbnailProps = { attachment: Attachment };
export function useThumbnail({ attachment }: ThumbnailProps) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!imageType(attachment.type)) return;
    const controller = new AbortController();
    let objectUrl = '';
    setUrl('');
    void fetchImagePreview(`/api/uploads/${attachment.id}`, 'thumbnail', controller.signal)
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
  }, [attachment.id, attachment.type]);

  return { url };
}
