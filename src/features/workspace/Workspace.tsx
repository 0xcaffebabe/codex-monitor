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
import { NewSessionDialog } from '../control/NewSessionDialog';
import { Detail } from '../session/SessionDetail';
import { Settings } from '../settings/Settings';
import { UsageDashboard } from '../usage/UsageDashboard';
import { OverviewCards } from './OverviewCards';
import { RunningSwitcher } from './RunningSwitcher';
import { SessionPanel } from './SessionPanel';
import { Sidebar } from './Sidebar';
import { useWorkspace, WorkspaceProps } from './useWorkspace';
import { useDesktopLayout } from './useDesktopLayout';

export function Workspace(props: WorkspaceProps) {
  const { user } = props;
  const model = useWorkspace();
  const {
    overview,
    runningSessions,
    setSidebarView,
    tab,
    setTab,
    setQ,
    setQuery,
    project,
    setProject,
    selected,
    setSelected,
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
    setCreating,
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
  const layout = useDesktopLayout(selected, model.searchRef);
  return (
    <div
      className={cx(
        'app-shell',
        !!selected && 'has-detail',
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
            {selected && (
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
            <strong>{selected ? '会话详情' : title}</strong>
          </div>
          <div className="desktop-only desktop-layout-actions">
            {selected && (
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
        {tab === 'usage' && !selected ? (
          <UsageDashboard
            onSession={(id) => {
              setTab('all');
              select(id);
            }}
            revision={usageRevision}
          />
        ) : (
          <>
            {!selected && <OverviewCards title={title} overview={overview} changeTab={changeTab} />}
            {overview?.source.warnings.map((w) => (
              <div key={w} className="alert warning source-warning">
                <TriangleAlert size={16} />
                {w}
              </div>
            ))}
            <div className={cx('content', !!selected && 'split')}>
              {selected && layout.sessionDrawerOpen && (
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
              {selected && (
                <Detail
                  user={user}
                  onMessageSent={() => {
                    void loadList(false, true);
                    void loadOverview();
                    if (selected) {
                      void loadDetail(selected);
                      void loadOutline(selected);
                    }
                  }}
                  page={page}
                  outlineData={outlineData}
                  outlineError={outlineError}
                  onOutlineEntry={loadOutlineEntry}
                  loading={detailBusy}
                  syncing={detailSyncing}
                  error={detailError}
                  onBack={() => setSelected(undefined)}
                  onRetry={() => void loadDetail(selected)}
                  onOlder={() => loadDetail(selected, true, page?.before ?? undefined)}
                  notify={notify}
                  connected={connected}
                  focusMode={layout.focusMode}
                  onExitFocus={layout.exitFocus}
                />
              )}
            </div>
            {!selected && (
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
        <RunningSwitcher sessions={runningSessions} selected={selected} onSelect={select} />
      )}
      {settings && (
        <Settings
          user={user}
          overview={overview}
          onClose={() => setSettings(false)}
          notify={notify}
        />
      )}
      {creating && (
        <NewSessionDialog
          user={user}
          initialPath={project}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
            setTab('all');
            setQ('');
            setQuery('');
            setProject('');
            void loadList(false, true);
            void loadOverview();
            notify('新会话已创建并发送');
          }}
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
