import { Plus, X } from 'lucide-react';
import { PromptForm } from './PromptForm';
import { NewSessionDialogProps, useNewSession } from './useNewSession';
import { ModelSettings } from './ModelSettings';

export function NewSessionDialog(props: NewSessionDialogProps) {
  const { user, onClose, onCreated } = props;
  const { projects, selected, setSelected, error, loading, setRefresh, dialog, modelSettings } =
    useNewSession(props);
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
          allowAttachments
          allowGoal
          url="/api/sessions"
          extra={{
            projectId: selected,
            ...modelSettings.overrides,
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
        </PromptForm>
      </div>
    </div>
  );
}
