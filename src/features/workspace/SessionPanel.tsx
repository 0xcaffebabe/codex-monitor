import {
  ChevronDown,
  Clock,
  Folder,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Shield,
  TriangleAlert,
  X,
} from 'lucide-react';
import { cx } from '../../shared/format';
import type { User } from '../../types';
import { SessionRows } from './SessionRows';
import type { WorkspaceModel } from './useWorkspace';

export function SessionPanel({
  user,
  model,
  onSessionSelected,
}: {
  user: User;
  onSessionSelected?: () => void;
  model: Pick<
    WorkspaceModel,
    | 'selected'
    | 'total'
    | 'subagents'
    | 'setSubagents'
    | 'group'
    | 'setGroup'
    | 'searchRef'
    | 'q'
    | 'setQ'
    | 'tab'
    | 'changeTab'
    | 'project'
    | 'setProject'
    | 'overview'
    | 'error'
    | 'loadList'
    | 'rows'
    | 'listBusy'
    | 'select'
    | 'sessions'
    | 'setCreating'
  >;
}) {
  const {
    selected,
    total,
    subagents,
    setSubagents,
    group,
    setGroup,
    searchRef,
    q,
    setQ,
    tab,
    changeTab,
    project,
    setProject,
    overview,
    error,
    loadList,
    rows,
    listBusy,
    select,
    sessions,
    setCreating,
  } = model;
  return (
    <section
      id="workspace-sessions"
      aria-label="会话记录"
      className={cx('session-panel', !!selected && 'compact')}
    >
      <div className="list-toolbar">
        <div className="list-heading">
          <h2>{selected ? '会话记录' : '会话记录'}</h2>
          <span className="count">{total}</span>
          {!selected && <span className="muted list-hint">最近活动优先</span>}
        </div>
        <div className="list-actions">
          {user.role === 'admin' && (
            <button
              className="secondary new-session-button"
              aria-label="新建会话"
              onClick={() => setCreating(true)}
            >
              <Plus size={15} />
              <span>新建会话</span>
            </button>
          )}
          {!selected && (
            <label className="toggle-sub">
              <input
                type="checkbox"
                checked={subagents}
                onChange={(e) => setSubagents(e.target.checked)}
              />
              子代理
            </label>
          )}
          <div className="segmented" aria-label="会话分组">
            <button
              title="按时间分组"
              className={cx(group === 'time' && 'active')}
              onClick={() => setGroup('time')}
            >
              <Clock size={14} />
              {!selected && '时间'}
            </button>
            <button
              title="按项目分组"
              className={cx(group === 'project' && 'active')}
              onClick={() => setGroup('project')}
            >
              <Folder size={14} />
              {!selected && '项目'}
            </button>
          </div>
        </div>
      </div>
      <div className="search-box">
        <Search size={17} />
        <input
          ref={searchRef}
          aria-label="搜索会话"
          placeholder={selected ? '搜索会话…' : '搜索标题、项目、首条消息或会话 ID…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q ? (
          <button className="icon-button" title="清除搜索" onClick={() => setQ('')}>
            <X size={15} />
          </button>
        ) : (
          <kbd>/</kbd>
        )}
      </div>
      {!selected && (
        <div className="filter-row">
          <div className="filter-tabs">
            <button className={cx(tab === 'all' && 'active')} onClick={() => changeTab('all')}>
              全部
            </button>
            <button
              className={cx(tab === 'running' && 'active')}
              onClick={() => changeTab('running')}
            >
              <span className="green-dot" />
              进行中
            </button>
            <button
              className={cx(tab === 'archived' && 'active')}
              onClick={() => changeTab('archived')}
            >
              已归档
            </button>
          </div>
          {project && (
            <button className="project-filter" onClick={() => setProject('')}>
              <Folder size={12} />
              {overview?.projects.find((p) => p.path === project)?.name}
              <X size={12} />
            </button>
          )}
          <span className="filtered-count">{total} 个会话</span>
        </div>
      )}
      {error && (
        <div className="alert error" role="alert">
          <TriangleAlert size={16} />
          {error}
          <button onClick={() => void loadList()}>重试</button>
        </div>
      )}
      <div className="session-list">
        {!selected && !!rows.length && (
          <div className="table-head">
            <span>会话 / 项目</span>
            <span>状态</span>
            <span>Token 用量</span>
            <span>最近活动</span>
            <span />
          </div>
        )}
        {listBusy && !rows.length ? (
          <div className="empty">
            <LoaderCircle className="spin" />
            <p>正在读取会话…</p>
          </div>
        ) : !rows.length ? (
          <div className="empty">
            <span className="empty-icon">{q ? <Search /> : <MessageSquare />}</span>
            <h3>
              {q
                ? '没有找到相关会话'
                : tab === 'running'
                  ? '暂时没有正在进行的会话'
                  : '这里还没有会话'}
            </h3>
            <p>
              {q ? '试试其他关键词，或清除筛选条件。' : '本机 Codex 的新活动会自动出现在这里。'}
            </p>
            {q && (
              <button
                className="secondary"
                onClick={() => {
                  setQ('');
                  setProject('');
                }}
              >
                清除筛选
              </button>
            )}
          </div>
        ) : (
          <SessionRows
            rows={rows}
            selected={selected}
            select={(id) => {
              select(id);
              onSessionSelected?.();
            }}
          />
        )}
        {sessions.length < total && (
          <button className="load-more" onClick={() => void loadList(true)}>
            加载更多会话
            <ChevronDown size={15} />
          </button>
        )}
      </div>
      <footer className="list-footer">
        <span>
          <Shield size={12} />
          {user.role === 'admin' ? '会话监控与交互' : '只读监控'}
        </span>
        <span>
          {sessions.length} / {total} 个会话
        </span>
      </footer>
    </section>
  );
}
