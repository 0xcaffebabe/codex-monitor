import { ShieldCheck, RefreshCw } from 'lucide-react';
import { approvalReceiptText } from './approval-receipts';
import { useApprovals, type ApprovalOptions } from './useApprovals';

export function ApprovalPanel(options: ApprovalOptions) {
  const { requestId } = options;
  const { requests, receipts, connected, error, busy, answer, queryReceipt, refresh } =
    useApprovals(options);
  if (!requests.length && !receipts.length && !error && !requestId) return null;
  return (
    <section className="approval-panel" aria-label="权限审批">
      <header>
        <ShieldCheck size={16} />
        <strong>权限审批</strong>
        <button type="button" className="icon-button" aria-label="刷新审批状态" onClick={refresh}>
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
              onClick={() => void queryReceipt(receipt)}
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
