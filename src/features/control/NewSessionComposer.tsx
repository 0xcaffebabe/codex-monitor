import { RefreshCw } from 'lucide-react';
import { PromptForm } from './PromptForm';
import { NewSessionProps, useNewSession } from './useNewSession';
import { ModelSettings } from './ModelSettings';
import type { SessionPermissionMode } from '../../approval-types';

export function NewSessionComposer(props: NewSessionProps) {
  const { user, workspaceId, workspaces, onWorkspaceChange, onCreated } = props;
  const online = !!workspaces.find((workspace) => workspace.id === workspaceId)?.online;
  const {
    projects,
    selected,
    setSelected,
    error,
    loading,
    setRefresh,
    modelSettings,
    creationPermissions,
    permissionMode,
    setPermissionMode,
  } = useNewSession(props);
  return (
    <div className="message-composer new-session-composer" aria-label="编写新会话">
      <div className="composer-heading">
        <strong>首条消息</strong>
        <button
          type="button"
          className="icon-button"
          title="刷新发送状态"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {error && (
        <p className="control-error" role="alert">
          {error}{' '}
          <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>
            重新连接
          </button>
        </p>
      )}
      <div className="new-session-options">
        <label className="prompt-label">
          工作空间
          <select
            aria-label="新会话工作空间"
            value={workspaceId}
            onChange={(event) => onWorkspaceChange(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id} disabled={!workspace.online}>
                {workspace.name}
                {!workspace.online ? '（离线）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="prompt-label">
          项目
          <select
            aria-label="新会话项目"
            value={selected}
            disabled={loading || !online}
            onChange={(event) => setSelected(event.target.value)}
          >
            {!projects.length && (
              <option value="">{loading ? '正在加载项目…' : '暂无可用项目'}</option>
            )}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} · {project.path}
              </option>
            ))}
          </select>
        </label>
        {creationPermissions && (
          <label className="prompt-label">
            会话权限
            <select
              aria-label="新会话权限"
              value={permissionMode}
              disabled={loading || !online}
              onChange={(event) => setPermissionMode(event.target.value as SessionPermissionMode)}
            >
              <option value="inherit">沿用本机配置（默认）</option>
              <option value="read-only">只读 · 额外权限在网页确认</option>
              <option value="workspace-write">项目写入 · 联网时申请</option>
              <option value="workspace-write-network">项目写入并允许联网</option>
              <option value="danger-full-access">完全访问 · 不经逐次审批</option>
            </select>
            <span className="control-hint">
              {permissionMode === 'danger-full-access'
                ? '允许读写本机文件和联网，无需逐次审批。仅用于新会话。'
                : permissionMode === 'inherit'
                  ? '使用目标机器的 Codex 权限与审批设置。'
                  : '仅用于新会话。受限模式的额外权限需在会话中确认。'}
            </span>
          </label>
        )}
      </div>
      {modelSettings.error && (
        <p className="control-hint" role="status">
          模型列表暂不可用，可使用默认设置创建。{modelSettings.error}
        </p>
      )}
      <PromptForm
        storageKey={`codex-monitor.draft.${user.id}.new`}
        autoFocus
        submitOnEnter
        allowAttachments
        projectFilesUrl={selected ? `/api/control/projects/${selected}/files` : undefined}
        allowGoal
        attachmentControls={
          <ModelSettings
            compact
            settings={modelSettings}
            prefix="新会话"
            onRetry={() => setRefresh((value) => value + 1)}
          />
        }
        url="/api/sessions"
        extra={{
          projectId: selected,
          ...modelSettings.overrides,
          ...(creationPermissions && permissionMode ? { permissionMode } : {}),
        }}
        enabled={online && !loading && !!selected && !error}
        label="创建并发送"
        onAccepted={(receipt) => onCreated(receipt.threadId!)}
      />
    </div>
  );
}
