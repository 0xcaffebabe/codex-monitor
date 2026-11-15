import {
  Activity,
  Archive,
  ArrowUpRight,
  Layers3,
  LoaderCircle,
  LogOut,
  Moon,
  Radio,
  Settings2,
  Shield,
  Sun,
  Wifi,
  X,
} from 'lucide-react';
import { cx, relative } from '../../shared/format';
import { Brand } from '../../shared/ui/Brand';
import { Status } from '../../shared/ui/Status';
import type { WorkspaceModel } from './useWorkspace';
import { WorkspaceProps } from './useWorkspace';

export function Sidebar({
  user,
  onLogout,
  dark,
  setDark,
  model,
  workspaceName,
}: WorkspaceProps & {
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
    | 'recentError'
    | 'recentLoaded'
    | 'recentSessions'
    | 'loadRecentSessions'
    | 'selected'
    | 'setProject'
    | 'setQ'
    | 'setQuery'
    | 'setTab'
    | 'select'
    | 'setSelected'
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
    recentError,
    recentLoaded,
    recentSessions,
    loadRecentSessions,
    selected,
    setProject,
    setQ,
    setQuery,
    setTab,
    select,
    setSelected,
    setSettings,
  } = model;
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
      <div className="workspace-label">
        <span className="workspace-avatar">W</span>
        <span>
          {workspaceName || '本机工作空间'}
          <small>Codex workspace</small>
        </span>
        <Shield size={14} />
      </div>
      <div className="nav-label">工作空间</div>
      <nav className="workspace-nav">
        <button
          className={cx('nav-item', tab === 'all' && !project && 'active')}
          aria-label="全部会话"
          title="全部会话"
          onClick={() => changeTab('all')}
        >
          <Layers3 size={17} />
          <span className="nav-item-label">全部会话</span>
          <span>{overview?.total ?? '—'}</span>
        </button>
        <button
          className={cx('nav-item', tab === 'running' && 'active')}
          aria-label="正在进行"
          title="正在进行"
          onClick={() => changeTab('running')}
        >
          <Radio size={17} />
          <span className="nav-item-label">正在进行</span>
          <span className={cx(!!overview?.running && 'live-count')}>{overview?.running ?? 0}</span>
        </button>
        <button
          className={cx('nav-item', tab === 'archived' && 'active')}
          aria-label="已归档"
          title="已归档"
          onClick={() => changeTab('archived')}
        >
          <Archive size={17} />
          <span className="nav-item-label">已归档</span>
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
        <nav className="recent-sessions-nav" id="sidebar-recent-sessions" aria-label="最近会话">
          <p className="recent-sessions-hint">按最后活动时间 · 最近 40 条</p>
          {recentError && (
            <div className="recent-sessions-message" role="alert">
              {recentError}
              <button className="secondary" onClick={() => void loadRecentSessions()}>
                重试
              </button>
            </div>
          )}
          {!recentLoaded && (
            <p className="recent-sessions-message">
              <LoaderCircle size={14} className="spin" /> 正在读取最近会话…
            </p>
          )}
          {recentLoaded && !recentError && !recentSessions.length && (
            <p className="recent-sessions-message">暂无最近会话</p>
          )}
          {recentSessions.map((session) => (
            <button
              key={session.id}
              className={cx('sidebar-session', selected === session.id && 'active')}
              aria-label={`打开会话：${session.title}`}
              aria-current={selected === session.id ? 'page' : undefined}
              title={session.title}
              onClick={() => {
                setProject('');
                setQ('');
                setQuery('');
                setTab(session.archived ? 'archived' : 'all');
                select(session.id);
              }}
            >
              <span className="sidebar-session-title">{session.title}</span>
              <Status status={session.status} />
              <span className="sidebar-session-project">
                {session.project}
                {session.archived ? ' · 已归档' : ''}
              </span>
              <time
                dateTime={new Date(session.updatedAt).toISOString()}
                title={new Date(session.updatedAt).toLocaleString('zh-CN')}
              >
                {relative(session.updatedAt)}
              </time>
            </button>
          ))}
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
                setTab('all');
                setSelected(undefined);
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
        <div className="source-badge">
          <span className={cx('green-dot', !overview?.source.available && 'offline')} />
          <div>
            {overview?.source.available ? '本机数据源已连接' : '数据源未连接'}
            <small>{overview?.source.database ? 'SQLite + 会话记录' : 'JSONL 会话记录'}</small>
          </div>
          <Wifi size={14} />
        </div>
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
