import { Monitor } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../../shared/format';
import type { ManagedWorkspace } from '../../workspaces';
import { SessionScope } from './SessionScope';
import type { WorkspaceModel } from './useWorkspace';

export function SidebarProjects({
  workspaces,
  model: { overviews, workspaceId, project, selectProject },
}: {
  workspaces: ManagedWorkspace[];
  model: Pick<WorkspaceModel, 'overviews' | 'workspaceId' | 'project' | 'selectProject'>;
}) {
  const [scope, setScope] = useState('');
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
              return (
                <button
                  key={path}
                  title={`${name} · ${workspace.name} · ${path}`}
                  aria-label={`项目：${name}`}
                  aria-description={`${workspace.name} · ${path} · ${count} 个会话`}
                  aria-current={active ? 'page' : undefined}
                  className={cx('project-nav', active && 'active')}
                  onClick={() => selectProject(workspace.id, path)}
                >
                  <span className={`project-dot color-${index % 5}`} />
                  <span>{name}</span>
                  <small>{count}</small>
                </button>
              );
            })}
          </section>
        ))}
      </nav>
    </>
  );
}
