import type { Express, Request } from 'express';
import type { ApprovalControl } from '../../src/approval-types.js';
import type {
  AttentionReceipt,
  AttentionSession,
  AttentionSnapshot,
} from '../../src/attention-types.js';
import type { CodexSource } from '../source.js';

function sessionInfo({ id, title, project, cwd, status, updatedAt, latestTurn }: AttentionSession) {
  return { id, title, project, cwd, status, updatedAt, latestTurn };
}

export function installAttentionRoute(
  app: Express,
  source: Pick<CodexSource, 'attentionSessions' | 'get' | 'inputRequests' | 'overview'>,
  approvals: ApprovalControl | undefined,
  authorize: (req: Request) => Promise<void>,
  receipts: (userId: string, since: number) => AttentionReceipt[],
) {
  let questions: { at: number; result: ReturnType<CodexSource['inputRequests']> } | undefined;
  app.get('/api/sessions/attention', async (req, res) => {
    const now = Date.now();
    const administrator = req.identity?.user.role === 'admin';
    if (administrator) await authorize(req);
    const sessions = await source.attentionSessions(now - 86400000);
    const overview = await source.overview();
    if (administrator && (!questions || now - questions.at >= 5000)) {
      questions = { at: now, result: source.inputRequests(now - 86400000) };
    }
    const input = administrator ? await questions!.result.catch(() => null) : [];
    const pending = administrator && approvals ? approvals.list() : [];
    const requests = await Promise.all(
      pending.map(async (request) => {
        const session = await source.get(request.threadId);
        if (!session || session.archived || session.subagent) return [];
        const { id, threadId, title, createdAt, expiresAt } = request;
        return [{ id, threadId, title, createdAt, expiresAt, session: sessionInfo(session) }];
      }),
    );
    const snapshot: AttentionSnapshot = {
      available: overview.source.available,
      observedAt: Date.now(),
      approvals: { supported: administrator && !!approvals, requests: requests.flat() },
      questions:
        input?.slice(0, 60).map((request) => ({
          id: request.requestId,
          session: sessionInfo(request.session),
          title: request.questions[0].title,
          questions: request.questions.map(({ title, body, options }) => ({ text: body ?? title, options })),
          createdAt: request.createdAt,
        })) ?? null,
      receipts: administrator ? receipts(req.identity!.user.id, now - 86400000) : [],
      running: sessions.running.map(sessionInfo),
      waiting: sessions.waiting.map(sessionInfo),
      ended: sessions.ended.map(sessionInfo),
      stale: sessions.stale.map(sessionInfo),
      counts: sessions.counts,
    };
    res.json(snapshot);
  });
}
