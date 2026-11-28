/** Public upload contract shared by the composer and the workspace HTTP boundary. */
export type Attachment = { id: string; name: string; size: number; type: string };

export const MAX_ATTACHMENTS = 10;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
