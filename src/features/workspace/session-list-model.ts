import { date } from '../../shared/format';
import type { Session } from '../../types';

export type SessionGroup = 'time' | 'project';
export type WorkspaceSession = Session & { workspaceId: string; workspaceName: string };
export type SessionRow<T extends Session = Session> = { session: T; heading?: string };

export const workspaceSessionKey = (session: WorkspaceSession) =>
  `${session.workspaceId}:${session.id}`;

export function runningProjects(sessions: Session[], selectedProject = '') {
  const projects = new Map<string, { path: string; name: string; count: number }>();
  for (const session of sessions) {
    if (session.status !== 'running' || session.archived || !session.cwd) continue;
    const project = projects.get(session.cwd);
    if (project) project.count++;
    else projects.set(session.cwd, { path: session.cwd, name: session.project, count: 1 });
  }
  if (selectedProject && !projects.has(selectedProject))
    projects.set(selectedProject, {
      path: selectedProject,
      name: selectedProject.split(/[\\/]/).filter(Boolean).pop() || selectedProject,
      count: 0,
    });
  return [...projects.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
}

export function mergeWorkspaceSessions(sessions: WorkspaceSession[]) {
  return [
    ...new Map(sessions.map((session) => [workspaceSessionKey(session), session])).values(),
  ].sort(
    (a, b) =>
      Number(b.status === 'running') - Number(a.status === 'running') ||
      b.updatedAt - a.updatedAt ||
      a.workspaceId.localeCompare(b.workspaceId),
  );
}

export function sessionRows<T extends Session>(
  sessions: T[],
  group: SessionGroup,
  now = Date.now(),
): SessionRow<T>[] {
  const sorted =
    group === 'project'
      ? [...sessions].sort(
          (a, b) => a.project.localeCompare(b.project) || b.updatedAt - a.updatedAt,
        )
      : sessions;
  const today = new Date(now).toDateString();
  const label = (session: Session) =>
    group === 'project'
      ? session.project
      : session.status === 'running'
        ? '正在进行'
        : new Date(session.updatedAt).toDateString() === today
          ? '今天'
          : date(session.updatedAt);
  let previous: string | undefined;
  return sorted.map((session) => {
    const heading = label(session);
    const row = { session, heading: heading === previous ? undefined : heading };
    previous = heading;
    return row;
  });
}
