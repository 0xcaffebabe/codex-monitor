import test from 'node:test';
import assert from 'node:assert/strict';
import { MacDesktopControl } from '../server/macos-control.js';
import { ControlError } from '../server/control-error.js';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTick } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

function fixture() {
  const calls: { method: string; params: any }[] = [],
    ownerCalls: any[] = [];
  let status = 'idle',
    goal: any = null;
  const native = {
    request: async (method: string, params: any): Promise<any> => {
      calls.push({ method, params });
      if (method === 'project/list')
        return {
          data: [{ id: 'project', name: '项目', roots: [{ path: '/tmp/project with spaces' }] }],
        };
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'thread/read')
        return { thread: { id: params.threadId, status: { type: status } } };
      if (method === 'turn/start') {
        status = 'active';
        return { turn: { id: 'turn', status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') {
        status = 'idle';
        return {};
      }
      return {};
    },
    models: async () => [],
    get: async () => goal,
    set: async (_id: string, value: object) => (goal = { ...goal, ...value }),
    clear: async () => {
      goal = null;
    },
    close() {},
  };
  const f = {
    calls,
    ownerCalls,
    native,
    activity: { turnId: 'turn', running: true, compacting: false },
    ownerReply: { result: { turn: { id: 'turn' } } } as any,
    ownerError: undefined as Error | undefined,
    control: null as unknown as MacDesktopControl,
    setGoal(value: any) {
      goal = value;
    },
    goal: () => goal,
    setStatus(value: string) {
      status = value;
    },
  };
  f.control = new MacDesktopControl(
    { codexHome: '/tmp/codex', activity: () => f.activity },
    {
      native,
      owner: async (...args) => {
        ownerCalls.push(args);
        if (f.ownerError) throw f.ownerError;
        return f.ownerReply;
      },
    },
  );
  return f;
}

test('completed CLI threads release the writer for desktop handoff; active goals retain it', async () => {
  let status = 'idle',
    activeGoal = false,
    turn = 0,
    closedProcesses = 0;
  const methods: string[] = [];
  const goalWrites: any[] = [];
  let emit = (_value: object) => {};
  const metadata = fixture().native;
  metadata.get = async () => (activeGoal ? { status: 'active' } : null);
  const control = new MacDesktopControl(
    { codexHome: '/tmp/codex', activity: () => undefined },
    {
      native: metadata,
      launch: () => {
        const child = new EventEmitter() as any;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
          closedProcesses++;
          child.emit('exit', 0);
          return true;
        };
        child.unref = () => {};
        const send = (value: object) => child.stdout.write(JSON.stringify(value) + '\n');
        emit = send;
        child.stdin = new Writable({
          write(data, _encoding, done) {
            const { id, method, params } = JSON.parse(String(data));
            methods.push(method);
            let result: any = {};
            if (method === 'thread/start' || method === 'thread/read')
              result = { thread: { id: 'thread', status: { type: status } } };
            if (method === 'thread/resume') status = 'idle';
            if (method === 'thread/goal/set') {
              goalWrites.push(params);
              activeGoal = params.status === 'active';
              result = { goal: { status: params.status, objective: params.objective } };
            }
            if (method === 'thread/goal/clear') activeGoal = false;
            if (method === 'turn/start') {
              status = 'active';
              result = { turn: { id: `turn-${++turn}`, status: 'inProgress' } };
            }
            if (id) queueMicrotask(() => send({ id, result }));
            done();
          },
        });
        return child as ChildProcessWithoutNullStreams;
      },
      owner: async () => {
        throw new ControlError('No owner', false, 409, 'no_owner');
      },
    },
  );
  const finish = () => {
    status = 'idle';
    emit({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: `turn-${turn}`, status: 'completed' } },
    });
  };
  try {
    await control.create('', 'project', 'first');
    await control.goal('thread', 'set', 'two step goal');
    assert.equal(goalWrites.length, 1, 'goal changes use the owning runtime');
    assert.equal(
      goalWrites[0]?.origin,
      undefined,
      'the actual user message supplies goal intent without synthetic tool output',
    );
    await control.goal('thread', 'clear');
    finish();
    for (let i = 0; i < 50 && closedProcesses < 1; i++) await nextTick();
    assert.equal(closedProcesses, 1);
    await control.send('', 'thread', 'second');
    assert.equal(methods.filter((m) => m === 'thread/resume').length, 1);
    activeGoal = true;
    finish();
    for (let i = 0; i < 10; i++) await nextTick();
    assert.equal(closedProcesses, 1, 'must keep the active goal runtime alive');
    activeGoal = false;
    finish();
    for (let i = 0; i < 50 && closedProcesses < 2; i++) await nextTick();
    assert.equal(closedProcesses, 2);
    await control.send('', 'thread', 'third');
    assert.equal(status, 'active');
    assert.equal(
      methods.at(-1),
      'turn/start',
      'idle release must finish before a subsequent turn starts',
    );
  } finally {
    control.close();
  }
});

test('macOS creation uses native project identity, cwd and selected model without overriding permissions', async () => {
  const f = fixture();
  assert.deepEqual(
    await f.control.create('context', 'project', 'hello', { model: 'model', thinking: 'high' }),
    { threadId: 'thread' },
  );
  assert.deepEqual(f.calls.find((c) => c.method === 'thread/start')?.params, {
    cwd: '/tmp/project with spaces',
    projectId: 'project',
    model: 'model',
  });
  const start = f.calls.find((c) => c.method === 'turn/start')!;
  assert.equal(start.params.threadId, 'thread');
  assert.deepEqual(start.params.input, [{ type: 'text', text: 'hello' }]);
  assert.equal(start.params.effort, 'high');
  assert.equal(start.params.approvalPolicy, undefined);
  assert.equal(start.params.sandboxPolicy, undefined);
  assert.equal(f.ownerCalls.length, 0);
  await assert.rejects(f.control.create('context', 'missing-project', 'hello'), /项目不可用/);
});

test('existing desktop threads use the owner, and uncertain sends never fall back to a second writer', async () => {
  const f = fixture();
  await f.control.send('context', 'desktop-thread', 'append');
  assert.equal(f.ownerCalls[0][1], 'thread-follower-start-turn');
  assert.equal(f.ownerCalls[0][3], 2);
  assert.equal(f.calls.length, 0);
  f.ownerError = new ControlError('connection lost after dispatch', true);
  await assert.rejects(f.control.send('context', 'desktop-thread', 'append'));
  assert.equal(f.calls.length, 0, 'must not replay a possibly accepted input through CLI');
  f.ownerError = undefined;
  f.ownerReply = { result: {} };
  await assert.rejects(
    f.control.send('context', 'desktop-thread', 'append'),
    (e: unknown) => e instanceof ControlError && e.uncertain,
  );
});

test('unloaded threads resume only after a definite missing owner, and retain that writer for later input', async () => {
  const f = fixture();
  f.ownerError = new ControlError('no owner', false, 409, 'no_owner');
  await f.control.send('context', 'unloaded', 'first');
  await f.control.send('context', 'unloaded', 'second');
  assert.equal(f.ownerCalls.length, 1);
  assert.equal(f.calls.filter((c) => c.method === 'thread/resume').length, 1);
  assert.equal(f.calls.filter((c) => c.method === 'turn/start').length, 2);
});

test('owner status distinguishes live turns from old persisted turn ids without reading full history', async () => {
  const f = fixture();
  f.setStatus('notLoaded');
  assert.equal((await f.control.state('context', 'desktop-thread')).status, 'active');
  f.activity.running = false;
  assert.equal((await f.control.state('context', 'desktop-thread')).status, 'notLoaded');
  assert.equal(f.ownerCalls.length, 1, 'completed records do not need owner discovery');
  assert.equal(
    f.calls.every((c) => c.params.includeTurns === false),
    true,
  );
  f.activity.running = true;
  f.ownerError = new ControlError('no owner', false, 409, 'no_owner');
  assert.equal((await f.control.state('context', 'desktop-thread')).status, 'notLoaded');
  f.ownerError = new ControlError('owner timed out', false, 504);
  await assert.rejects(f.control.state('context', 'desktop-thread'), /timed out/);
});

test('stopping a native turn pauses a just-resumed goal and rejects a changed turn', async () => {
  const f = fixture();
  await f.control.create('context', 'project', 'hello');
  f.setGoal({ objective: 'test', createdAt: 1, status: 'active' });
  const stopped = await f.control.interrupt('thread', 'turn');
  assert.deepEqual(stopped, { interruptedTurnId: 'turn' });
  assert.equal(f.goal().status, 'paused');
  await assert.rejects(f.control.interrupt('thread', 'other-turn'), /轮次已变化/);
});

test('accepted native compaction blocks new input immediately, including before its first live event', async () => {
  const f = fixture();
  await f.control.create('context', 'project', 'hello');
  f.setStatus('idle');
  await f.control.compact('thread');
  assert.equal((await f.control.state('context', 'thread')).compacting, true);
  assert.equal(f.calls.at(-2)!.method, 'thread/compact/start');
});

test('stopping does not pause a replacement goal and reports an unconfirmed goal pause', async () => {
  const f = fixture();
  await f.control.create('context', 'project', 'hello');
  let reads = 0;
  f.native.get = async () =>
    ++reads === 1
      ? { objective: 'original', createdAt: 1, status: 'active' }
      : { objective: 'replacement', createdAt: 2, status: 'active' };
  const stopped = await f.control.interrupt('thread', 'turn');
  assert.match(stopped.goalPauseError!, /无法确认/);
  assert.equal(f.goal(), null);
});
