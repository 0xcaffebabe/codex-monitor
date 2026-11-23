import { homedir } from 'node:os';
import path from 'node:path';
import type { Config } from '../config.js';
import type { SessionFilePreviews } from '../file-preview.js';
import type { CodexSource } from '../source.js';

export const NOTIFICATION_ATTACHMENT_LIMIT = 5;
export type NotificationAttachment = { name: string; mime: string; data: Buffer };
export type NotificationAttachmentRef = {
  sessionId: string;
  turnId: string;
  occurredAt: number;
  index: number;
};
export type NotificationAttachmentResult = NotificationAttachment | 'unavailable' | null;

export class NotificationAttachments {
  private outputRoots: string[];

  constructor(
    private source: Pick<CodexSource, 'completionFiles'>,
    private files: SessionFilePreviews,
    config: Config,
  ) {
    this.outputRoots = [
      ...new Set([
        path.join(config.codexHome, 'generated_images'),
        path.join(homedir(), '.codex', 'generated_images'),
        ...(process.platform === 'win32' ? [] : ['/mnt/data']),
      ]),
    ];
  }

  async read(
    ref: NotificationAttachmentRef,
    signal: AbortSignal,
  ): Promise<NotificationAttachmentResult> {
    try {
      signal.throwIfAborted();
      const files = await this.source.completionFiles(ref.sessionId, ref.turnId, ref.occurredAt);
      const file = files?.paths[ref.index];
      return file ? await this.files.attachment(file, files.cwd, this.outputRoots, signal) : null;
    } catch {
      signal.throwIfAborted();
      return 'unavailable';
    }
  }
}
