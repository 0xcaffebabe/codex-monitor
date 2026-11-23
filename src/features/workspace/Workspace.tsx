import {
  Check,
  ChevronRight,
  Menu,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsLeftBottom,
  RefreshCw,
  RotateCcw,
  SquarePen,
  TriangleAlert,
} from 'lucide-react';
import { cx } from '../../shared/format';
import { useMediaQuery } from '../../shared/useMediaQuery';
import { Detail } from '../session/SessionDetail';
import { Settings } from '../settings/Settings';
import { UsageDashboard } from '../usage/UsageDashboard';
import { AttentionBoard } from '../attention/AttentionBoard';
import { SessionPanel } from './SessionPanel';
import { TaskDock } from './TaskDock';
import { Sidebar } from './Sidebar';
import { useWorkspace, WorkspaceProps } from './useWorkspace';
import { useDesktopLayout } from './useDesktopLayout';
import type { useAttention } from '../attention/useAttention';
import type { useTaskWatches } from '../attention/useTaskWatches';
import { navigateWorkspace } from '../../workspace-scope';
import type { ManagedWorkspace } from '../../workspaces';

export function Workspace(
  props: WorkspaceProps & {
    workspaceId: string;
    workspaces: ManagedWorkspace[];
    attention: ReturnType<typeof useAttention>;
    taskWatches: ReturnType<typeof useTaskWatches>;
  },
) {
  const { user } = props;
  const model = useWorkspace(props.workspaceId, props.workspaces, user.id);
  const {
    overview,
    setSidebarView,
    tab,
    setTab,
    q,
    setQ,
    setQuery,
    project,
    setProject,
    selected,
    page,
    result,
    attentionRequest,
    outlineData,
    outlineError,
    detailBusy,
    detailSyncing,
    detailError,
    connected,
    menu,
    setMenu,
    settings,
    setSettings,
    creating,
    startSession,
    closeDetail,
    usageRevision,
    setUsageRevision,
    toast,
    notify,
    loadList,
    loadOverview,
    loadOverviews,
    loadDetail,
    loadOutline,
    loadOutlineEntry,
    select,
    changeTab,
    title,
  } = model;
  const hasDetail = !!selected || creating;
  const sessionsTab = tab !== 'attention' && tab !== 'usage';
  const mobile = useMediaQuery('(max-width: 760px)');
  const activeObservation = props.attention.groups.find(({ workspace, fresh }) => fresh && workspace.id === props.workspaceId)?.snapshot;
  const watched = props.taskWatches.watches.some((item) => item.workspaceId === props.workspaceId && item.sessionId === selected);
  const layout = useDesktopLayout(creating ? 'new' : selected, model.searchRef);
  return (
    <div
      className={cx(
        'app-shell',
        !hasDetail && !!q.trim() && 'searching-sessions',
        hasDetail && 'has-detail',
        layout.navigationCollapsed && 'navigation-collapsed',
        !layout.sessionsVisible && 'sessions-collapsed',
      )}
    >
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <Sidebar {...props} model={model} collapsed={layout.navigationCollapsed} />
      <main className="main">
        <header className="topbar">
          <div className="desktop-only desktop-panel-controls">
            <button
              className="icon-button"
              title={layout.navigationCollapsed ? '展开导航' : '折叠导航'}
              aria-label="切换导航"
              aria-expanded={!layout.navigationCollapsed}
              aria-controls="workspace-navigation"
              onClick={layout.toggleNavigation}
            >
              {layout.navigationCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
            {hasDetail && (
              <button
                className={cx('icon-button', layout.sessionsVisible && 'active')}
                title={layout.sessionsVisible ? '收起会话列表' : '展开会话列表'}
                aria-label="切换会话列表"
                aria-expanded={layout.sessionsVisible}
                aria-controls="workspace-sessions"
                onClick={layout.toggleSessions}
              >
                <PanelsLeftBottom size={18} />
              </button>
            )}
          </div>
          <div className="mobile-topbar-actions mobile-only">
            <button
              className="icon-button"
              title="打开菜单"
              onClick={() => {
                setSidebarView('recent');
                setMenu(true);
              }}
            >
              <Menu size={21} />
            </button>
            {user.role === 'admin' && !creating && (selected || tab === 'usage') && (
              <button
                className="icon-button new-session-shortcut"
                title="快速新建会话"
                aria-label="快速新建会话"
                onClick={startSession}
              >
                <SquarePen size={20} />
              </button>
            )}
          </div>
          <div className="breadcrumb">
            <Monitor size={16} />
            {props.workspaceControls || <span>工作空间</span>}
            <ChevronRight size={13} />
            <strong>{creating ? '新建会话' : selected ? '会话详情' : title}</strong>
          </div>
          <div className="desktop-only desktop-layout-actions">
            <button className="icon-button" title="恢复自动布局" onClick={layout.reset}>
              <RotateCcw size={15} />
            </button>
          </div>
          {(tab !== 'attention' || hasDetail) && <div
            className={cx('connection', connected && 'connected')}
            title={connected ? '实时同步' : '正在连接'}
          >
            <span aria-hidden="true" />
            <span className="connection-label">{connected ? '实时同步' : '正在连接'}</span>
            <span className="connection-interval">· 1.5s</span>
          </div>}
          <button
            className={cx('icon-button', tab === 'attention' && !hasDetail && 'attention-refresh')}
            title="刷新数据"
            onClick={() => {
              props.attention.refresh();
              void loadList(false, true);
              loadOverviews();
              setUsageRevision((v) => v + 1);
              if (selected) void loadDetail(selected);
            }}
          >
            <RefreshCw size={16} />
          </button>
        </header>
        {props.workspaceNotice && (tab !== 'attention' || hasDetail) && (
          <div className="alert warning workspace-notice" role="status">
            {props.workspaceNotice}
          </div>
        )}
        {tab === 'usage' && !hasDetail ? (
          <UsageDashboard
            key={props.workspaceId}
            onSession={(id) => {
              setTab('all');
              select(id);
            }}
            revision={usageRevision}
            openSub2ApiSettings={user.role === 'admin' ? () => setSettings(true) : undefined}
          />
        ) : (
          <>
            {tab !== 'attention' && overview?.source.warnings.map((w) => (
              <div key={w} className="alert warning source-warning">
                <TriangleAlert size={16} />
                {w}
              </div>
            ))}
            <div className={cx('content', hasDetail && 'split', tab === 'attention' && 'attention-content')}>
              {hasDetail && layout.sessionDrawerOpen && (
                <button
                  className="session-list-backdrop desktop-only"
                  aria-label="关闭会话列表"
                  onClick={layout.closeSessionDrawer}
                />
              )}
              {tab === 'attention' && !hasDetail ? (
                <AttentionBoard {...props.attention} watches={props.taskWatches.watches} user={user} startSession={startSession} />
              ) : (
                <SessionPanel
                  user={user}
                  workspaces={props.workspaces}
                  model={model}
                  mobile={mobile}
                  onSessionSelected={layout.closeSessionDrawer}
                />
              )}
              {hasDetail && (
                <Detail
                  key={`${props.workspaceId}:${creating ? 'new' : 'session'}`}
                  user={user}
                  newSession={
                    creating
                      ? {
                          workspaceId: props.workspaceId,
                          workspaces: props.workspaces,
                          onWorkspaceChange: (id) =>
                            navigateWorkspace(id, undefined, new URLSearchParams({ view: 'new' })),
                          initialPath: project,
                          onCreated: (id) => {
                            select(id);
                            setTab('all');
                            setQ('');
                            setQuery('');
                            setProject('');
                            void loadList(false, true);
                            void loadOverview();
                            notify('新会话已创建并发送');
                          },
                        }
                      : undefined
                  }
                  onMessageSent={() => {
                    void loadList(false, true);
                    void loadOverview();
                    if (selected) {
                      void loadDetail(selected);
                      void loadOutline(selected);
                    }
                  }}
                  page={creating ? undefined : page}
                  outlineData={creating ? undefined : outlineData}
                  outlineError={creating ? '' : outlineError}
                  onOutlineEntry={loadOutlineEntry}
                  loading={!creating && detailBusy}
                  syncing={!creating && detailSyncing}
                  error={creating ? '' : detailError}
                  onBack={closeDetail}
                  onRetry={() => {
                    if (selected) void loadDetail(selected);
                  }}
                  onOlder={() =>
                    selected
                      ? loadDetail(selected, true, page?.before ?? undefined)
                      : Promise.resolve()
                  }
                  notify={notify}
                  connected={connected}
                  result={result}
                  linkedQuestion={attentionRequest ? {
                    workspaceName: props.workspaceName || props.workspaceId,
                    current: activeObservation?.questions?.find((item) => item.id === attentionRequest && item.session.id === selected),
                    observed: Array.isArray(activeObservation?.questions),
                  } : undefined}
                  workspaceName={props.workspaceName}
                  activeSessions={activeObservation && [...activeObservation.running, ...activeObservation.waiting]}
                  taskWatch={selected && props.taskWatches.available && (!page?.session.archived || watched) ? {
                    watched,
                    toggle: () => props.taskWatches.toggle(props.workspaceId, selected, !watched),
                  } : undefined}
                />
              )}
            </div>
            {!hasDetail && tab !== 'attention' && (
              <footer className="workspace-footer">
                <span>
                  CODEX MONITOR <span className="muted">/ 本机会话观测台</span>
                </span>
                <span>
                  <span className="green-dot" />{' '}
                  {connected ? '所有活动持续同步' : '正在恢复实时连接'}
                </span>
              </footer>
            )}
          </>
        )}
      </main>
      <TaskDock
        mobile={mobile}
        groups={props.attention.groups}
        workspaceId={props.workspaceId}
        selected={selected}
        onHome={() => changeTab('attention')}
        home={tab === 'attention' && !hasDetail}
        onSessions={() => {
          if (sessionsTab) closeDetail();
          else changeTab('all');
        }}
        sessions={sessionsTab && !hasDetail}
      />
      {settings && (
        <Settings
          user={user}
          overview={overview}
          onClose={() => setSettings(false)}
          notify={notify}
          onSub2ApiChange={() => setUsageRevision((value) => value + 1)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
