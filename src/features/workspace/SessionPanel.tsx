import {
  ChevronDown,
  Clock,
  Folder,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { cx } from '../../shared/format';
import type { User } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';
import { SessionRows } from './SessionRows';
import { SessionScope } from './SessionScope';
import type { WorkspaceModel } from './useWorkspace';

export function SessionPanel({
  user,
  model,
  workspaces,
  mobile,
  onSessionSelected,
}: {
  user: User;
  workspaces: ManagedWorkspace[];
  mobile: boolean;
  onSessionSelected?: () => void;
  model: Pick<
    WorkspaceModel,
    | 'selected'
    | 'workspaceId'
    | 'total'
    | 'title'
    | 'subagents'
    | 'setSubagents'
    | 'group'
    | 'setGroup'
    | 'searchRef'
    | 'q'
    | 'setQ'
    | 'tab'
    | 'setTab'
    | 'scope'
    | 'setScope'
    | 'project'
    | 'setProject'
    | 'error'
    | 'listWarning'
    | 'listWarningLabels'
    | 'loadList'
    | 'rows'
    | 'listBusy'
    | 'selectSession'
    | 'sessions'
    | 'creating'
    | 'startSession'
  >;
}) {
  const {
    selected,
    workspaceId,
    total,
    title,
    subagents,
    setSubagents,
    group,
    setGroup,
    searchRef,
    q,
    setQ,
    tab,
    setTab,
    scope,
    setScope,
    project,
    setProject,
    error,
    listWarning,
    listWarningLabels,
    loadList,
    rows,
    listBusy,
    selectSession,
    sessions,
    creating,
    startSession,
  } = model;
  const hasDetail = !!selected || creating;
  return (
    <section
      id="workspace-sessions"
      aria-label="会话记录"
      className={cx('session-panel', hasDetail && 'compact')}
    >
      <div className="list-toolbar">
        <div className="list-heading">
          {hasDetail ? <h2>会话记录</h2> : <h1 className="history-heading">{title}</h1>}
          <span className="count">{total}</span>
        </div>
        <div className="list-actions">
          {user.role === 'admin' && (
            <button
              className="secondary new-session-button"
              aria-label="新建会话"
              onClick={() => {
                startSession();
                onSessionSelected?.();
              }}
            >
              <Plus size={15} />
              <span>新建会话</span>
            </button>
          )}
          {!hasDetail && (
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
              {!hasDetail && '时间'}
            </button>
            <button
              title="按项目分组"
              className={cx(group === 'project' && 'active')}
              onClick={() => setGroup('project')}
            >
              <Folder size={14} />
              {!hasDetail && '项目'}
            </button>
          </div>
        </div>
      </div>
      <div className="search-box">
        <Search size={17} />
        <input
          ref={searchRef}
          aria-label="搜索会话"
          placeholder={scope ? '搜索此工作空间的会话' : '搜索会话'}
          maxLength={200}
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
      {workspaces.length > 1 && (
        <div className="session-list-scope">
          <SessionScope
            value={scope}
            onChange={(id) => {
              setProject('');
              setScope(id);
            }}
            workspaces={workspaces}
            label="筛选会话工作空间"
          />
        </div>
      )}
      {hasDetail && (project || tab === 'running' || tab === 'archived') && (
        <div className="compact-session-filters" aria-label="当前会话筛选">
          {project && <button type="button" title={project} aria-label="清除项目筛选" onClick={() => setProject('')}>
            <span>{title}</span><X size={12} />
          </button>}
          {(tab === 'running' || tab === 'archived') && <button type="button" aria-label="清除状态筛选" onClick={() => setTab('all')}>
            <span>{tab === 'archived' ? '已归档' : '进行中'}</span><X size={12} />
          </button>}
        </div>
      )}
      {!hasDetail && (
        <div className="filter-row">
          <div className="filter-tabs">
            <button className={cx(tab === 'all' && 'active')} onClick={() => setTab('all')}>
              全部
            </button>
            <button
              className={cx(tab === 'running' && 'active')}
              onClick={() => setTab('running')}
            >
              <span className="green-dot" />
              进行中
            </button>
            <button
              className={cx(tab === 'archived' && 'active')}
              onClick={() => setTab('archived')}
            >
              已归档
            </button>
          </div>
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
      {listWarning && (
        <div className="session-list-warning" role="status">
          <details>
            <summary>
              <TriangleAlert size={13} aria-hidden="true" />
              <span className="session-list-warning-label">
                {listWarningLabels.length === 1
                  ? listWarningLabels[0]
                  : `${listWarningLabels.length} 个工作空间不可用`}
              </span>
              <span>· 自动重试</span>
              <ChevronDown size={12} aria-hidden="true" />
            </summary>
            <p>{listWarning}</p>
          </details>
        </div>
      )}
      <div className="session-list">
        {!hasDetail && !!rows.length && (
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
              {error || listWarning
                ? '暂时无法显示会话'
                : q
                  ? '没有找到相关会话'
                  : tab === 'running'
                    ? '暂时没有正在进行的会话'
                    : '这里还没有会话'}
            </h3>
            <p>
              {error || listWarning
                ? '工作空间恢复连接后会自动更新。'
                : q
                  ? '试试其他关键词，或清除筛选条件。'
                  : '各工作空间中 Codex 的新活动会自动出现在这里。'}
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
            workspaceId={workspaceId}
            compact={hasDetail}
            statusDot={hasDetail && !mobile}
            selectSession={(session) => {
              selectSession(session);
              onSessionSelected?.();
            }}
          />
        )}
        {sessions.length < total && (
          <button className="load-more" disabled={listBusy} onClick={() => void loadList(true)}>
            加载更多会话
            <ChevronDown size={15} />
          </button>
        )}
      </div>
    </section>
  );
}
