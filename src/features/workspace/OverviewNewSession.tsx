import { SquarePen, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { User } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';
import type { AttentionWorkspace } from '../attention/useAttention';
import { NewSessionComposer } from '../control/NewSessionComposer';
import { preferredNewSessionWorkspace } from '../control/new-session-preferences';

export function OverviewNewSession({
  user,
  workspaceId,
  groups,
  onClose,
  onCreated,
}: {
  user: User;
  workspaceId: string;
  groups: AttentionWorkspace[];
  onClose: () => void;
  onCreated: (workspace: ManagedWorkspace, sessionId: string) => void;
}) {
  const workspaces = groups.map(({ workspace }) => workspace);
  const [selectedId, setSelectedId] = useState(
    () => preferredNewSessionWorkspace(user.id, workspaces, workspaceId)?.id ?? workspaceId,
  );
  const selected = useRef(selectedId);
  const dialog = useRef<HTMLDialogElement>(null);
  const group = groups.find(({ workspace }) => workspace.id === selectedId);
  const snapshot = group?.fresh ? group.snapshot : undefined;
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="overview-new-session"
      aria-labelledby="overview-new-session-heading"
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <header className="overview-compose-header">
        <h2 id="overview-new-session-heading">
          <SquarePen size={16} aria-hidden="true" />
          新建会话
        </h2>
        <button type="button" className="icon-button" aria-label="关闭新建会话" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <NewSessionComposer
        key={selectedId}
        user={user}
        workspaceId={selectedId}
        workspaces={workspaces}
        draftKey={`codex-monitor.draft.${user.id}.overview-new`}
        activeSessions={snapshot && [...snapshot.running, ...snapshot.waiting]}
        onWorkspaceChange={(id) => {
          selected.current = id;
          setSelectedId(id);
        }}
        onCreated={(sessionId) => {
          if (!group) return;
          if (dialog.current?.open && selected.current === selectedId) onClose();
          onCreated(group.workspace, sessionId);
        }}
      />
    </dialog>
  );
}
