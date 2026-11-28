import type { AttentionSession, AttentionWorkspace } from '../../attention-types';
import type { ManagedWorkspace } from '../../workspaces';

export type RunningTask = {
  workspace: ManagedWorkspace;
  session: Pick<AttentionSession, 'id' | 'updatedAt'> &
    Partial<Pick<AttentionSession, 'title' | 'project' | 'status'>>;
};

export const taskKey = ({ workspace, session }: RunningTask) =>
  JSON.stringify([workspace.id, session.id]);

export function runningTasks(groups: AttentionWorkspace[]): RunningTask[] {
  return groups
    .flatMap(({ workspace, snapshot, fresh }) => {
      if (!fresh || !snapshot) return [];
      const pending = new Set([
        ...snapshot.approvals.requests.map((request) => request.threadId),
        ...(snapshot.questions ?? []).map((request) => request.session.id),
      ]);
      return snapshot.running
        .filter((session) => !pending.has(session.id))
        .map((session) => ({ workspace, session }));
    })
    .sort((left, right) => right.session.updatedAt - left.session.updatedAt);
}
