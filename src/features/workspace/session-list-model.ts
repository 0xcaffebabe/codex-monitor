import { date } from '../../shared/format';
import type { Session } from '../../types';

export type SessionGroup = 'time' | 'project';
export type SessionRow = { session: Session; heading?: string };

export function sessionRows(
  sessions: Session[],
  group: SessionGroup,
  now = Date.now(),
): SessionRow[] {
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
