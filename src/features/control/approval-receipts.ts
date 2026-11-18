import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { ApprovalDecision, ApprovalRequest } from '../../approval-types';
import { workspaceUrl } from '../../workspace-scope';

export type ApprovalReceipt = {
  scope: string;
  threadId: string;
  id: string;
  decision: ApprovalDecision;
  actual?: ApprovalDecision;
  status: 'unknown' | ApprovalRequest['state'];
  at: number;
};

const event = 'monitor:approval-receipts';
const key = (userId: string) => `codex-monitor.approval-receipts.${userId}`;
const matches = (
  left: ApprovalReceipt,
  right: Pick<ApprovalReceipt, 'scope' | 'threadId' | 'id'>,
) => left.scope === right.scope && left.threadId === right.threadId && left.id === right.id;

export function readApprovalReceipts(userId: string): ApprovalReceipt[] {
  try {
    return (JSON.parse(sessionStorage.getItem(key(userId)) || '[]') as ApprovalReceipt[]).filter(
      (item) => item.at >= Date.now() - 86400000,
    );
  } catch {
    return [];
  }
}

export function saveApprovalReceipt(userId: string, entry: ApprovalReceipt, remove = false) {
  const rest = readApprovalReceipts(userId).filter((item) => !matches(item, entry));
  if (!remove) rest.unshift(entry);
  sessionStorage.setItem(key(userId), JSON.stringify(rest.slice(0, 64)));
  window.dispatchEvent(new Event(event));
}

export function useApprovalReceipts(userId: string) {
  const [receipts, setReceipts] = useState(() => readApprovalReceipts(userId));
  useEffect(() => {
    const update = () => setReceipts(readApprovalReceipts(userId));
    update();
    window.addEventListener(event, update);
    return () => window.removeEventListener(event, update);
  }, [userId]);
  return receipts;
}

export function approvalUrl(scope: string, threadId: string, id?: string) {
  return workspaceUrl(
    `/api/sessions/${encodeURIComponent(threadId)}/approvals${id ? '/' + encodeURIComponent(id) : ''}`,
    scope,
  );
}

export async function queryApprovalReceipt(userId: string, entry: ApprovalReceipt) {
  try {
    const result = await api<ApprovalRequest>(approvalUrl(entry.scope, entry.threadId, entry.id), {
      signal: AbortSignal.timeout(10000),
    });
    const receipt = { ...entry, status: result.state, actual: result.decision };
    saveApprovalReceipt(userId, receipt);
    return receipt;
  } catch {
    const receipt = { ...entry, status: 'unknown' as const, actual: undefined };
    saveApprovalReceipt(userId, receipt);
    return receipt;
  }
}

export function approvalReceiptText(receipt: ApprovalReceipt) {
  switch (receipt.status) {
    case 'answered':
      return receipt.actual === 'accept' ? '答复已确认：允许本次' : '答复已确认：拒绝';
    case 'expired':
      return '审批已过期';
    case 'cancelled':
      return '审批已取消';
    case 'pending':
      return '原请求仍在等待答复';
    default:
      return '结果待确认，请查询原回执';
  }
}
