import { Folder, Monitor } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx, number } from '../../shared/format';
import type { ManagedWorkspace } from '../../workspaces';
import { SessionScope } from './SessionScope';
import type { WorkspaceModel } from './useWorkspace';

export function SidebarProjects({
  workspaces,
  model: { overviews, workspaceId, project, selectProject },
  collapsed,
}: {
  workspaces: ManagedWorkspace[];
  model: Pick<WorkspaceModel, 'overviews' | 'workspaceId' | 'project' | 'selectProject'>;
  collapsed: boolean;
}) {
  const [scope, setScope] = useState('');
  const [preview, setPreview] = useState<{
    workspaceId: string;
    path: string;
    anchor: HTMLDivElement;
  } | null>(null);
  const previewId = useId();
  useEffect(() => {
    if (!collapsed) setPreview(null);
  }, [collapsed]);

  function dismissPreview(anchor: HTMLDivElement) {
    setPreview((previous) => (previous?.anchor === anchor ? null : previous));
  }

  const scopedWorkspace = workspaces.find((workspace) => workspace.id === scope);
  const groups = (scopedWorkspace ? [scopedWorkspace] : workspaces).map((workspace) => {
    const overview = overviews[workspace.id];
    const projects = overview?.summary?.projects.filter(({ path }) => path) ?? [];
    const status = !workspace.online
      ? '离线'
      : overview?.failed
        ? '加载失败'
        : !overview
          ? '加载中…'
          : projects.length === 0
            ? '暂无项目'
            : '';
    return { workspace, projects, status };
  });
  const count = groups.reduce((total, { projects }) => total + projects.length, 0);
  const showGroupNames = !scopedWorkspace && workspaces.length > 1;

  return (
    <>
      <div className="nav-label projects-label">
        项目<span>{count}</span>
      </div>
      {workspaces.length > 1 && (
        <div className="project-workspace-scope">
          <SessionScope
            value={scopedWorkspace?.id ?? ''}
            onChange={setScope}
            workspaces={workspaces}
            label="筛选项目工作空间"
          />
        </div>
      )}
      <nav className="projects-nav" id="sidebar-projects" aria-label="项目列表">
        {groups.map(({ workspace, projects, status }) => (
          <section className="project-group" key={workspace.id} aria-label={workspace.name}>
            {showGroupNames ? (
              <div className="project-group-heading">
                <Monitor size={13} aria-hidden="true" />
                <span title={workspace.name}>{workspace.name}</span>
                <small>{status || projects.length}</small>
              </div>
            ) : (
              status && (
                <p className="project-list-status" role="status">
                  {status}
                </p>
              )
            )}
            {projects.map(({ path, name, count }, index) => {
              const active = project === path && workspaceId === workspace.id;
              const anchor =
                collapsed && preview?.workspaceId === workspace.id && preview.path === path
                  ? preview.anchor
                  : null;
              return (
                <div
                  key={path}
                  onPointerEnter={(event) => {
                    if (collapsed && event.pointerType !== 'touch')
                      setPreview({ workspaceId: workspace.id, path, anchor: event.currentTarget });
                  }}
                  onPointerLeave={(event) => {
                    if (!event.currentTarget.querySelector(':focus-visible'))
                      dismissPreview(event.currentTarget);
                  }}
                  onFocus={(event) => {
                    if (collapsed && event.target.matches(':focus-visible'))
                      setPreview({ workspaceId: workspace.id, path, anchor: event.currentTarget });
                  }}
                  onBlur={(event) => dismissPreview(event.currentTarget)}
                >
                  <button
                    title={collapsed ? undefined : `${name} · ${workspace.name} · ${path}`}
                    aria-label={`项目：${name}`}
                    aria-description={`${workspace.name} · ${path} · ${count} 个会话`}
                    aria-describedby={anchor ? previewId : undefined}
                    aria-current={active ? 'page' : undefined}
                    className={cx('project-nav', active && 'active')}
                    onClick={() => {
                      setPreview(null);
                      selectProject(workspace.id, path);
                    }}
                  >
                    <span className={`project-dot color-${index % 5}`} />
                    <span>{name}</span>
                    <small>{count}</small>
                  </button>
                  {anchor && (
                    <ProjectPreview
                      id={previewId}
                      anchor={anchor}
                      name={name}
                      workspace={workspace.name}
                      path={path}
                      count={count}
                      onDismiss={() => dismissPreview(anchor)}
                    />
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </nav>
    </>
  );
}

function ProjectPreview({
  id,
  anchor,
  name,
  workspace,
  path,
  count,
  onDismiss,
}: {
  id: string;
  anchor: HTMLDivElement;
  name: string;
  workspace: string;
  path: string;
  count: number;
  onDismiss: () => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = previewRef.current;
    const list = anchor.closest('.projects-nav');
    if (!element || !list) return;

    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const visible = list.getBoundingClientRect();
      const top = Math.max(rect.top, visible.top);
      const bottom = Math.min(rect.bottom, visible.bottom);
      const height = element.offsetHeight;
      const centered = (top + bottom - height) / 2;
      element.style.visibility = top < bottom ? 'visible' : 'hidden';
      element.style.left = `${rect.right}px`;
      element.style.top = `${Math.max(8, Math.min(centered, window.innerHeight - height - 8))}px`;
    };

    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss();
    }

    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    observer.observe(list);
    list.addEventListener('scroll', position);
    window.addEventListener('resize', position);
    window.addEventListener('keydown', dismissOnEscape);
    return () => {
      observer.disconnect();
      list.removeEventListener('scroll', position);
      window.removeEventListener('resize', position);
      window.removeEventListener('keydown', dismissOnEscape);
    };
  }, [anchor, onDismiss]);

  return createPortal(
    <div ref={previewRef} id={id} className="project-preview" role="tooltip">
      <div className="project-preview-content">
        <div className="project-preview-heading">
          <strong aria-hidden="true">{name}</strong>
          <span>{number(count)} 个会话</span>
        </div>
        <div className="project-preview-meta">
          <Monitor size={14} aria-hidden="true" />
          <span>{workspace}</span>
        </div>
        <div className="project-preview-meta">
          <Folder size={14} aria-hidden="true" />
          <span>{path}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
