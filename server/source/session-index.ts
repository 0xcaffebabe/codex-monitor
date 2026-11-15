import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Overview, SessionStatus } from '../../src/types.js';
import { textOf } from '../normalize.js';
import type { SourceDatabases } from './databases.js';
import { RolloutStore } from './rollouts.js';
import { scanSessions } from './session-files.js';
import type { InternalSession } from './session.js';
import { publicSession, validId } from './session.js';

/** Owns session metadata, refresh policy and list queries. */
export class SessionIndex {
  private sessions: InternalSession[] = [];
  private lastRefresh = 0;
  private titles = new Map<string, string>();
  private titlesMtime = 0;
  private filesScannedAt = 0;
  constructor(
    public home: string,
    private databases: SourceDatabases,
    private rollouts: Pick<RolloutStore, 'status'>,
  ) {}
  private async scanFiles() {
    this.filesScannedAt = Date.now();
    this.sessions = await scanSessions(this.home, (id) => this.rollouts.status(id));
  }
  async refresh(force = false) {
    if (!force && Date.now() - this.lastRefresh < 1200) return;
    this.lastRefresh = Date.now();
    const indexFile = path.join(this.home, 'session_index.jsonl');
    try {
      const mtime = statSync(indexFile).mtimeMs;
      if (mtime !== this.titlesMtime) {
        const titles = new Map<string, string>();
        for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
          try {
            const row = JSON.parse(line);
            if (row.id && row.thread_name) titles.set(row.id, row.thread_name);
          } catch {}
        }
        this.titles = titles;
        this.titlesMtime = mtime;
      }
    } catch {}
    if (!this.databases.state) {
      if (Date.now() - this.filesScannedAt > 15000) await this.scanFiles();
      return;
    }
    try {
      const optional = (col: string, fallback: string) =>
        this.databases.columns.has(col) ? col : `${fallback} AS ${col}`;
      const cols = [
        'id',
        'title',
        'cwd',
        'rollout_path',
        'created_at',
        'updated_at',
        'archived',
        'tokens_used',
        'source',
        optional('name', "''"),
        optional('model', "''"),
        optional('preview', "''"),
        optional('first_user_message', "''"),
        optional('agent_role', 'NULL'),
        optional('history_mode', "'legacy'"),
        optional('updated_at_ms', 'NULL'),
      ].join(',');
      const rows = this.databases.state.prepare(`SELECT ${cols} FROM threads`).all();
      const latest = this.databases.history?.prepare(
        'SELECT status,turn_id,started_at,completed_at FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1',
      );
      this.sessions = rows.map((r) => {
        let parentId: string | undefined;
        try {
          parentId = JSON.parse(String(r.source)).subagent?.thread_spawn?.parent_thread_id;
        } catch {}
        const turn = latest?.get(r.id!);
        let status: SessionStatus = 'idle';
        const raw = String(turn?.status ?? '');
        if (raw === 'inProgress' || raw === 'in_progress') status = 'running';
        else if (raw === 'completed') status = 'completed';
        else if (raw === 'interrupted') status = 'interrupted';
        else if (raw === 'failed') status = 'failed';
        const updatedAt = Number(r.updated_at_ms) || Number(r.updated_at) * 1000;
        // A persisted unfinished turn alone cannot prove that a process is still running.
        if (status === 'running' && Date.now() - updatedAt > 15 * 60000) status = 'stale';
        const cwd = String(r.cwd).replace(/^\\\\\?\\/, '');
        return {
          id: String(r.id),
          title: String(
            r.name ||
              this.titles.get(String(r.id)) ||
              r.title ||
              r.first_user_message ||
              '未命名会话',
          ).slice(0, 500),
          cwd,
          project: path.basename(cwd.replaceAll('\\', '/')) || cwd,
          createdAt: Number(r.created_at) * 1000,
          updatedAt,
          archived: !!r.archived,
          model: String(r.model || ''),
          tokens: Number(r.tokens_used) || 0,
          preview: textOf(String(r.preview || r.first_user_message || '')).slice(0, 400),
          status,
          statusSource: turn ? 'history' : 'rollout',
          parentId,
          latestTurn: turn?.turn_id as string | undefined,
          file: String(r.rollout_path),
          historyMode: String(r.history_mode),
          subagent: String(r.source).includes('subagent') || !!r.agent_role,
        };
      });
    } catch {
      if (!this.databases.warnings.includes('会话索引暂时不可读，正在显示最近成功读取的数据。'))
        this.databases.warnings.push('会话索引暂时不可读，正在显示最近成功读取的数据。');
    }
  }
  private visible(subagents = false) {
    return this.sessions.filter((s) => subagents || !s.subagent);
  }
  async overview(): Promise<Overview> {
    await this.refresh();
    const list = this.visible(),
      active = list.filter((s) => !s.archived);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const projects = new Map<string, { name: string; path: string; count: number }>();
    for (const s of list) {
      const p = projects.get(s.cwd) ?? { name: s.project, path: s.cwd, count: 0 };
      p.count++;
      projects.set(s.cwd, p);
    }
    return {
      total: list.length,
      running: active.filter((s) => s.status === 'running').length,
      today: active.filter((s) => s.updatedAt >= +today).length,
      projects: [...projects.values()].sort((a, b) => b.count - a.count),
      source: {
        available: !!this.databases.state || this.sessions.length > 0,
        home: this.home,
        database: !!this.databases.state,
        history: !!this.databases.history,
        warnings: this.databases.warnings,
      },
      updatedAt: Date.now(),
    };
  }
  async list(query: {
    q?: string;
    project?: string;
    status?: string;
    archived?: string;
    subagents?: string;
    sort?: 'recent' | 'running';
    offset?: number;
    limit?: number;
  }) {
    await this.refresh();
    let list = this.visible(query.subagents === 'true');
    list = list.filter(
      (s) => query.archived === 'all' || s.archived === (query.archived === 'true'),
    );
    if (query.q) {
      const q = query.q.toLowerCase();
      list = list.filter((s) =>
        [s.title, s.cwd, s.id, s.preview].some((x) => x.toLowerCase().includes(q)),
      );
    }
    if (query.project) list = list.filter((s) => s.cwd === query.project);
    if (query.status && query.status !== 'all')
      list = list.filter((s) => s.status === query.status);
    list.sort(
      (a, b) =>
        (query.sort === 'recent'
          ? 0
          : Number(b.status === 'running') - Number(a.status === 'running')) ||
        b.updatedAt - a.updatedAt,
    );
    const offset = query.offset ?? 0,
      limit = query.limit ?? 60;
    return {
      sessions: list.slice(offset, offset + limit).map((s) => publicSession(s)),
      total: list.length,
      hasMore: offset + limit < list.length,
    };
  }
  async get(id: string): Promise<InternalSession | undefined> {
    if (!validId(id)) return;
    await this.refresh();
    return this.sessions.find((s) => s.id === id);
  }
  async usageSessions() {
    await this.refresh();
    return this.sessions.map((s) => ({ ...publicSession(s), subagent: s.subagent }));
  }
  async notificationSessions() {
    await this.refresh();
    return this.sessions;
  }
}
