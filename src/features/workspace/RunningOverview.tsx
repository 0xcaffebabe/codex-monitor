import {
  ArrowDown,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AttentionSession } from '../../attention-types';
import { DetailLoader } from '../../detail-loader';
import { relative, time } from '../../shared/format';
import { Markdown } from '../../shared/ui/Markdown';
import { Status } from '../../shared/ui/Status';
import type { SessionPage, TimelineEvent, User } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';
import type { AttentionWorkspace } from '../attention/useAttention';
import { MessageComposer } from '../control/MessageComposer';
import { useSessionControl } from '../control/useSessionControl';
import { ActivityGroup } from '../session/ActivityGroup';
import { groupTimelineEvents } from '../session/session-model';
import { useSessionActions } from '../session/useSessionActions';

type RunningTask = { workspace: ManagedWorkspace; session: AttentionSession };
const taskKey = ({ workspace, session }: RunningTask) => JSON.stringify([workspace.id, session.id]);
const gap = 12;
const paneMinWidth = 340;
const paneMinHeight = 280;
const pagerHeight = 40;

export function RunningOverview({
  user,
  running,
  groups,
  unavailable,
  onClose,
  onOpenSession,
}: {
  user: User;
  running: RunningTask[];
  groups: AttentionWorkspace[];
  unavailable: string[];
  onClose: () => void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
}) {
  const [tasks, setTasks] = useState(running);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [notice, setNotice] = useState('');
  const { copied } = useSessionActions(setNotice);
  const area = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTasks((previous) => {
      const known = new Set(previous.map(taskKey));
      const added = running.filter((task) => !known.has(taskKey(task)));
      return added.length ? [...previous, ...added] : previous;
    });
  }, [running]);
  useLayoutEffect(() => {
    closeButton.current?.focus();
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

  const current = new Map(running.map((item) => [taskKey(item), item]));
  const observations = new Map(groups.map((group) => [group.workspace.id, group]));
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

  return (
    <div
      className="running-overview"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && expandedTask) {
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
        <button ref={closeButton} type="button" className="secondary" onClick={onClose}>
          <X size={16} aria-hidden="true" />
          退出全览
        </button>
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
            style={{
              gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${expandedTask ? 1 : Math.ceil(visible.length / gridColumns)}, minmax(0, 1fr))`,
            }}
          >
            {mounted.map((saved) => {
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
                  onCopy={copied}
                  onExpand={() => setExpanded(expanded === key ? undefined : key)}
                  onOpen={() => onOpenSession(task.workspace.id, session.id)}
                  onDismiss={() => {
                    setTasks((previous) => previous.filter((item) => taskKey(item) !== key));
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
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
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
  onCopy: (text: string) => void;
  onExpand: () => void;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const [page, setPage] = useState<SessionPage>();
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const loader = useMemo(
    () =>
      new DetailLoader(
        {
          onPage: (data) => {
            setPage(data);
            setError('');
          },
          onError: (_, failure) => setError(failure.message),
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

  useLayoutEffect(() => {
    if (follow && !hidden && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [page, expanded, follow, hidden]);

  const title = session.title || page?.session.title || '未命名会话';
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
      aria-label={`${workspaceName} · ${title}`}
      hidden={hidden}
    >
      <header className="running-overview-pane-header">
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
          <span title={`${workspaceName} · ${session.project}`}>
            {workspaceName} · {session.project}
          </span>
        </div>
        {online ? <Status status={status} /> : <span className="muted">离线</span>}
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
        {dismissible && (
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
            if (!element.clientHeight) return;
            setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
          }}
          onToggle={(event) => {
            if (event.target instanceof HTMLDetailsElement && event.target.open) setFollow(false);
          }}
        >
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
          overview={{ title: `${workspaceName} · ${title}`, inputLabel: `向 ${title} 发送消息`, online, hidden }}
          onAccepted={() => setFollow(true)}
        />
      )}
    </section>
  );
}
