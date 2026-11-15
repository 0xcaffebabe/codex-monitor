import { FileText, Image } from 'lucide-react';
import { imageType } from './attachment-model';
import { ThumbnailProps, useThumbnail } from './useThumbnail';

export function Thumbnail(props: ThumbnailProps) {
  const { attachment } = props;
  const { url } = useThumbnail(props);
  return url ? (
    <img src={url} alt={attachment.name} />
  ) : imageType(attachment.type) ? (
    <Image size={19} />
  ) : (
    <FileText size={19} />
  );
}
