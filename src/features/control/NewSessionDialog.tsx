import { Plus, X } from 'lucide-react';
import { PromptForm } from './PromptForm';
import { NewSessionDialogProps, useNewSession } from './useNewSession';
import { ModelSettings } from './ModelSettings';
import type { SessionPermissionMode } from '../../approval-types';

export function NewSessionDialog(props: NewSessionDialogProps) {
  const { user, onClose, onCreated } = props;
  const {
    projects,
    selected,
    setSelected,
    error,
    loading,
    setRefresh,
    dialog,
    modelSettings,
    creationPermissions,
    permissionMode,
    setPermissionMode,
  } = useNewSession(props);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="control-dialog new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        ref={dialog}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Tab') {
            const elements = dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)',
            );
            if (!elements?.length) return;
            const first = elements[0],
              last = elements[elements.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <Plus size={22} />
          <h2 id="new-session-title">新建会话</h2>
          <button className="icon-button" title="关闭新建会话" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <p className="control-hint">选择项目，发送第一条消息，也可将它设为持续目标。</p>
        {error && (
          <p className="control-error" role="alert">
            {error}{' '}
            <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>
              重新连接
            </button>
          </p>
        )}
        <PromptForm
          storageKey={`codex-monitor.draft.${user.id}.new`}
          submitOnEnter
          allowAttachments
          allowGoal
          url="/api/sessions"
          extra={{
            projectId: selected,
            ...modelSettings.overrides,
            ...(creationPermissions && permissionMode ? { permissionMode } : {}),
          }}
          enabled={!loading && !!selected && !error}
          label="创建并发送"
          onAccepted={(receipt) => onCreated(receipt.threadId!)}
        >
          <label className="prompt-label">
            项目
            <select
              aria-label="新会话项目"
              value={selected}
              disabled={loading}
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
          <ModelSettings
            settings={modelSettings}
            prefix="新会话"
            onRetry={() => setRefresh((value) => value + 1)}
          />
          {creationPermissions && (
            <label className="prompt-label">
              会话权限
              <select
                aria-label="新会话权限"
                value={permissionMode}
                disabled={loading}
                onChange={(event) => setPermissionMode(event.target.value as SessionPermissionMode)}
              >
                <option value="danger-full-access">完全访问（默认）</option>
                <option value="inherit">沿用本机配置</option>
                <option value="read-only">只读 · 额外权限在网页确认</option>
                <option value="workspace-write">项目写入 · 联网时申请</option>
                <option value="workspace-write-network">项目写入并允许联网</option>
              </select>
              <span className="control-hint">
                {permissionMode === 'danger-full-access'
                  ? '允许读写本机文件和联网，无需逐次审批。仅用于新会话。'
                  : '仅用于新会话。受限模式的额外权限需在会话中确认。'}
              </span>
            </label>
          )}
        </PromptForm>
      </div>
    </div>
  );
}
