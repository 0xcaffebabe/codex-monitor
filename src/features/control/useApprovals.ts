import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { ApprovalDecision, ApprovalRequest } from '../../approval-types';
import {
  approvalUrl,
  queryApprovalReceipt,
  saveApprovalReceipt,
  useApprovalReceipts,
  type ApprovalReceipt,
} from './approval-receipts';

export type ApprovalOptions = {
  threadId: string;
  userId: string;
  workspaceId: string;
  requestId?: string;
  onChange?: () => void;
};

/** Owns polling, one-at-a-time answers and recovery of the original approval receipt. */
export function useApprovals({
  threadId,
  userId,
  workspaceId,
  requestId,
  onChange,
}: ApprovalOptions) {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState('');
  const locked = useRef(false);
  const receipts = useApprovalReceipts(userId).filter(
    (receipt) =>
      receipt.scope === workspaceId &&
      receipt.threadId === threadId &&
      (!requestId || receipt.id === requestId),
  );
  useEffect(() => {
    let stopped = false,
      loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api<{ available: boolean; requests: ApprovalRequest[] }>(
          approvalUrl(workspaceId, threadId),
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) },
        );
        if (!stopped) {
          setRequests(result.requests.filter((request) => !requestId || request.id === requestId));
          setConnected(result.available);
          setError('');
        }
      } catch (error) {
        if (!stopped) {
          setConnected(false);
          if (!(error instanceof ApiError && error.status === 404))
            setError('无法读取审批请求：' + (error as Error).message);
        }
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [threadId, workspaceId, requestId, refresh]);

  const answer = async (request: ApprovalRequest, decision: ApprovalDecision) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(request.id);
    const entry: ApprovalReceipt = {
      scope: workspaceId,
      threadId,
      id: request.id,
      decision,
      status: 'unknown',
      at: Date.now(),
    };
    try {
      saveApprovalReceipt(userId, entry);
      const result = await api<ApprovalRequest>(approvalUrl(workspaceId, threadId, request.id), {
        method: 'POST',
        body: JSON.stringify({ decision }),
        signal: AbortSignal.timeout(10000),
      });
      saveApprovalReceipt(userId, { ...entry, status: result.state, actual: result.decision });
      setRequests((previous) => previous.filter((value) => value.id !== request.id));
    } catch {
      await queryApprovalReceipt(userId, entry);
    } finally {
      locked.current = false;
      setBusy('');
      setRefresh((value) => value + 1);
      onChange?.();
    }
  };

  const queryReceipt = async (receipt: ApprovalReceipt) => {
    setBusy(receipt.id);
    await queryApprovalReceipt(userId, receipt);
    setBusy('');
    setRefresh((value) => value + 1);
    onChange?.();
  };

  return {
    requests,
    connected,
    error,
    busy,
    receipts,
    answer,
    queryReceipt,
    refresh: () => setRefresh((value) => value + 1),
  };
}
