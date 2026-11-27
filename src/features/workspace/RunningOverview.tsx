import {
  Activity,
  ArrowDown,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Clock,
  GripVertical,
  History,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Monitor,
  SquarePen,
  X,
} from 'lucide-react';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { AttentionSession } from '../../attention-types';
import { DetailLoader } from '../../detail-loader';
import { relative, time } from '../../shared/format';
import { Markdown } from '../../shared/ui/Markdown';
import { Status } from '../../shared/ui/Status';
import type { SessionPage, TimelineEvent, User } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';
import { closeOverview, navigateWorkspace } from '../../workspace-scope';
import type { AttentionWorkspace } from '../attention/useAttention';
import { MessageComposer } from '../control/MessageComposer';
import { useSessionControl } from '../control/useSessionControl';
import { ActivityGroup } from '../session/ActivityGroup';
import { groupTimelineEvents, mergeSessionPage } from '../session/session-model';
import { useSessionActions } from '../session/useSessionActions';
import { UsageDialog } from '../usage/UsageDialog';
import { OverviewNewSession } from './OverviewNewSession';
import { SessionPickerDialog } from './SessionPickerDialog';
import type { WorkspaceSession } from './session-list-model';

type RunningTask = {
  workspace: ManagedWorkspace;
  session: Pick<AttentionSession, 'id' | 'updatedAt'> &
    Partial<Pick<AttentionSession, 'title' | 'project' | 'status'>>;
};

export function runningTasks(groups: AttentionWorkspace[]): RunningTask[] {
  return groups
    .flatMap(({ workspace, snapshot, fresh }) => {
      if (!fresh || !snapshot) return [];
      const pending = new Set([
        ...snapshot.approvals.requests.map((request) => request.threadId),
        ...(snapshot.questions ?? []).map((request) => request.session.id),
      ]);
      return snapshot.running
        .filter((session) => !pending.has(session.id))
        .map((session) => ({ workspace, session }));
    })
    .sort((left, right) => right.session.updatedAt - left.session.updatedAt);
}

export function RunningOverviewDialog({
  user,
  groups,
  workspaceId,
  onRefresh,
  onManageWorkspaces,
}: {
  user: User;
  groups: AttentionWorkspace[];
  workspaceId: string;
  onRefresh: () => void;
  onManageWorkspaces?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="running-overview-dialog"
      aria-labelledby="running-overview-heading"
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        closeOverview();
      }}
    >
      <RunningOverview
        key={user.id}
        user={user}
        running={runningTasks(groups)}
        groups={groups}
        workspaceId={workspaceId}
        unavailable={groups.filter(({ fresh }) => !fresh).map(({ workspace }) => workspace.name)}
        onRefresh={onRefresh}
        onManageWorkspaces={onManageWorkspaces}
        onClose={closeOverview}
        onOpenSession={(targetWorkspaceId, sessionId) => {
          const params = new URLSearchParams(location.search);
          if (workspaceId === targetWorkspaceId && params.get('session') === sessionId) {
            closeOverview();
          } else {
            navigateWorkspace(targetWorkspaceId, sessionId, new URLSearchParams({ view: 'all' }));
          }
        }}
      />
    </dialog>
  );
}

const taskKey = ({ workspace, session }: RunningTask) => JSON.stringify([workspace.id, session.id]);
const gap = 12;
const paneMinWidth = 340;
const paneMinHeight = 280;
const pagerHeight = 40;
const dragThreshold = 6;

function readTaskOrder(storageKey: string): string[] {
  try {
    const order: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(order) ? order.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function taskAtPointer(event: PointerEvent<HTMLDivElement>) {
  const pane = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLElement>('[data-overview-task]');
  return pane && event.currentTarget.contains(pane) ? pane.dataset.overviewTask : undefined;
}

type PaneReorder = {
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

function RunningOverview({
  user,
  running,
  groups,
  workspaceId,
  unavailable,
  onClose,
  onOpenSession,
  onRefresh,
  onManageWorkspaces,
}: {
  user: User;
  running: RunningTask[];
  groups: AttentionWorkspace[];
  workspaceId: string;
  unavailable: string[];
  onClose: () => void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onRefresh: () => void;
  onManageWorkspaces?: () => void;
}) {
  const storageKey = `codex-monitor.overview-order.v1.${user.id}`;
  const [trackedTasks, setTrackedTasks] = useState(running);
  const [preferredOrder, setPreferredOrder] = useState(() => readTaskOrder(storageKey));
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  const [overlay, setOverlay] = useState<'new' | 'history' | 'usage'>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [notice, setNotice] = useState('');
  const [sortStatus, setSortStatus] = useState('');
  const [dragging, setDragging] = useState<{ source: string; target?: string }>();
  const { copied } = useSessionActions(setNotice);
  const area = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const press = useRef<{ key: string; pointerId: number; x: number; y: number }>(null);
  const restoreFocus = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTrackedTasks((previous) => {
      const known = new Set(previous.map(taskKey));
      const added = running.filter((task) => !known.has(taskKey(task)));
      return added.length ? [...previous, ...added] : previous;
    });
  }, [running]);
  useLayoutEffect(() => {
    const element = area.current!;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    restoreFocus.current?.focus({ preventScroll: true });
    restoreFocus.current = null;
  }, [preferredOrder]);

  const tasks = useMemo(() => {
    const rank = new Map(preferredOrder.map((key, index) => [key, index]));
    const position = (task: RunningTask) => rank.get(taskKey(task)) ?? preferredOrder.length;
    return [...trackedTasks].sort((left, right) => position(left) - position(right));
  }, [trackedTasks, preferredOrder]);
  const current = new Map(running.map((item) => [taskKey(item), item]));
  const observations = new Map(groups.map((group) => [group.workspace.id, group]));
  const activeWorkspace = observations.get(workspaceId)?.workspace;
  const maxColumns = Math.max(1, Math.floor((size.width + gap) / (paneMinWidth + gap)));
  const rowsFor = (height: number) =>
    Math.max(1, Math.floor((height + gap) / (paneMinHeight + gap)));
  const targetColumns = tasks.length === 4 && rowsFor(size.height) >= 2 ? 2 : 3;
  const columns = Math.min(maxColumns, targetColumns);
  const needsPages = tasks.length > columns * rowsFor(size.height);
  const pageSize = columns * rowsFor(size.height - (needsPages ? pagerHeight : 0));
  const pageCount = Math.max(1, Math.ceil(tasks.length / pageSize));
  const activePage = Math.min(page, pageCount - 1);
  const start = activePage * pageSize;
  const visible = tasks.slice(start, start + pageSize);
  const expandedTask = tasks.find((task) => taskKey(task) === expanded);
  // Keep the current page mounted when a pane is enlarged so its draft and history stay in place.
  const mounted =
    expandedTask && !visible.includes(expandedTask) ? [...visible, expandedTask] : visible;
  const gridColumns = expandedTask ? 1 : Math.max(1, Math.min(visible.length, columns));

  useEffect(() => {
    if (page !== activePage) setPage(activePage);
  }, [page, activePage]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  function showTask(task: RunningTask) {
    const key = taskKey(task);
    setTrackedTasks((previous) =>
      previous.some((item) => taskKey(item) === key) ? previous : [...previous, task],
    );
    setPreferredOrder((previous) => [key, ...previous.filter((item) => item !== key)]);
    setExpanded(undefined);
    setPage(0);
  }

  function moveTask(source: string, target: string, focusedHandle?: HTMLButtonElement) {
    const order = tasks.map(taskKey);
    const from = order.indexOf(source);
    const to = order.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;

    order.splice(from, 1);
    order.splice(to, 0, source);
    restoreFocus.current = focusedHandle ?? null;
    setPreferredOrder(order);
    const title = (current.get(source) ?? tasks[from]).session.title;
    setSortStatus(`${title || '会话'}已移动到第 ${to + 1} 位`);
    try {
      localStorage.setItem(storageKey, JSON.stringify(order));
    } catch {
      // Reordering still works during this visit when browser storage is unavailable.
    }
  }

  function cancelDrag() {
    press.current = null;
    setDragging(undefined);
  }

  function dragTarget(event: PointerEvent<HTMLDivElement>) {
    const target = taskAtPointer(event);
    const source = press.current?.key;
    return !expandedTask &&
      target !== source &&
      visible.some((task) => taskKey(task) === source) &&
      visible.some((task) => taskKey(task) === target)
      ? target
      : undefined;
  }

  function crossedDragThreshold(event: PointerEvent<HTMLDivElement>) {
    const origin = press.current;
    return (
      !!origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= dragThreshold
    );
  }

  function showCreatedSession(workspace: ManagedWorkspace, sessionId: string) {
    showTask({ workspace, session: { id: sessionId, updatedAt: Date.now() } });
    onRefresh();
  }

  function showHistorySession(session: WorkspaceSession) {
    const workspace = observations.get(session.workspaceId)?.workspace;
    if (!workspace?.online) return;
    showTask({ workspace, session });
    setOverlay(undefined);
  }

  return (
    <div
      className="running-overview"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && press.current) {
          event.preventDefault();
          cancelDrag();
          return;
        }
        if (
          event.key === 'Escape' &&
          !event.nativeEvent.isComposing &&
          expandedTask &&
          !event.currentTarget.querySelector(':popover-open')
        ) {
          event.preventDefault();
          setExpanded(undefined);
        }
      }}
    >
      <header className="running-overview-header">
        <h2 id="running-overview-heading">
          <LayoutGrid size={19} aria-hidden="true" />
          任务全览
        </h2>
        <div className="running-overview-scope">
          <span>全部工作空间</span>
          <span>{running.length} 个运行中</span>
        </div>
        <div className="running-overview-actions">
          {onManageWorkspaces && (
            <button
              type="button"
              className="secondary"
              aria-haspopup="dialog"
              onClick={onManageWorkspaces}
            >
              <Monitor size={16} aria-hidden="true" />
              工作空间
            </button>
          )}
          <button
            type="button"
            className="secondary"
            aria-haspopup="dialog"
            disabled={!activeWorkspace}
            onClick={() => setOverlay('usage')}
          >
            <Activity size={16} aria-hidden="true" />
            用量统计
          </button>
          {user.role === 'admin' && (
            <>
              <button
                type="button"
                className="secondary"
                aria-haspopup="dialog"
                onClick={() => setOverlay('history')}
              >
                <History size={16} aria-hidden="true" />
                继续历史会话
              </button>
              <button
                type="button"
                className="primary"
                aria-haspopup="dialog"
                onClick={() => setOverlay('new')}
              >
                <SquarePen size={16} aria-hidden="true" />
                新建会话
              </button>
            </>
          )}
          <button autoFocus type="button" className="secondary" onClick={onClose}>
            <X size={16} aria-hidden="true" />
            退出全览
          </button>
        </div>
      </header>
      {!!unavailable.length && (
        <p className="running-overview-warning" role="status">
          未同步：{unavailable.join('、')}
        </p>
      )}
      <div className="running-overview-area" ref={area}>
        {tasks.length ? (
          <div
            className="running-overview-grid"
            ref={grid}
            data-dragging={dragging ? '' : undefined}
            onPointerMove={(event) => {
              const origin = press.current;
              if (
                origin?.pointerId !== event.pointerId ||
                (!dragging && !crossedDragThreshold(event))
              )
                return;
              const target = dragTarget(event);
              setDragging((previous) =>
                previous?.source === origin.key && previous.target === target
                  ? previous
                  : { source: origin.key, target },
              );
            }}
            onPointerUp={(event) => {
              const origin = press.current;
              if (origin?.pointerId !== event.pointerId) return;
              const target = crossedDragThreshold(event) ? dragTarget(event) : undefined;
              cancelDrag();
              if (target) moveTask(origin.key, target);
            }}
            onLostPointerCapture={(event) => {
              if (press.current?.pointerId === event.pointerId) cancelDrag();
            }}
            onPointerCancel={(event) => {
              if (press.current?.pointerId === event.pointerId) cancelDrag();
            }}
            style={{
              gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${expandedTask ? 1 : Math.ceil(visible.length / gridColumns)}, minmax(0, 1fr))`,
            }}
          >
            {mounted.map((saved, index) => {
              const key = taskKey(saved);
              const task = current.get(key) || saved;
              const observation = observations.get(task.workspace.id);
              const session = task.session;
              return (
                <OverviewPane
                  key={key}
                  user={user}
                  task={task}
                  workspaceName={observation?.workspace.name || task.workspace.name}
                  online={!!observation?.workspace.online}
                  dismissible={!!observation?.fresh && !current.has(key)}
                  hidden={!!expandedTask && expanded !== key}
                  expanded={expanded === key}
                  dragState={
                    dragging?.source === key
                      ? 'source'
                      : dragging?.target === key
                        ? 'target'
                        : undefined
                  }
                  reorder={
                    expandedTask || visible.length < 2
                      ? undefined
                      : {
                          onPointerDown: (event) => {
                            if (!event.isPrimary || event.button !== 0 || press.current) return;
                            grid.current?.setPointerCapture(event.pointerId);
                            press.current = {
                              key,
                              pointerId: event.pointerId,
                              x: event.clientX,
                              y: event.clientY,
                            };
                          },
                          onKeyDown: (event) => {
                            const offset = {
                              ArrowLeft: -1,
                              ArrowRight: 1,
                              ArrowUp: -gridColumns,
                              ArrowDown: gridColumns,
                            }[event.key];
                            if (!offset || event.altKey || event.ctrlKey || event.metaKey) return;
                            event.preventDefault();
                            const target = visible[index + offset];
                            if (target) moveTask(key, taskKey(target), event.currentTarget);
                          },
                        }
                  }
                  onCopy={copied}
                  onExpand={() => setExpanded(expanded === key ? undefined : key)}
                  onOpen={() => onOpenSession(task.workspace.id, session.id)}
                  onDismiss={() => {
                    setTrackedTasks((previous) => previous.filter((item) => taskKey(item) !== key));
                    if (expanded === key) setExpanded(undefined);
                  }}
                />
              );
            })}
          </div>
        ) : (
          <div className="running-overview-empty">已同步的工作空间中暂无运行中的会话。</div>
        )}
        {pageCount > 1 && !expandedTask && (
          <footer className="running-overview-pager">
            <button
              type="button"
              className="icon-button"
              aria-label="上一页"
              disabled={!activePage}
              onClick={() => setPage(activePage - 1)}
            >
              <ChevronLeft size={17} />
            </button>
            <span aria-live="polite">
              {start + 1}–{start + visible.length} / {tasks.length} 个会话
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="下一页"
              disabled={activePage === pageCount - 1}
              onClick={() => setPage(activePage + 1)}
            >
              <ChevronRight size={17} />
            </button>
          </footer>
        )}
      </div>
      <div className="running-overview-sort-status" role="status">
        {sortStatus}
      </div>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
      {overlay === 'usage' && activeWorkspace && (
        <UsageDialog
          key={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          onClose={() => setOverlay(undefined)}
          onSession={(id) => onOpenSession(activeWorkspace.id, id)}
        />
      )}
      {overlay === 'new' && (
        <OverviewNewSession
          user={user}
          workspaceId={workspaceId}
          groups={groups}
          onClose={() => setOverlay(undefined)}
          onCreated={showCreatedSession}
        />
      )}
      {overlay === 'history' && (
        <SessionPickerDialog
          mode="history"
          workspaces={groups.map(({ workspace }) => workspace)}
          portalContainer={area.current?.closest('dialog') ?? undefined}
          onSelect={showHistorySession}
          onClose={() => setOverlay(undefined)}
        />
      )}
    </div>
  );
}

const pageLimit = 40;
const Message = memo(
  function OverviewMessage({ event }: { event: TimelineEvent }) {
    return (
      <article
        className={
          event.kind === 'user' ? 'overview-message overview-user-message' : 'overview-message'
        }
      >
        <header>
          <strong>
            {event.kind === 'user' ? '你' : event.kind === 'plan' ? '执行计划' : 'Codex'}
          </strong>
          {event.phase === 'commentary' && <span>进展更新</span>}
          <time>{time(event.timestamp)}</time>
        </header>
        <Markdown text={event.text} />
      </article>
    );
  },
  (previous, next) =>
    previous.event.id === next.event.id &&
    previous.event.text === next.event.text &&
    previous.event.kind === next.event.kind &&
    previous.event.phase === next.event.phase &&
    previous.event.timestamp === next.event.timestamp,
);

function OverviewPane({
  user,
  task: { workspace, session },
  workspaceName,
  online,
  dismissible,
  hidden,
  expanded,
  dragState,
  reorder,
  onCopy,
  onExpand,
  onOpen,
  onDismiss,
}: {
  user: User;
  task: RunningTask;
  workspaceName: string;
  online: boolean;
  dismissible: boolean;
  hidden: boolean;
  expanded: boolean;
  dragState?: 'source' | 'target';
  reorder?: PaneReorder;
  onCopy: (text: string) => void;
  onExpand: () => void;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const [page, setPage] = useState<SessionPage>();
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(true);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const pane = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const previousTop = useRef(0);
  const hasHistory = useRef(false);
  const olderPosition = useRef<{
    before: number;
    anchor?: HTMLElement;
    offset: number;
    height: number;
    top: number;
  } | null>(null);
  const loader = useMemo(
    () =>
      new DetailLoader(
        {
          onPage: (data, older) => {
            if (older) hasHistory.current = true;
            const preserveHistory = hasHistory.current || olderPosition.current !== null;
            setPage((current) => (preserveHistory ? mergeSessionPage(current, data, older) : data));
            setError('');
          },
          onError: (_, failure, older) => {
            if (older) setOlderFailed(true);
            setError(failure.message);
          },
          onSettled: () => {},
        },
        workspace.id,
      ),
    [workspace.id],
  );
  const sessionId = session.id;
  const status = page?.session.status || session.status;
  const canWrite = user.role === 'admin';
  const control = useSessionControl(
    canWrite && online && !hidden ? sessionId : undefined,
    status,
    workspace.id,
  );

  useEffect(() => {
    if (hidden || !online) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const refresh = async () => {
      if (!document.hidden) await loader.load(sessionId, false, undefined, pageLimit);
      if (!stopped) timer = setTimeout(() => void refresh(), 1500);
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      loader.cancel();
    };
  }, [hidden, loader, online, sessionId]);

  function rememberPosition(element: HTMLDivElement, before: number) {
    const edge = element.getBoundingClientRect().top;
    const anchor = Array.from(
      element.querySelectorAll<HTMLElement>(':scope > .overview-message, :scope > .activity-group'),
    ).find((block) => block.getBoundingClientRect().bottom > edge);
    olderPosition.current = {
      before,
      anchor,
      offset: anchor ? anchor.getBoundingClientRect().top - edge : 0,
      height: element.scrollHeight,
      top: element.scrollTop,
    };
  }

  async function loadOlder() {
    const element = scroll.current;
    if (!element || hidden || !online || page?.before == null || olderBusy || olderPosition.current)
      return;
    rememberPosition(element, page.before);
    setFollow(false);
    setOlderFailed(false);
    setOlderBusy(true);
    await loader.load(sessionId, true, page.before, pageLimit);
    setOlderBusy(false);
  }

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const position = olderPosition.current;
    if (position && page?.before !== position.before) {
      if (!follow && !hidden) {
        element.scrollTop = position.anchor?.isConnected
          ? element.scrollTop +
            position.anchor.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            position.offset
          : position.top + element.scrollHeight - position.height;
        previousTop.current = element.scrollTop;
      }
      olderPosition.current = null;
    } else if (position && !olderBusy) {
      olderPosition.current = null;
    }
    if (follow && !hidden) {
      element.scrollTop = element.scrollHeight;
      previousTop.current = element.scrollTop;
    }
  }, [page, expanded, follow, hidden, olderBusy]);

  useEffect(() => {
    const element = scroll.current;
    if (
      element?.clientHeight &&
      !olderFailed &&
      (element.scrollHeight <= element.clientHeight || (!follow && element.scrollTop <= 80))
    )
      void loadOlder();
  }, [page, expanded, follow, hidden, online, olderBusy, olderFailed]);

  const title =
    session.title || page?.session.title || (page || session.status ? '未命名会话' : '新会话');
  const project = session.project || page?.session.project;
  const location = project ? `${workspaceName} · ${project}` : workspaceName;
  const updatedAt = Math.max(session.updatedAt, page?.session.updatedAt ?? 0);
  const lastActiveAt = page?.events.reduce(
    (latest, event) => Math.max(latest, event.timestamp),
    updatedAt,
  ) ?? updatedAt;
  const lastActive = new Date(lastActiveAt);
  const blocks = groupTimelineEvents(
    (page?.events ?? []).filter(
      (event) =>
        event.kind === 'tool' ||
        ((event.kind === 'assistant' || event.kind === 'user' || event.kind === 'plan') &&
          event.text.trim()),
    ),
  );
  return (
    <section
      className="running-overview-pane"
      ref={pane}
      data-overview-task={taskKey({ workspace, session })}
      data-drag-state={dragState}
      aria-label={`${workspaceName} · ${title}`}
      hidden={hidden}
    >
      <header className="running-overview-pane-header">
        {reorder && (
          <button
            type="button"
            className="icon-button running-overview-reorder"
            title="拖拽排序（也可使用方向键）"
            aria-label={`调整 ${title} 的顺序`}
            {...reorder}
          >
            <GripVertical size={16} aria-hidden="true" />
          </button>
        )}
        <div className="running-overview-pane-name">
          <div className="running-overview-pane-title">
            <h3 title={title}>{title}</h3>
            <time
              dateTime={lastActive.toISOString()}
              title={`最后活跃时间：${lastActive.toLocaleString('zh-CN')}`}
            >
              {relative(lastActiveAt)}
            </time>
          </div>
          <span title={location}>{location}</span>
        </div>
        {online ? status && <Status status={status} /> : <span className="muted">离线</span>}
        <button
          type="button"
          className="icon-button"
          title={expanded ? '恢复分屏' : '放大此会话'}
          aria-label={expanded ? '恢复分屏' : '放大此会话'}
          onClick={onExpand}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          className="icon-button"
          title="打开会话详情"
          aria-label="打开会话详情"
          onClick={onOpen}
        >
          <ArrowUpRight size={16} />
        </button>
        {dismissible && (session.status || (page && status !== 'running')) && (
          <button
            type="button"
            className="icon-button"
            title="移出全览"
            aria-label="移出全览"
            onClick={onDismiss}
          >
            <X size={16} />
          </button>
        )}
      </header>
      <div className="running-overview-reader">
        <div
          className="running-overview-output"
          ref={scroll}
          role="region"
          aria-label="会话输出"
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            const top = element.scrollTop;
            if (!element.clientHeight || top === previousTop.current) return;
            const upward = top < previousTop.current;
            previousTop.current = top;
            if (olderPosition.current) rememberPosition(element, olderPosition.current.before);
            if (upward && top <= 80 && page?.before != null) {
              setFollow(false);
              if (!olderFailed) void loadOlder();
            } else {
              setFollow(element.scrollHeight - top - element.clientHeight < 24);
            }
          }}
          onToggle={(event) => {
            if (event.target instanceof HTMLDetailsElement && event.target.open) setFollow(false);
          }}
        >
          {page?.before != null && online && (
            <button
              type="button"
              className="load-earlier"
              disabled={olderBusy}
              aria-busy={olderBusy}
              onClick={() => void loadOlder()}
            >
              {olderBusy ? <LoaderCircle className="spin" size={14} /> : <Clock size={14} />}
              {olderBusy
                ? '正在加载更早的记录…'
                : olderFailed
                  ? '重试加载更早的记录'
                  : '加载更早的记录'}
            </button>
          )}
          {blocks.map((block) =>
            block.kind === 'event' ? (
              <Message key={block.id} event={block.event} />
            ) : (
              <ActivityGroup
                key={block.id}
                events={block.events}
                onCopy={onCopy}
                anchorEvents={false}
              />
            ),
          )}
          {error || !online ? (
            <p className="running-overview-pane-note" role="status">
              {online ? error : '工作空间已离线，等待重新连接。'}
            </p>
          ) : !page ? (
            <p className="running-overview-pane-note" role="status">
              <LoaderCircle size={15} className="spin" />
              正在读取会话…
            </p>
          ) : status === 'running' ? (
            <p className="running-overview-pane-note">Codex 正在工作</p>
          ) : blocks.length === 0 ? (
            <p className="running-overview-pane-note">暂无会话输出</p>
          ) : null}
        </div>
        {!follow && (
          <button
            type="button"
            className="secondary running-overview-latest"
            onClick={() => setFollow(true)}
          >
            <ArrowDown size={14} />
            最新输出
          </button>
        )}
      </div>
      {canWrite && (
        <MessageComposer
          user={user}
          threadId={sessionId}
          workspaceId={workspace.id}
          control={control}
          context={page?.context}
          overview={{
            title: `${workspaceName} · ${title}`,
            inputLabel: `向 ${title} 发送消息`,
            online,
            hidden,
            anchor: pane,
          }}
          onAccepted={() => setFollow(true)}
        />
      )}
    </section>
  );
}
