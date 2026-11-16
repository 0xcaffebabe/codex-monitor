export const sessionPermissionModes = [
  'inherit',
  'read-only',
  'workspace-write',
  'workspace-write-network',
  'danger-full-access',
] as const;
export type SessionPermissionMode = (typeof sessionPermissionModes)[number];
export type ApprovalDecision = 'accept' | 'decline';
export type ApprovalRequest = {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: 'command' | 'file-change' | 'permissions';
  title: string;
  reason?: string;
  details: { label: string; value: string }[];
  scope: string;
  canAccept: boolean;
  createdAt: number;
  expiresAt: number;
  state: 'pending' | 'answered' | 'expired' | 'cancelled';
  decision?: ApprovalDecision;
};
export interface ApprovalControl {
  list(threadId: string): ApprovalRequest[];
  get(threadId: string, id: string): ApprovalRequest;
  answer(threadId: string, id: string, decision: ApprovalDecision): ApprovalRequest;
}
