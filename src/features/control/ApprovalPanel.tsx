import { useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { api, ApiError, post } from '../../api';
import type { ApprovalDecision, ApprovalRequest } from '../../approval-types';

export function ApprovalPanel({ threadId }: { threadId: string }) {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState('');
  const [attempts, setAttempts] = useState<Record<string, ApprovalDecision>>({});
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setRequests([]);
    setAttempts({});
    setNotice('');
    setBusy('');
    setConnected(false);
  }, [threadId]);
  useEffect(() => {
    let stopped = false,
      loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api<{ available: boolean; requests: ApprovalRequest[] }>(
          `/api/sessions/${threadId}/approvals`,
          { signal: controller.signal },
        );
        if (!stopped) {
          setRequests(result.requests);
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
  }, [threadId, refresh]);
  const answer = async (request: ApprovalRequest, decision: ApprovalDecision) => {
    setBusy(request.id);
    setAttempts((previous) => ({ ...previous, [request.id]: decision }));
    setNotice('');
    try {
      await post(`/api/sessions/${threadId}/approvals/${request.id}`, { decision });
      setRequests((previous) => previous.filter((value) => value.id !== request.id));
      setNotice(decision === 'accept' ? '已允许，Codex 将继续执行。' : '已拒绝该请求。');
    } catch (error) {
      try {
        const receipt = await api<ApprovalRequest>(
          `/api/sessions/${threadId}/approvals/${request.id}`,
        );
        if (receipt.state === 'answered') {
          setRequests((previous) => previous.filter((value) => value.id !== request.id));
          setNotice(
            receipt.decision === 'accept' ? '已允许，Codex 将继续执行。' : '已拒绝该请求。',
          );
        } else if (receipt.state !== 'pending') {
          setRequests((previous) => previous.filter((value) => value.id !== request.id));
          setNotice('审批已过期或取消，请查看当前会话。');
        } else
          setNotice(
            `答复结果待确认：${(error as Error).message}。可重试同一答复，或刷新审批状态。`,
          );
      } catch {
        setNotice(`答复结果待确认：${(error as Error).message}。可重试同一答复，或刷新审批状态。`);
      }
    } finally {
      setBusy('');
      setRefresh((value) => value + 1);
    }
  };
  if (!requests.length && !notice && !error) return null;
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
      {notice && <p role="status">{notice}</p>}
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
                (!!attempts[request.id] && attempts[request.id] !== 'accept')
              }
              onClick={() => void answer(request, 'accept')}
            >
              {attempts[request.id] === 'accept' ? '重试允许本次' : '允许本次'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                !connected ||
                !!busy ||
                (!!attempts[request.id] && attempts[request.id] !== 'decline')
              }
              onClick={() => void answer(request, 'decline')}
            >
              {attempts[request.id] === 'decline' ? '重试拒绝' : '拒绝'}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
