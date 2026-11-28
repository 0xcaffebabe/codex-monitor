/** Public upload contract shared by the composer and the workspace HTTP boundary. */
export type Attachment = { id: string; name: string; size: number; type: string };

export const MAX_ATTACHMENTS = 10;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const attachmentCountError = `每条消息最多添加 ${MAX_ATTACHMENTS} 个附件。`;
export const attachmentSizeError = `单个附件不能超过 ${MAX_UPLOAD_BYTES / 1024 ** 2} MB。`;
