import { z } from 'zod';
import type { ApprovalControl } from '../../src/approval-types.js';
import type { Session } from '../../src/types.js';
import type { CodexSource } from '../source.js';

const limit = 12;
const session = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  title: z.string().max(120),
  project: z.string().max(80),
  status: z.enum(['running', 'waiting', 'completed', 'failed', 'interrupted', 'stale', 'idle']),
  updatedAt: z.number().finite(),
  latestTurn: z.string().max(200).optional(),
});
export const helpSnapshotSchema = z.object({
  running: z.array(session).max(limit),
  waiting: z.array(session).max(limit),
  ended: z.array(session).max(limit),
  counts: z.object({
    running: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    ended: z.number().int().nonnegative(),
  }),
  approvals: z.array(z.object({ id: z.string().max(200), session })).max(limit),
  questions: z.array(z.object({ id: z.string().max(200), session })).max(limit).nullable(),
});
export type HelpSnapshot = z.infer<typeof helpSnapshotSchema>;

function summarize(item: Pick<Session, 'id' | 'title' | 'project' | 'status' | 'updatedAt' | 'latestTurn'>) {
  const { id, title, project, status, updatedAt, latestTurn } = item;
  return { id, title: title.slice(0, 120), project: project.slice(0, 80), status, updatedAt, latestTurn: latestTurn?.slice(0, 200) };
}

export async function readHelpSnapshot(source: CodexSource, approvals: ApprovalControl | undefined, details: boolean) {
  const since = Date.now() - 86400000;
  const [sessions, overview] = await Promise.all([source.attentionSessions(since), source.overview()]);
  if (!overview.source.available) return;
  const [pending, questions] = await Promise.all([
    Promise.all((details ? approvals?.list() ?? [] : []).slice(0, limit).map(async ({ id, threadId }) => {
      const item = await source.get(threadId);
      return item && !item.archived && !item.subagent ? [{ id: id.slice(0, 200), session: summarize(item) }] : [];
    })),
    details ? source.inputRequests(since).then((items) => items.slice(0, limit).map(({ requestId, session }) => ({
      id: requestId.slice(0, 200), session: summarize(session),
    }))).catch(() => null) : [],
  ]);
  return helpSnapshotSchema.parse({
    running: sessions.running.slice(0, limit).map(summarize),
    waiting: sessions.waiting.slice(0, limit).map(summarize),
    ended: sessions.ended.slice(0, limit).map(summarize),
    counts: sessions.counts,
    approvals: pending.flat(),
    questions,
  });
}
