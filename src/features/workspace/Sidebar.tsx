import {
  Activity,
  ArrowUpRight,
  Layers3,
  LoaderCircle,
  LogOut,
  Moon,
  ListTodo,
  Monitor,
  Settings2,
  Sun,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { cx, relative } from '../../shared/format';
import { useMediaQuery } from '../../shared/useMediaQuery';
import { Brand } from '../../shared/ui/Brand';
import { Status } from '../../shared/ui/Status';
import { navigateWorkspace } from '../../workspace-scope';
import type { ManagedWorkspace } from '../../workspaces';
import { SessionScope } from './SessionScope';
import { workspaceSessionKey } from './session-list-model';
import { useSessionList } from './useSessionList';
import type { WorkspaceModel } from './useWorkspace';
import { WorkspaceProps } from './useWorkspace';

export function Sidebar({
  user,
  onLogout,
  dark,
  setDark,
  model,
  workspaces,
}: WorkspaceProps & {
  workspaces: ManagedWorkspace[];
  model: Pick<
    WorkspaceModel,
    | 'overview'
    | 'menu'
    | 'setMenu'
    | 'tab'
    | 'project'
    | 'changeTab'
    | 'sidebarView'
    | 'setSidebarView'
    | 'workspaceId'
    | 'selected'
    | 'setProject'
    | 'setScope'
    | 'setTab'
    | 'closeDetail'
    | 'setSettings'
  >;
}) {
  const {
    overview,
    menu,
    setMenu,
    tab,
    project,
    changeTab,
    sidebarView,
    setSidebarView,
    workspaceId,
    selected,
    setProject,
    setScope,
    setTab,
    closeDetail,
    setSettings,
  } = model;
  const mobile = useMediaQuery('(max-width: 760px)');
  const [recentScope, setRecentScope] = useState('');
  const scope = workspaces.some((workspace) => workspace.id === recentScope) ? recentScope : '';
  const recent = useSessionList({
    query: '',
    project: '',
    tab: 'all',
    archived: 'all',
    subagents: false,
    sort: 'recent',
    pageSize: 40,
    workspaces: scope ? workspaces.filter((workspace) => workspace.id === scope) : workspaces,
    enabled: mobile && menu && sidebarView === 'recent',
  });
  return (
    <aside
      id="workspace-navigation"
      aria-label="工作空间导航"
      className={cx('sidebar', menu && 'open')}
    >
      <div className="sidebar-brand">
        <Brand />
        <button className="icon-button mobile-only" title="关闭菜单" onClick={() => setMenu(false)}>
          <X size={19} />
        </button>
      </div>
      <div className="nav-label">工作空间</div>
      <nav className="workspace-nav">
        <button className={cx('nav-item', tab === 'attention' && 'active')}
          aria-label="任务动态" title="任务动态" onClick={() => changeTab('attention')}>
          <ListTodo size={17} />
          <span className="nav-item-label">任务动态</span>
        </button>
        <button
          className={cx('nav-item', tab === 'all' && !project && 'active')}
          aria-label="全部会话"
          title="全部会话"
          onClick={() => changeTab('all')}
        >
          <Layers3 size={17} />
          <span className="nav-item-label">全部会话</span>
        </button>
        <button
          className={cx('nav-item', tab === 'usage' && 'active')}
          aria-label="用量统计"
          title="用量统计"
          onClick={() => changeTab('usage')}
        >
          <Activity size={17} />
          <span className="nav-item-label">用量统计</span>
        </button>
      </nav>
      <div className={cx('sidebar-browse', sidebarView === 'projects' && 'show-projects')}>
        <div className="sidebar-section-tabs" aria-label="侧栏内容">
          <button
            aria-pressed={sidebarView === 'recent'}
            aria-controls="sidebar-recent-sessions"
            onClick={() => setSidebarView('recent')}
          >
            最近会话
          </button>
          <button
            aria-pressed={sidebarView === 'projects'}
            aria-controls="sidebar-projects"
            onClick={() => setSidebarView('projects')}
          >
            项目
          </button>
        </div>
        {sidebarView === 'recent' && workspaces.length > 1 && (
          <div className="recent-workspace-scope">
            <SessionScope value={scope} onChange={setRecentScope} workspaces={workspaces} label="筛选最近会话工作空间" />
          </div>
        )}
        <nav className="recent-sessions-nav" id="sidebar-recent-sessions" aria-label="最近会话">
          <p className="recent-sessions-hint">按最后活动时间 · 最近 40 条</p>
          {recent.listWarning && <p className="recent-sessions-message" role="status">{recent.listWarning}</p>}
          {recent.listBusy && !recent.sessions.length && (
            <p className="recent-sessions-message">
              <LoaderCircle size={14} className="spin" /> 正在读取最近会话…
            </p>
          )}
          {!recent.listBusy && !recent.listWarning && !recent.sessions.length && (
            <p className="recent-sessions-message">暂无最近会话</p>
          )}
          {recent.sessions.map((session) => {
            const current = workspaceId === session.workspaceId && selected === session.id;
            return <button
              key={workspaceSessionKey(session)}
              className={cx('sidebar-session', current && 'active')}
              aria-label={`打开会话：${session.title}`}
              aria-description={`${session.workspaceName} · ${session.project}`}
              aria-current={current ? 'page' : undefined}
              title={`${session.title} · ${session.workspaceName}`}
              onClick={() => {
                const params = new URLSearchParams({ view: 'all' });
                if (session.archived) params.set('status', 'archived');
                navigateWorkspace(session.workspaceId, session.id, params);
                setMenu(false);
              }}
            >
              <span className="sidebar-session-title">{session.title}</span>
              <Status status={session.status} />
              <span className="sidebar-session-project" title={`${session.workspaceName} · ${session.project}`}>
                <Monitor size={12} aria-hidden="true" />
                <span>{session.workspaceName} · {session.project}
                {session.archived ? ' · 已归档' : ''}
                </span>
              </span>
              <time
                dateTime={new Date(session.updatedAt).toISOString()}
                title={new Date(session.updatedAt).toLocaleString('zh-CN')}
              >
                {relative(session.updatedAt)}
              </time>
            </button>;
          })}
        </nav>
        <div className="nav-label projects-label">
          项目<span>{overview?.projects.length ?? 0}</span>
        </div>
        <div className="projects-nav" id="sidebar-projects">
          {overview?.projects.map((p, i) => (
            <button
              key={p.path}
              title={`${p.name} · ${p.path}`}
              aria-label={`项目：${p.name}`}
              className={cx('project-nav', project === p.path && 'active')}
              onClick={() => {
                setProject(p.path);
                setScope(workspaceId);
                setTab('all');
                closeDetail();
                setMenu(false);
              }}
            >
              <span className={'project-dot color-' + (i % 5)} />
              <span>{p.name}</span>
              <small>{p.count}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="sidebar-bottom">
        <button
          className="nav-item"
          title="设置与访问管理"
          aria-label="设置与访问管理"
          onClick={() => setSettings(true)}
        >
          <Settings2 size={17} />
          <span className="nav-item-label">设置与访问管理</span>
          <ArrowUpRight size={14} />
        </button>
        <div className="account-row">
          <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
          <span>
            {user.username}
            <small>{user.role === 'admin' ? '管理员' : '只读访问者'}</small>
          </span>
          <button
            className="icon-button"
            title={dark ? '切换浅色模式' : '切换深色模式'}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="icon-button" title="退出登录" onClick={onLogout}>
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
