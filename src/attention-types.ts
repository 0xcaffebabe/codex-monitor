import type { ApprovalRequest } from './approval-types';
import type { Session } from './types';
import type { ManagedWorkspace } from './workspaces';

export type AttentionApproval = Pick<
  ApprovalRequest,
  'id' | 'threadId' | 'title' | 'createdAt' | 'expiresAt'
>;
export type AttentionSession = Pick<
  Session,
  'id' | 'title' | 'project' | 'cwd' | 'updatedAt' | 'status' | 'latestTurn'
>;
export type AttentionRequest = {
  id: string;
  session: AttentionSession;
  title: string;
  questions?: { text: string; options: string[] }[];
  createdAt: number;
};
export type AttentionReceipt = {
  id: string;
  threadId?: string;
  at: number;
  operation: string;
  state: string;
  detail?: string;
};
export type AttentionSnapshot = {
  observedAt: number;
  available: boolean;
  approvals: {
    supported: boolean;
    requests: (AttentionApproval & { session: AttentionSession })[];
  };
  questions: AttentionRequest[] | null;
  receipts: AttentionReceipt[];
  running: AttentionSession[];
  waiting: AttentionSession[];
  ended: AttentionSession[];
  stale: AttentionSession[];
  counts: { running: number; waiting: number; ended: number; stale: number };
};

/** A workspace observation can retain an old snapshot while its current connection is unavailable. */
export type AttentionObservation = { snapshot?: AttentionSnapshot; error?: boolean };
export type AttentionWorkspace = AttentionObservation & {
  workspace: ManagedWorkspace;
  fresh: boolean;
};
