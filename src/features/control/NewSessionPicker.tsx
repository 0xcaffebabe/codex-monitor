import { Check, Folder, Monitor } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import type { Project } from './types';
import type { NewSessionProps } from './useNewSession';

type NewSessionPickerProps = Pick<
  NewSessionProps,
  'workspaceId' | 'workspaces' | 'onWorkspaceChange'
> & {
  online: boolean;
  projects: Project[];
  selected: string;
  onProjectChange: (id: string) => void;
  loading: boolean;
  error: string;
  onRetry: () => void;
};

export function NewSessionPicker({
  workspaceId,
  workspaces,
  onWorkspaceChange,
  online,
  projects,
  selected,
  onProjectChange,
  loading,
  error,
  onRetry,
}: NewSessionPickerProps) {
  const id = useId();
  const [focusedTab, setFocusedTab] = useState('');
  const tabStop =
    workspaces.find((workspace) => workspace.online && workspace.id === focusedTab)?.id ??
    (online ? workspaceId : workspaces.find((workspace) => workspace.online)?.id);
  const status = !online
    ? '等待工作空间连接后加载项目。'
    : loading
      ? '正在加载项目…'
      : !error && !projects.length
        ? '暂无可用项目'
        : '';

  function moveTabFocus(event: KeyboardEvent<HTMLDivElement>) {
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled'),
    );
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const last = tabs.length - 1;
    const positions: Record<string, number> = {
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowRight: index === last ? 0 : index + 1,
      Home: 0,
      End: last,
    };
    const tab = tabs[positions[event.key]];
    if (tab) {
      event.preventDefault();
      tab.focus();
    }
  }

  return (
    <>
      <div className="new-session-workspaces">
        <span className="new-session-picker-label" id={`${id}-workspaces`}>
          工作空间
        </span>
        <div
          className="new-session-workspace-tabs"
          role="tablist"
          aria-labelledby={`${id}-workspaces`}
          onKeyDown={moveTabFocus}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocusedTab('');
          }}
        >
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              id={`${id}-workspace-${workspace.id}`}
              className="new-session-workspace-tab"
              type="button"
              role="tab"
              aria-selected={workspace.id === workspaceId}
              aria-controls={`${id}-projects`}
              autoFocus={workspace.id === workspaceId && workspace.online}
              disabled={!workspace.online}
              tabIndex={workspace.id === tabStop ? 0 : -1}
              onFocus={() => setFocusedTab(workspace.id)}
              onClick={() => {
                if (workspace.id !== workspaceId) onWorkspaceChange(workspace.id);
              }}
            >
              <Monitor size={15} aria-hidden="true" />
              {workspace.name}
              {!workspace.online && <small>离线</small>}
            </button>
          ))}
        </div>
      </div>
      <div
        className="timeline-scroll new-session-projects"
        role="tabpanel"
        id={`${id}-projects`}
        aria-labelledby={`${id}-workspace-${workspaceId}`}
        tabIndex={status ? 0 : undefined}
      >
        <h2 className="new-session-picker-label" id={`${id}-project-label`}>
          项目
        </h2>
        {status ? (
          <p className="new-session-project-status" role="status">
            {status}
          </p>
        ) : error ? (
          <div className="new-session-project-error control-error" role="alert">
            <span>{error}</span>
            <button type="button" className="secondary" onClick={onRetry}>
              重新连接
            </button>
          </div>
        ) : (
          <fieldset
            className="new-session-project-grid"
            role="radiogroup"
            aria-labelledby={`${id}-project-label`}
          >
            {projects.map((project, index) => (
              <label
                key={project.id}
                className="new-session-project"
                title={`${project.name} · ${project.path}`}
              >
                <input
                  type="radio"
                  name={`${id}-project`}
                  value={project.id}
                  checked={project.id === selected}
                  aria-label={project.name}
                  aria-describedby={`${id}-project-path-${index}`}
                  onChange={() => onProjectChange(project.id)}
                />
                <span className="new-session-project-icon">
                  <Folder size={16} aria-hidden="true" />
                </span>
                <span className="new-session-project-text">
                  <strong>{project.name}</strong>
                  <small id={`${id}-project-path-${index}`}>{project.path}</small>
                </span>
                <Check size={15} className="new-session-project-check" aria-hidden="true" />
              </label>
            ))}
          </fieldset>
        )}
      </div>
    </>
  );
}
