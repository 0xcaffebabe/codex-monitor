import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ManagedWorkspace } from '../../workspaces';
import { UsageDashboard } from './UsageDashboard';

export function UsageDialog({
  workspaceId,
  workspaces,
  showSub2Api,
  onSession,
  onClose,
}: {
  workspaceId: string;
  workspaces: ManagedWorkspace[];
  showSub2Api: boolean;
  onSession: (workspaceId: string, sessionId: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const sub2ApiId = useId();
  const [selection, setSelection] = useState(workspaceId);
  const workspace = workspaces.find(({ id }) => id === selection) ?? workspaces[0];
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="usage-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <header className="usage-dialog-header">
        <h2 id={titleId}>用量统计</h2>
        <select
          aria-label="统计工作空间"
          value={workspace.id}
          onChange={(event) => setSelection(event.target.value)}
        >
          {workspaces.map(({ id, name, online }) => (
            <option key={id} value={id}>
              {name}
              {online ? '' : '（离线）'}
            </option>
          ))}
        </select>
        <div className="usage-heading-actions">
          {showSub2Api && (
            <button
              type="button"
              className="secondary"
              onClick={() => document.getElementById(sub2ApiId)?.scrollIntoView({ block: 'start' })}
            >
              Sub2API
            </button>
          )}
          <button
            autoFocus
            type="button"
            className="icon-button"
            aria-label="关闭用量统计"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      <UsageDashboard
        inDialog
        workspaceId={workspace.id}
        onSession={(id) => onSession(workspace.id, id)}
        sub2Api={showSub2Api ? { id: sub2ApiId } : undefined}
      />
    </dialog>
  );
}
