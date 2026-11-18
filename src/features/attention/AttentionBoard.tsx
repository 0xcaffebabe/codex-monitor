import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  ListTodo,
  Monitor,
  Plus,
  Radio,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Children, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AttentionReceipt, AttentionSession } from '../../attention-types';
import { relative, time } from '../../shared/format';
import type { User } from '../../types';
import { navigateWorkspace } from '../../workspace-scope';
import { ApprovalPanel } from '../control/ApprovalPanel';
import {
  approvalReceiptText,
  queryApprovalReceipt,
  useApprovalReceipts,
  type ApprovalReceipt,
} from '../control/approval-receipts';
import type { AttentionWorkspace } from './useAttention';

type Task = { workspaceId: string; workspaceName: string; session: AttentionSession };
type Item = Task & {
  key: string;
  label: string;
  detail?: string;
  at: number;
  action?: string;
  approval?: string;
  question?: boolean;
  result?: boolean;
  watched: boolean;
};

function openTask(item: Task, result?: boolean) {
  const params = new URLSearchParams({ view: 'attention' });
  if (result) {
    params.set('result', item.session.latestTurn || 'latest');
    params.set('observed', String(item.session.updatedAt));
  }
  navigateWorkspace(item.workspaceId, item.session.id, params);
}

function Group({
  title,
  count,
  icon,
  empty,
  children,
}: {
  title: string;
  count: number;
  icon: ReactNode;
  empty: string;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const limit = title === '待处理' ? 8 : 5;
  const entries = Children.toArray(children);
  return (
    <section className="attention-group" aria-label={title}>
      <h2>
        {icon}
        {title}
        <span>{count}</span>
      </h2>
      {count ? (
        <ul>{expanded ? entries : entries.slice(0, limit)}</ul>
      ) : (
        <p className="attention-empty">{empty}</p>
      )}
      {entries.length > limit && (
        <button
          className="attention-expand secondary"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起' : `再看 ${entries.length - limit} 条`}
        </button>
      )}
    </section>
  );
}

function TaskRow({ item, onOpen }: { item: Item; onOpen: () => void }) {
  return (
    <li className="attention-item">
      <div className="attention-task">
        <small className="attention-kind">{item.label}</small>
        <strong>{item.session.title || '未命名会话'}</strong>
        {item.detail && <p>{item.detail}</p>}
        <small className="attention-meta">
          <Monitor size={13} />
          {item.workspaceName} · {item.session.project} · {relative(item.at)}
          {item.watched && ' · 已关注'}
        </small>
      </div>
      {item.action && (
        <button
          className="secondary attention-action"
          onClick={onOpen}
          aria-label={`${item.action}：${item.session.title}`}
          aria-description={`${item.workspaceName} · ${item.session.project}`}
        >
          {item.action}
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

function TaskDialog({
  item,
  user,
  onClose,
  refresh,
}: {
  item: Item;
  user: User;
  onClose: () => void;
  refresh: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="attention-dialog"
      aria-labelledby="attention-approval-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="attention-dialog-heading">
        <ShieldCheck size={20} />
        <div>
          <h2 id="attention-approval-title">{item.approval ? '核对权限请求' : '查看待答复问题'}</h2>
          <p>
            {item.workspaceName} · {item.session.title}
          </p>
        </div>
        <button
          className="icon-button"
          title={item.approval ? '关闭审批详情' : '关闭问题详情'}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      {item.approval ? (
        <ApprovalPanel
          userId={user.id}
          workspaceId={item.workspaceId}
          threadId={item.session.id}
          requestId={item.approval}
          onChange={refresh}
        />
      ) : (
        <div className="attention-question">
          <strong>{item.detail}</strong>
          <p>请在 {item.workspaceName} 的 Codex 客户端答复。</p>
          <button
            className="secondary attention-action"
            onClick={() => {
              onClose();
              openTask(item);
            }}
          >
            查看会话 <ArrowUpRight size={14} />
          </button>
        </div>
      )}
    </dialog>
  );
}

const receiptOperations: Record<string, string> = {
  append: '追加消息',
  start: '发送消息',
  create: '新建会话',
  compact: '压缩上下文',
  interrupt: '中断轮次',
  goal: '更新目标',
  help: '查看帮助',
};
const receiptStates: Record<string, string> = {
  queued: '已排队',
  pending: '等待执行回执',
  succeeded: '操作已确认',
  failed: '操作未成功',
  cancelled: '已取消',
  unknown: '结果待确认',
};
type ControlReceipt = AttentionReceipt & { workspaceId: string; workspaceName: string };

function controlReceiptRow(item: ControlReceipt) {
  return (
    <li key={`${item.workspaceId}:${item.id}`} className="attention-item">
      <div className="attention-task">
        <strong>
          {receiptOperations[item.operation] || '会话操作'} ·{' '}
          {receiptStates[item.state] || '结果待确认'}
        </strong>
        {item.detail && <p>{item.detail}</p>}
        <small className="attention-meta">
          {item.workspaceName} · {time(item.at)}
        </small>
      </div>
      {item.threadId && (
        <button
          className="secondary attention-action"
          onClick={() =>
            navigateWorkspace(
              item.workspaceId,
              item.threadId,
              new URLSearchParams({ view: 'attention' }),
            )
          }
        >
          查看会话 <ArrowUpRight size={14} />
        </button>
      )}
    </li>
  );
}

function ReceiptRow({
  receipt,
  name,
  userId,
}: {
  receipt: ApprovalReceipt;
  name: string;
  userId: string;
}) {
  const [checking, setChecking] = useState(false);
  return (
    <li className="attention-item">
      <div className="attention-task">
        <strong>{approvalReceiptText(receipt)}</strong>
        <small className="attention-meta">
          {name} · {time(receipt.at)}
        </small>
      </div>
      {['unknown', 'pending'].includes(receipt.status) && (
        <button
          className="secondary attention-action"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            await queryApprovalReceipt(userId, receipt);
            setChecking(false);
          }}
        >
          {checking ? '正在查询…' : '查询原回执'}
        </button>
      )}
    </li>
  );
}

export function AttentionBoard({
  groups,
  user,
  compact,
  refresh,
  startSession,
  watches,
}: {
  groups: AttentionWorkspace[];
  user: User;
  compact?: boolean;
  refresh: () => void;
  startSession: () => void;
  watches: { workspaceId: string; sessionId: string }[];
}) {
  const [openItem, setOpenItem] = useState<Item>();
  const receipts = useApprovalReceipts(user.id).filter((receipt) =>
    groups.some(({ workspace }) => workspace.id === receipt.scope),
  );
  const attention: Item[] = [],
    running: Item[] = [],
    ended: Item[] = [];
  const control: ControlReceipt[] = [];
  let runningCount = 0;
  for (const { workspace, snapshot, fresh } of groups) {
    if (!snapshot) continue;
    const task = (session: AttentionSession) => ({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      session,
    });
    const row = (session: AttentionSession, label: string, action?: string) => ({
      ...task(session),
      key: `${workspace.id}:${session.id}`,
      label,
      action,
      at: session.updatedAt,
      watched: watches.some(
        (item) => item.workspaceId === workspace.id && item.sessionId === session.id,
      ),
    });
    if (!fresh) {
      for (const session of [...snapshot.running, ...snapshot.waiting]) {
        attention.push({
          ...row(session, '状态未知'),
          detail: `最后同步 ${time(snapshot.observedAt)} · ${workspace.online ? '暂不可读取' : '工作空间离线'}`,
        });
      }
      continue;
    }
    for (const receipt of snapshot.receipts ?? [])
      control.push({ ...receipt, workspaceId: workspace.id, workspaceName: workspace.name });
    const takingAction = new Set<string>();
    for (const request of snapshot.approvals.requests) {
      takingAction.add(request.threadId);
      attention.push({
        ...row(request.session, '待审批', '核对审批'),
        key: `${workspace.id}:approval:${request.id}`,
        approval: request.id,
        detail: request.title,
        at: request.createdAt,
      });
    }
    for (const request of snapshot.questions ?? []) {
      takingAction.add(request.session.id);
      attention.push({
        ...row(request.session, '待答复', '查看问题'),
        key: `${workspace.id}:input:${request.id}`,
        detail: request.title,
        at: request.createdAt,
        question: true,
      });
    }
    for (const session of snapshot.waiting)
      if (!takingAction.has(session.id)) attention.push(row(session, '等待互动', '查看会话'));
    for (const session of snapshot.stale)
      if (!takingAction.has(session.id)) attention.push(row(session, '状态待确认', '查看记录'));
    for (const session of snapshot.ended) {
      if (session.status === 'failed' && !takingAction.has(session.id))
        attention.push({ ...row(session, '本轮失败', '查看结果'), result: true });
      else if (!takingAction.has(session.id))
        ended.push({
          ...row(
            session,
            session.status === 'interrupted' ? '本轮已中断' : '本轮已结束',
            '查看结果',
          ),
          result: true,
        });
    }
    runningCount += Math.max(
      0,
      snapshot.counts.running -
        snapshot.running.filter((session) => takingAction.has(session.id)).length,
    );
    for (const session of snapshot.running)
      if (!takingAction.has(session.id)) running.push(row(session, '运行中', '查看进展'));
  }
  const pending = receipts.filter((receipt) => ['unknown', 'pending'].includes(receipt.status));
  const confirmed = receipts.filter((receipt) => !pending.includes(receipt)).slice(0, 8);
  control.sort((left, right) => right.at - left.at);
  const pendingControl = control.filter((receipt) => receipt.state === 'unknown' || receipt.detail);
  const confirmedControl = control
    .filter((receipt) => !pendingControl.includes(receipt))
    .slice(0, 5);
  const unavailable = groups.filter(({ fresh }) => !fresh);
  const limited =
    user.role === 'admin' &&
    groups.some(
      ({ fresh, snapshot }) =>
        fresh && (!snapshot?.approvals.supported || snapshot.questions === null),
    );
  const order = ['待审批', '待答复', '等待互动', '本轮失败', '状态待确认', '状态未知'];
  attention.sort(
    (left, right) =>
      order.indexOf(left.label) - order.indexOf(right.label) ||
      Number(right.watched) - Number(left.watched) ||
      right.at - left.at,
  );
  const rows = (items: Item[], limit: number) =>
    items.slice(0, limit).map((item) => (
      <TaskRow
        key={item.key}
        item={item}
        onOpen={() => {
          if (item.approval || item.question) setOpenItem(item);
          else openTask(item, item.result);
        }}
      />
    ));
  const receiptRows = (items: ApprovalReceipt[]) =>
    items.map((receipt) => (
      <ReceiptRow
        key={`${receipt.scope}:${receipt.id}`}
        receipt={receipt}
        userId={user.id}
        name={
          groups.find(({ workspace }) => workspace.id === receipt.scope)?.workspace.name ??
          receipt.scope
        }
      />
    ));
  return (
    <div
      id={compact ? 'workspace-sessions' : undefined}
      className={`attention-board${compact ? ' session-panel compact' : ''}`}
    >
      <div className="attention-inner">
        <header className="attention-heading">
          <div>
            <h1>任务动态</h1>
            <p>
              {groups.length - unavailable.length}/{groups.length} 个工作空间已同步
            </p>
          </div>
          {!compact && user.role === 'admin' && (
            <button className="secondary attention-action" onClick={startSession}>
              <Plus size={16} />
              新建会话
            </button>
          )}
        </header>
        {!!unavailable.length && (
          <p className="attention-coverage" role="status">
            <CircleAlert size={16} />
            <span>
              {unavailable
                .map(
                  ({ workspace, snapshot }) =>
                    `${workspace.name}（${!workspace.online ? '离线' : snapshot ? '同步中断' : '等待同步'}）`,
                )
                .join('、')}
            </span>
          </p>
        )}
        {limited && (
          <p className="attention-coverage">
            <CircleAlert size={16} />
            部分工作空间的互动状态不可读取，需在 Codex 桌面端确认。
          </p>
        )}
        <div className="attention-grid">
          <div>
            <Group
              title="待处理"
              icon={<ListTodo size={18} />}
              count={attention.length + pending.length + pendingControl.length}
              empty={
                unavailable.length || limited || user.role !== 'admin'
                  ? '已同步的可见记录中暂无待办。'
                  : '暂无待办。'
              }
            >
              {rows(attention, 160)}
              {receiptRows(pending)}
              {pendingControl.map(controlReceiptRow)}
            </Group>
            {!!(confirmed.length + confirmedControl.length) && (
              <Group
                title="最近回执"
                icon={<CircleCheck size={18} />}
                count={confirmed.length + confirmedControl.length}
                empty=""
              >
                {receiptRows(confirmed)}
                {confirmedControl.map(controlReceiptRow)}
              </Group>
            )}
          </div>
          <div>
            <Group
              title="运行中"
              icon={<Radio size={18} />}
              count={runningCount}
              empty="未观测到运行中的会话。"
            >
              {rows(
                running.sort((left, right) => right.at - left.at),
                100,
              )}
            </Group>
            <Group
              title="最近结束"
              icon={<Clock3 size={18} />}
              count={ended.length}
              empty="近 24 小时没有已结束的轮次。"
            >
              {rows(
                ended.sort((left, right) => right.at - left.at),
                30,
              )}
            </Group>
          </div>
        </div>
      </div>
      {openItem && (
        <TaskDialog
          item={openItem}
          user={user}
          refresh={refresh}
          onClose={() => setOpenItem(undefined)}
        />
      )}
    </div>
  );
}
