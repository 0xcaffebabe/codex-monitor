export const maxAttachments = 10;
export const maxBytes = 20 * 1024 * 1024;
export const imageType = (type: string) => /^image\/(?:png|jpeg|webp|gif|bmp|avif)$/i.test(type);
export const sizeLabel = (size: number) =>
  size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(size / 1024))} KB`;
