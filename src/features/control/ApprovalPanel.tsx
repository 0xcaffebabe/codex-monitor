import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../api';
import type { ApprovalDecision, ApprovalRequest } from '../../approval-types';
import {
  approvalReceiptText,
  approvalUrl,
  queryApprovalReceipt,
  saveApprovalReceipt,
  useApprovalReceipts,
  type ApprovalReceipt,
} from './approval-receipts';

export function ApprovalPanel({
  threadId,
  userId,
  workspaceId,
  requestId,
  onChange,
}: {
  threadId: string;
  userId: string;
  workspaceId: string;
  requestId?: string;
  onChange?: () => void;
}) {
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
  if (!requests.length && !receipts.length && !error && !requestId) return null;
  return (
    <section className="approval-panel" aria-label="权限审批">
      <header>
        <ShieldCheck size={16} />
        <strong>权限审批</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新审批状态"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {error && (
        <p role="status" className="control-error">
          {error}
        </p>
      )}
      {!error && requestId && !requests.length && !receipts.length && (
        <p role="status">{connected ? '此请求已不在待审批列表。' : '正在核对审批状态…'}</p>
      )}
      {receipts.map((receipt) => (
        <p className="approval-receipt" role="status" key={receipt.id}>
          {busy === receipt.id ? '正在提交答复…' : approvalReceiptText(receipt)}
          {['unknown', 'pending'].includes(receipt.status) && (
            <button
              className="secondary"
              disabled={!!busy}
              onClick={async () => {
                setBusy(receipt.id);
                await queryApprovalReceipt(userId, receipt);
                setBusy('');
                setRefresh((value) => value + 1);
                onChange?.();
              }}
            >
              查询原回执
            </button>
          )}
        </p>
      ))}
      {requests.map((request) => (
        <article key={request.id} className="approval-request" aria-label={request.title}>
          <strong>{request.title}</strong>
          {request.reason && <p>{request.reason}</p>}
          <dl>
            {request.details.map((detail, index) => (
              <div key={index}>
                <dt>{detail.label}</dt>
                <dd>
                  <pre>{detail.value}</pre>
                </dd>
              </div>
            ))}
          </dl>
          <p className="control-hint">
            {request.scope} · {new Date(request.expiresAt).toLocaleTimeString()} 前答复
          </p>
          <div className="approval-actions">
            <button
              type="button"
              className="primary"
              disabled={
                !connected ||
                !!busy ||
                !request.canAccept ||
                receipts.some(
                  (receipt) =>
                    receipt.id === request.id &&
                    (receipt.status !== 'pending' || receipt.decision !== 'accept'),
                )
              }
              onClick={() => void answer(request, 'accept')}
            >
              允许本次
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                !connected ||
                !!busy ||
                receipts.some(
                  (receipt) =>
                    receipt.id === request.id &&
                    (receipt.status !== 'pending' || receipt.decision !== 'decline'),
                )
              }
              onClick={() => void answer(request, 'decline')}
            >
              拒绝
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
