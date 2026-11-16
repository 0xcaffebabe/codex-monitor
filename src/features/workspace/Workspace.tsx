import {
  Check,
  ChevronRight,
  Maximize2,
  Menu,
  Minimize2,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsLeftBottom,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import { cx } from '../../shared/format';
import { Detail } from '../session/SessionDetail';
import { Settings } from '../settings/Settings';
import { UsageDashboard } from '../usage/UsageDashboard';
import { OverviewCards } from './OverviewCards';
import { RunningSwitcher } from './RunningSwitcher';
import { SessionPanel } from './SessionPanel';
import { Sidebar } from './Sidebar';
import { useWorkspace, WorkspaceProps } from './useWorkspace';
import { useDesktopLayout } from './useDesktopLayout';
import type { RunningWorkspace } from '../workspaces/useRunningSessions';
import { navigateWorkspace } from '../../workspace-scope';
import type { ManagedWorkspace } from '../../workspaces';

export function Workspace(
  props: WorkspaceProps & {
    workspaceId: string;
    workspaces: ManagedWorkspace[];
    runningWorkspaces: RunningWorkspace[];
  },
) {
  const { user } = props;
  const model = useWorkspace(props.workspaceId, props.workspaces);
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
    closeDetail,
    usageRevision,
    setUsageRevision,
    toast,
    notify,
    loadList,
    loadOverview,
    loadDetail,
    loadOutline,
    loadOutlineEntry,
    select,
    changeTab,
    title,
  } = model;
  const hasDetail = !!selected || creating;
  const layout = useDesktopLayout(creating ? 'new' : selected, model.searchRef);
  return (
    <div
      className={cx(
        'app-shell',
        !hasDetail && !!q.trim() && 'searching-sessions',
        hasDetail && 'has-detail',
        layout.navigationCollapsed && 'navigation-collapsed',
        !layout.sessionsVisible && 'sessions-collapsed',
        layout.focusMode && 'focus-mode',
      )}
    >
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <Sidebar {...props} model={model} />
      <main className="main">
        <header className="topbar">
          <div className="desktop-only desktop-panel-controls">
            <button
              className="icon-button"
              title={layout.navigationCollapsed || layout.focusMode ? '展开导航' : '折叠导航'}
              aria-label="切换导航"
              aria-expanded={!layout.navigationCollapsed && !layout.focusMode}
              aria-controls="workspace-navigation"
              onClick={layout.toggleNavigation}
            >
              {layout.navigationCollapsed || layout.focusMode ? (
                <PanelLeftOpen size={18} />
              ) : (
                <PanelLeftClose size={18} />
              )}
            </button>
            {hasDetail && (
              <button
                className={cx(
                  'icon-button',
                  layout.sessionsVisible && !layout.focusMode && 'active',
                )}
                title={
                  layout.sessionsVisible && !layout.focusMode ? '收起会话列表' : '展开会话列表'
                }
                aria-label="切换会话列表"
                aria-expanded={layout.sessionsVisible && !layout.focusMode}
                aria-controls="workspace-sessions"
                onClick={layout.toggleSessions}
              >
                <PanelsLeftBottom size={18} />
              </button>
            )}
          </div>
          <button
            className="icon-button mobile-only"
            title="打开菜单"
            onClick={() => {
              setSidebarView('recent');
              setMenu(true);
            }}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            <Monitor size={16} />
            {props.workspaceControls || <span>工作空间</span>}
            <ChevronRight size={13} />
            <strong>{creating ? '新建会话' : selected ? '会话详情' : title}</strong>
          </div>
          <div className="desktop-only desktop-layout-actions">
            {hasDetail && (
              <button
                className={cx('layout-focus-button', layout.focusMode && 'active')}
                title={layout.focusMode ? '退出专注模式（Esc）' : '专注模式'}
                aria-pressed={layout.focusMode}
                onClick={layout.toggleFocus}
              >
                {layout.focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                <span>{layout.focusMode ? '退出专注' : '专注模式'}</span>
              </button>
            )}
            <button className="icon-button" title="恢复自动布局" onClick={layout.reset}>
              <RotateCcw size={15} />
            </button>
          </div>
          <div className={cx('connection', connected && 'connected')}>
            <span />
            {connected ? '实时同步' : '正在连接'}
            <span className="connection-interval">· 1.5s</span>
          </div>
          <button
            className="icon-button"
            title="刷新数据"
            onClick={() => {
              void loadList(false, true);
              void loadOverview();
              setUsageRevision((v) => v + 1);
              if (selected) void loadDetail(selected);
              notify('数据已刷新');
            }}
          >
            <RefreshCw size={16} />
          </button>
        </header>
        {props.workspaceNotice && (
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
          />
        ) : (
          <>
            {!hasDetail && (
              <OverviewCards title={title} overview={overview} changeTab={changeTab} />
            )}
            {overview?.source.warnings.map((w) => (
              <div key={w} className="alert warning source-warning">
                <TriangleAlert size={16} />
                {w}
              </div>
            ))}
            <div className={cx('content', hasDetail && 'split')}>
              {hasDetail && layout.sessionDrawerOpen && (
                <button
                  className="session-list-backdrop desktop-only"
                  aria-label="关闭会话列表"
                  onClick={layout.closeSessionDrawer}
                />
              )}
              <SessionPanel
                user={user}
                model={model}
                onSessionSelected={layout.closeSessionDrawer}
              />
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
                  focusMode={layout.focusMode}
                  onExitFocus={layout.exitFocus}
                />
              )}
            </div>
            {!hasDetail && (
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
      {!menu && !settings && (
        <RunningSwitcher
          workspaces={props.runningWorkspaces}
          activeWorkspaceId={props.workspaceId}
          selected={selected}
          onSelect={(workspaceId, sessionId) => {
            if (workspaceId === props.workspaceId) select(sessionId);
            else navigateWorkspace(workspaceId, sessionId);
          }}
        />
      )}
      {settings && (
        <Settings
          user={user}
          overview={overview}
          onClose={() => setSettings(false)}
          notify={notify}
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
