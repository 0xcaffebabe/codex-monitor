import type { Attachment } from '../../attachment-types';
import type { SessionPermissionMode } from '../../approval-types';
import type { Receipt } from '../../control-types';

export type Draft = {
  prompt: string;
  requestId?: string;
  queued?: boolean;
  attachments?: Attachment[];
  asGoal?: boolean;
  desktopChannel?: boolean;
  permissionMode?: Exclude<SessionPermissionMode, 'inherit'>;
  creation?: Receipt;
};
