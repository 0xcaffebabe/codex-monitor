import { api } from './api';
import type { PendingSession, SessionPage } from './types';
import { workspaceUrl } from './workspace-scope';

type Job = {
  id: string;
  older: boolean;
  before?: number;
  limit: number;
  controller: AbortController;
  promise: Promise<void>;
  resolve: () => void;
  syncing?: boolean;
};

/** Finish the current read before applying a coalesced realtime refresh. */
export class DetailLoader {
  private active?: Job;
  private queue: Job[] = [];

  constructor(
    private callbacks: {
      onPage: (page: SessionPage, older: boolean) => void;
      onError: (id: string, error: Error) => void;
      onSettled: (id: string) => void;
      onPending?: (id: string) => void;
    },
    private workspaceId?: string,
  ) {}

  load(id: string, older = false, before?: number, limit = 70): Promise<void> {
    if (this.active && this.active.id !== id) this.cancel();
    if (this.active?.syncing && !older) return this.active.promise;
    const queued = this.queue.find(
      (job) => job.id === id && job.older === older && job.before === before,
    );
    if (queued) return queued.promise;
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const job: Job = {
      id,
      older,
      before,
      limit,
      promise,
      resolve,
      controller: new AbortController(),
    };
    // A requested history page takes priority over background refresh notifications.
    if (older) this.queue.unshift(job);
    else this.queue.push(job);
    this.pump();
    return promise;
  }

  cancel() {
    const active = this.active;
    this.active = undefined;
    active?.controller.abort();
    active?.resolve();
    for (const job of this.queue) job.resolve();
    this.queue = [];
  }

  private pump() {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    void this.run(job);
  }

  private async run(job: Job) {
    let timedOut = false,
      syncing = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      job.controller.abort();
    }, 45000);
    try {
      const params = new URLSearchParams();
      if (job.before !== undefined) params.set('before', String(job.before));
      if (job.limit !== 70) params.set('limit', String(job.limit));
      const route = `/api/sessions/${encodeURIComponent(job.id)}${params.size ? '?' + params : ''}`;
      while (this.active === job && !job.controller.signal.aborted) {
        const page = await api<SessionPage | PendingSession>(
          this.workspaceId ? workspaceUrl(route, this.workspaceId) : route,
          { signal: job.controller.signal },
        );
        if (this.active !== job || job.controller.signal.aborted) break;
        if ('state' in page) {
          syncing = true;
          if (!job.syncing) {
            job.syncing = true;
            // The next sync poll already reads the latest records. Fold any realtime
            // refresh queued before the first 202 into this same bounded wait.
            this.queue = this.queue.filter((queued) => {
              if (queued.id !== job.id || queued.older) return true;
              void job.promise.then(queued.resolve);
              return false;
            });
          }
          this.callbacks.onPending?.(job.id);
          await this.waitForSync(job.controller.signal);
          continue;
        }
        this.callbacks.onPage(page, job.older);
        return;
      }
      if (timedOut) throw new Error('timeout');
    } catch (error) {
      if (this.active === job && (!job.controller.signal.aborted || timedOut))
        this.callbacks.onError(
          job.id,
          timedOut
            ? new Error(
                syncing ? '新会话记录同步较慢，请稍后重试，无需重新创建。' : '读取会话超时，请重试',
              )
            : (error as Error),
        );
    } finally {
      clearTimeout(timeout);
      job.resolve();
      if (this.active === job) {
        this.active = undefined;
        this.callbacks.onSettled(job.id);
        this.pump();
      }
    }
  }

  private waitForSync(signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, 1000);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
