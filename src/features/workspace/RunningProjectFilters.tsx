import { cx } from '../../shared/format';
import type { RunningWorkspace } from '../workspaces/useRunningSessions';
import { runningProjects } from './session-list-model';

export function RunningProjectFilters({
  workspaces,
  project,
  onProjectChange,
}: {
  workspaces: RunningWorkspace[];
  project: string;
  onProjectChange: (path: string) => void;
}) {
  const projects = runningProjects(
    workspaces.flatMap((group) => group.sessions),
    project,
  );
  if (!projects.length) return null;
  return (
    <div className="running-project-filters" role="group" aria-label="进行中项目筛选">
      <button
        className="running-project-filter"
        aria-pressed={!project}
        onClick={() => onProjectChange('')}
      >
        全部项目
      </button>
      <div className="running-project-options">
        {projects.map((item) => (
          <button
            key={item.path}
            className={cx('running-project-filter', project === item.path && 'active')}
            aria-label={`筛选项目：${item.name}`}
            aria-pressed={project === item.path}
            title={`${item.path} · ${item.count} 个进行中会话`}
            onClick={() => onProjectChange(project === item.path ? '' : item.path)}
          >
            <span className="running-project-name">{item.name}</span>
            <span className="running-project-count">{item.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
