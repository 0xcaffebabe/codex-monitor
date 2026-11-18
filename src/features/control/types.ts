import type { Attachment } from '../attachments/types';
import type { SessionPermissionMode } from '../../approval-types';

export type SessionGoal = {
  objective: string;
  status: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
};
export type Receipt = {
  state: string;
  requestId?: string;
  threadId?: string;
  mode?: 'append' | 'start' | 'create' | 'compact' | 'interrupt' | 'goal' | 'help';
  message?: string;
  error?: string;
  goal?: SessionGoal | null;
  acceptedAt?: number;
  goalObjective?: string;
  goalState?: 'pending' | 'saved' | 'failed' | 'unknown' | 'conflict';
  goalError?: string;
};
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
export type Project = { id: string; name: string; path: string };
