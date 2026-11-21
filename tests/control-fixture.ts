import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DesktopControl } from '../server/desktop.js';
import { ControlError } from '../server/control-error.js';
import type { CodexModel, SessionCreationSettings, SessionMessageSettings } from '../src/types.js';
import type { SessionPermissionMode } from '../src/approval-types.js';
import type { fixture } from './fixture.js';

export const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export class FixtureDesktop implements DesktopControl {
  readonly desktopChannel = true;
  readonly messagePermissions = true;
  sends = 0;
  creates = 0;
  lastCreation: SessionCreationSettings = {};
  lastSend: SessionMessageSettings = {};
  compactions = 0;
  interruptions = 0;
  compacting = false;
  owner: 'monitor' | 'desktop' | undefined = 'desktop';
  private permissionModes = new Map<string, Exclude<SessionPermissionMode, 'inherit'>>();
  goals = new Map<string, any>();
  constructor(
    private f: ReturnType<typeof fixture>,
    private compactMs = 0,
    private projectPath = 'D:/work',
  ) {}
  async projects() {
    return [{ id: projectId, name: 'work', path: this.projectPath }];
  }
  async models(): Promise<CodexModel[]> {
    return [
      {
        model: 'gpt-6.1-sol',
        displayName: 'GPT-6.1 Sol',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        model: 'gpt-6-luna',
        displayName: 'GPT-6 Luna',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ];
  }
  async state(_context: string, id: string): ReturnType<DesktopControl['state']> {
    const turn = this.f.hist
      .prepare(
        'SELECT turn_id,status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1',
      )
      .get(id);
    return {
      status: this.compacting || turn?.status === 'inProgress' ? 'active' : 'idle',
      compacting: this.compacting,
      turnId: turn?.turn_id as string | undefined,
      permissionMode: this.permissionModes.get(id),
      owner: this.f.state.prepare('SELECT source FROM threads WHERE id=?').get(id)?.source === 'cli'
        ? 'monitor'
        : this.owner,
    };
  }
  async send(_context: string, id: string, prompt: string, settings: SessionMessageSettings = {}) {
    if (this.compacting)
      throw new ControlError(
        'ActiveTurnNotSteerable { turn_kind: Compact }',
        false,
        409,
        'compacting',
      );
    this.sends++;
    this.lastSend = { ...settings };
    if (settings.model)
      this.f.state.prepare('UPDATE threads SET model=? WHERE id=?').run(settings.model, id);
    const state = await this.state('', id),
      turnId = state.status === 'active' ? state.turnId! : randomUUID();
    if (state.status !== 'active')
      this.f.hist
        .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
        .run(id, turnId, this.sends + 10, 'inProgress', Math.floor(Date.now() / 1000), null);
    for (const item of [
      { type: 'userMessage', content: [{ type: 'text', text: prompt }] },
      { type: 'agentMessage', text: '测试回复：' + prompt, phase: 'final' },
    ]) {
      const ordinal = Number(
        this.f.hist
          .prepare(
            'SELECT COALESCE(MAX(rollout_ordinal),0)+1 AS n FROM thread_items WHERE thread_id=?',
          )
          .get(id)!.n,
      );
      const itemId = randomUUID();
      this.f.hist
        .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
        .run(
          id,
          turnId,
          itemId,
          ordinal,
          Date.now(),
          JSON.stringify({ ...item, id: itemId }),
          null,
          null,
        );
    }
    this.f.hist
      .prepare(
        "UPDATE thread_turns SET status='completed',completed_at=? WHERE thread_id=? AND turn_id=?",
      )
      .run(Math.floor(Date.now() / 1000), id, turnId);
    this.f.state
      .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
      .run(Math.floor(Date.now() / 1000), Date.now(), id);
    if (settings.permissionMode && settings.permissionMode !== 'inherit')
      this.permissionModes.set(id, settings.permissionMode);
    return { threadId: id };
  }
  async create(
    context: string,
    selectedProject: string,
    prompt: string,
    settings: SessionCreationSettings = {},
  ) {
    const project = (await this.projects()).find(({ id }) => id === selectedProject);
    if (!project) throw new Error('Invalid fixture project');
    this.creates++;
    this.lastCreation = { ...settings };
    const id = randomUUID(),
      file = path.join(this.f.home, 'sessions', `rollout-${id}.jsonl`),
      now = Date.now();
    writeFileSync(
      file,
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: project.path } }) + '\n',
    );
    this.f.state
      .prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        prompt.slice(0, 70),
        project.path,
        file,
        Math.floor(now / 1000),
        Math.floor(now / 1000),
        now,
        0,
        0,
        'cli',
        settings.model ?? 'fixture-model',
        prompt,
        prompt,
        null,
        'paginated',
      );
    await this.send(context, id, prompt);
    return { threadId: id };
  }
  async goal(id: string, action: 'get' | 'set' | 'pause' | 'resume' | 'clear', objective?: string) {
    if (action === 'get') return this.goals.get(id) ?? null;
    if (action === 'clear') {
      this.goals.delete(id);
      return null;
    }
    const previous = this.goals.get(id);
    const goal = {
      threadId: id,
      objective: objective ?? previous?.objective ?? '',
      status: action === 'pause' ? 'paused' : 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    this.goals.set(id, goal);
    return goal;
  }
  async compact() {
    this.compactions++;
    if (this.compactMs) {
      this.compacting = true;
      setTimeout(() => {
        this.compacting = false;
      }, this.compactMs).unref();
    }
  }
  async interrupt(id: string, turnId: string) {
    const state = await this.state('', id);
    if (state.status !== 'active' || state.turnId !== turnId) return { interruptedTurnId: null };
    this.interruptions++;
    this.compacting = false;
    this.f.hist
      .prepare(
        "UPDATE thread_turns SET status='interrupted',completed_at=? WHERE thread_id=? AND turn_id=?",
      )
      .run(Math.floor(Date.now() / 1000), id, turnId);
    const goal = this.goals.get(id);
    if (goal?.status === 'active') goal.status = 'paused';
    this.f.state
      .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
      .run(Math.floor(Date.now() / 1000), Date.now(), id);
    return { interruptedTurnId: turnId };
  }
}
