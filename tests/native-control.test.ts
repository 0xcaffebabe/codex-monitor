import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeDesktopControl } from '../server/native-control.js';
import { ControlError } from '../server/control-error.js';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTick } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { generateSessionTitle } from '../server/session-title.js';

class AppServerProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: { id?: number | string; method?: string; params?: any; result?: any; error?: any }[] =
    [];
  stdin = new Writable({
    write: (data, _encoding, done) => {
      const request = JSON.parse(String(data));
      this.requests.push(request);
      if (request.id !== undefined && request.method) {
        const result =
          request.method === 'thread/start' || request.method === 'thread/read'
            ? { thread: { id: this.threadId, status: { type: 'active' } } }
            : request.method === 'turn/start'
              ? { turn: { id: 'turn', status: 'inProgress' } }
              : {};
        queueMicrotask(() => this.send({ id: request.id, result }));
      }
      done();
    },
  });
  constructor(readonly threadId: string) {
    super();
  }
  send(value: object) {
    this.stdout.write(JSON.stringify(value) + '\n');
  }
  kill() {
    this.emit('exit', 0);
    return true;
  }
  unref() {}
}

function fixture(
  generateTitle: typeof generateSessionTitle = async () => undefined,
  permissionDb?: DatabaseSync,
) {
  const calls: { method: string; params: any }[] = [],
    ownerCalls: any[] = [],
    desktopCalls: any[] = [],
    desktopCreates: any[] = [];
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
    dispose: async () => {
      f.disposals++;
    },
  };
  const f = {
    calls,
    ownerCalls,
    desktopCalls,
    desktopCreates,
    desktopProjects: [{ id: 'desktop-project', name: '项目', path: '/tmp/project with spaces' }],
    desktopError: undefined as Error | undefined,
    disposals: 0,
    native,
    activity: { turnId: 'turn', running: true, compacting: false },
    ownerReply: { result: { turn: { id: 'turn' } } } as any,
    ownerError: undefined as Error | undefined,
    control: null as unknown as NativeDesktopControl,
    setGoal(value: any) {
      goal = value;
    },
    goal: () => goal,
    setStatus(value: string) {
      status = value;
    },
  };
  f.control = new NativeDesktopControl(
    { codexHome: '/tmp/codex', activity: () => f.activity, permissionDb },
    {
      native,
      generateTitle,
      owner: async (...args) => {
        ownerCalls.push(args);
        if (f.ownerError) throw f.ownerError;
        return f.ownerReply;
      },
      desktop: {
        projects: async () => f.desktopProjects,
        state: async () => ({ status: 'notLoaded' }),
        create: async (...args) => {
          desktopCreates.push(args);
          if (f.desktopError) throw f.desktopError;
          return { threadId: 'desktop-thread' };
        },
        send: async (...args) => {
          desktopCalls.push(args);
          if (f.desktopError) throw f.desktopError;
          return { threadId: args[1] };
        },
      },
    },
  );
  return f;
}

test('desktop message selection uses desktop tools with model settings and never falls back', async () => {
  const f = fixture();
  try {
    assert.equal(f.control.desktopChannel, true);
    assert.deepEqual(
      await f.control.send('', 'thread', 'use the browser', {
        channel: 'desktop',
        model: 'gpt-6.1-sol',
        thinking: 'high',
      }),
      { threadId: 'thread' },
    );
    assert.deepEqual(f.desktopCalls, [
      ['thread', 'thread', 'use the browser', { model: 'gpt-6.1-sol', thinking: 'high' }],
    ]);
    for (const uncertain of [false, true]) {
      f.desktopError = new ControlError('desktop unavailable', uncertain, 503);
      await assert.rejects(
        f.control.send('context', 'thread', 'retry using desktop', { channel: 'desktop' }),
        (error: any) => error === f.desktopError,
      );
    }
    assert.deepEqual(f.ownerCalls, []);
    assert.deepEqual(f.calls, []);
  } finally {
    f.control.close();
  }
});

test('running desktop owners accept immediate desktop input without creating a CLI runtime', async () => {
  const f = fixture();
  try {
    f.setStatus('notLoaded');
    f.setGoal({ status: 'active' });
    const state = await f.control.state('context', 'desktop-thread');
    assert.equal(state.status, 'active');
    assert.equal(state.owner, 'desktop');
    await f.control.send('context', 'desktop-thread', 'append while working', {
      channel: 'desktop',
    });
    assert.deepEqual(f.desktopCalls, [['context', 'desktop-thread', 'append while working', {}]]);
    assert.equal(f.disposals, 0);
    assert.ok(f.calls.every((call) => call.method === 'thread/read'));
  } finally {
    f.control.close();
  }
});

test('selected desktop creation delegates the first message and reports errors without CLI fallback', async () => {
  const f = fixture();
  try {
    if (process.platform === 'win32')
      f.desktopProjects[0].path = path
        .toNamespacedPath(path.resolve('/tmp/project with spaces'))
        .toUpperCase();
    assert.deepEqual(
      await f.control.create('caller', 'project', 'first desktop task', {
        channel: 'desktop',
        model: 'gpt-6.1-sol',
        thinking: 'high',
        permissionMode: 'inherit',
      }),
      { threadId: 'desktop-thread' },
    );
    assert.deepEqual(f.desktopCreates, [
      [
        'caller',
        'desktop-project',
        'first desktop task',
        { model: 'gpt-6.1-sol', thinking: 'high' },
      ],
    ]);
    await assert.rejects(
      f.control.create('caller', 'project', 'explicit permissions', {
        channel: 'desktop',
        permissionMode: 'danger-full-access',
      }),
      /桌面端的权限设置/,
    );
    assert.equal(f.desktopCreates.length, 1);
    for (const uncertain of [false, true]) {
      f.desktopError = new ControlError('desktop create rejected', uncertain, 502);
      await assert.rejects(
        f.control.create('caller', 'project', 'do not retry through CLI', { channel: 'desktop' }),
        (error: any) => error === f.desktopError,
      );
    }
    assert.ok(f.calls.every((call) => call.method === 'project/list'));
    assert.deepEqual(f.desktopCalls, []);
    assert.deepEqual(f.ownerCalls, []);
  } finally {
    f.control.close();
  }
});

test('desktop handoff waits for an idle CLI writer to exit and preserves native creation', async () => {
  const f = fixture();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.control.create('', 'project', 'first CLI message');
    assert.equal(f.desktopCalls.length, 0);
    f.setStatus('idle');
    f.native.dispose = async () => {
      await released;
      f.disposals++;
    };
    const sent = f.control.send('caller', 'thread', 'continue on desktop', { channel: 'desktop' });
    for (let i = 0; i < 5; i++) await nextTick();
    assert.equal(f.desktopCalls.length, 0, 'must wait until the CLI process has exited');
    release();
    await sent;
    assert.equal(f.disposals, 1);
    assert.deepEqual(f.desktopCalls, [['caller', 'thread', 'continue on desktop', {}]]);
    assert.equal(f.calls.filter((c) => c.method === 'turn/start').length, 1);
    assert.equal(f.calls.filter((c) => c.method === 'thread/resume').length, 0);
  } finally {
    release();
    f.control.close();
  }
});

test('desktop creation rejects missing and ambiguous directory mappings before sending', async () => {
  const f = fixture();
  try {
    f.desktopProjects = [];
    await assert.rejects(
      f.control.create('caller', 'project', 'task', { channel: 'desktop' }),
      /未找到此项目目录/,
    );
    f.desktopProjects = [
      { id: 'one', name: 'one', path: '/tmp/project with spaces' },
      { id: 'two', name: 'two', path: '/tmp/project with spaces' },
    ];
    await assert.rejects(
      f.control.create('caller', 'project', 'task', { channel: 'desktop' }),
      /多个对应目录/,
    );
    assert.deepEqual(f.desktopCreates, []);
    assert.ok(f.calls.every((call) => call.method === 'project/list'));
  } finally {
    f.control.close();
  }
});

test('desktop selection leaves running CLI turns and active goals intact until they finish', async () => {
  const f = fixture();
  try {
    await f.control.create('', 'project', 'keep working');
    f.setStatus('active');
    assert.equal((await f.control.state('', 'thread')).owner, 'monitor');
    await assert.rejects(
      f.control.send('', 'thread', 'desktop next', { channel: 'desktop' }),
      (error: any) => error.code === 'desktop_busy' && !error.uncertain,
    );
    f.setStatus('idle');
    f.setGoal({ status: 'active' });
    await assert.rejects(
      f.control.send('', 'thread', 'desktop next', { channel: 'desktop' }),
      (error: any) => error.code === 'desktop_busy',
    );
    assert.equal(f.disposals, 0);
    assert.equal(f.desktopCalls.length, 0);
    f.setGoal({ status: 'paused' });
    await f.control.send('', 'thread', 'desktop next', { channel: 'desktop' });
    assert.equal(f.disposals, 1);
    assert.equal(f.desktopCalls.length, 1);
  } finally {
    f.control.close();
  }
});

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
  const control = new NativeDesktopControl(
    { codexHome: '/tmp/codex', activity: () => undefined },
    {
      native: metadata,
      generateTitle: async () => undefined,
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

test('native creation uses project identity and preserves permissions when inherit is selected', async () => {
  const f = fixture();
  assert.deepEqual(
    await f.control.create('context', 'project', 'hello', {
      model: 'model',
      thinking: 'high',
      permissionMode: 'inherit',
    }),
    { threadId: 'thread' },
  );
  assert.deepEqual(f.calls.find((c) => c.method === 'thread/start')?.params, {
    cwd: '/tmp/project with spaces',
    projectId: 'project',
    model: 'model',
  });
  const start = f.calls.find((c) => c.method === 'turn/start')!;
  assert.equal(start.params.threadId, 'thread');
  assert.deepEqual(start.params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  assert.equal(start.params.effort, 'high');
  assert.equal(start.params.approvalPolicy, undefined);
  assert.equal(start.params.sandboxPolicy, undefined);
  assert.equal(f.ownerCalls.length, 0);
  await assert.rejects(f.control.create('context', 'missing-project', 'hello'), /项目不可用/);
});

test('new sessions save a generated native name in the background without adding conversation turns', async () => {
  let finish!: (title: string) => void;
  const title = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const inputs: any[] = [];
  const f = fixture(async (input) => {
    inputs.push(input);
    return title;
  });
  try {
    assert.deepEqual(await f.control.create('', 'project', '排查内存统计', { model: 'model' }), {
      threadId: 'thread',
    });
    assert.equal(inputs[0].prompt, '排查内存统计');
    assert.equal(inputs[0].cwd, '/tmp/project with spaces');
    assert.equal(inputs[0].model, 'model');
    assert.equal(
      f.calls.some((call) => call.method === 'thread/name/set'),
      false,
    );
    finish('修复内存统计');
    await nextTick();
    assert.deepEqual(f.calls.find((call) => call.method === 'thread/name/set')?.params, {
      threadId: 'thread',
      name: '修复内存统计',
    });
    assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 1);
    assert.equal(f.calls.filter((call) => call.method === 'thread/resume').length, 0);
    await f.control.send('', 'thread', '继续');
    assert.equal(inputs.length, 1, 'continuations do not regenerate the title');
  } finally {
    f.control.close();
  }
});

test('late title results preserve existing names and cannot write after shutdown', async () => {
  for (const mode of ['renamed', 'closed', 'empty', 'failed']) {
    let finish!: (title: string | undefined) => void;
    let signal: AbortSignal | undefined;
    const title = new Promise<string | undefined>((resolve) => {
      finish = resolve;
    });
    const f = fixture(async (input) => {
      signal = input.signal;
      if (mode === 'failed') throw new Error('title unavailable');
      return title;
    });
    const warn = test.mock.method(console, 'warn', () => {});
    try {
      await f.control.create('', 'project', 'hello');
      if (mode === 'renamed') {
        const request = f.native.request;
        f.native.request = async (method, params) =>
          method === 'thread/read'
            ? { thread: { id: params.threadId, name: '用户保存的名称' } }
            : request(method, params);
      }
      if (mode === 'closed') {
        f.control.close();
        assert.equal(signal?.aborted, true);
      }
      finish(mode === 'empty' ? undefined : '自动标题');
      await nextTick();
      assert.equal(
        f.calls.some((call) => call.method === 'thread/name/set'),
        false,
        mode,
      );
      assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 1);
    } finally {
      f.control.close();
      warn.mock.restore();
    }
  }
});

test('explicit creation permissions configure the native sandbox and route approvals to the user', async () => {
  const f = fixture();
  try {
    for (const permissionMode of [
      'read-only',
      'workspace-write',
      'workspace-write-network',
    ] as const) {
      await f.control.create('', 'project', 'task', { permissionMode });
      const start = f.calls.filter((call) => call.method === 'thread/start').at(-1)!.params;
      assert.equal(start.sandbox, permissionMode === 'read-only' ? 'read-only' : 'workspace-write');
      assert.equal(start.approvalPolicy, 'on-request');
      assert.equal(start.approvalsReviewer, 'user');
      assert.equal(
        start.config['sandbox_workspace_write.network_access'],
        permissionMode === 'workspace-write-network',
      );
      assert.equal(start.permissions, undefined);
    }
  } finally {
    f.control.close();
  }
});

test('shared app-server sessions wait for human command, file, and permission decisions and reply on the original connection', async () => {
  const f = fixture();
  const child = new AppServerProcess('thread');
  const control = new NativeDesktopControl(
    { codexHome: '/unused/codex', activity: () => undefined },
    {
      native: f.native,
      launch: () => child as unknown as ChildProcessWithoutNullStreams,
      generateTitle: async () => undefined,
    },
  );
  try {
    await control.create('', 'project', 'task', { permissionMode: 'read-only' });
    const initialize = child.requests.find((request) => request.method === 'initialize')!;
    assert.equal(initialize.params.capabilities.requiredHumanApproval, true);
    const threadStart = child.requests.find((request) => request.method === 'thread/start')!;
    assert.equal(threadStart.params.approvalPolicy, 'on-request');
    assert.equal(threadStart.params.approvalsReviewer, 'user');
    for (const kind of ['commandExecution', 'fileChange', 'permissions'] as const) {
      for (const decision of ['accept', 'decline'] as const) {
        const requestId = `${kind}-${decision}`;
        const params = {
          threadId: 'thread',
          turnId: 'turn',
          itemId: requestId,
          cwd: '/project',
          ...(kind === 'commandExecution' ? { command: 'npm test' } : {}),
          ...(kind === 'permissions' ? { permissions: { network: { enabled: true } } } : {}),
        };
        if (kind === 'fileChange')
          child.send({
            method: 'item/started',
            params: {
              threadId: 'thread',
              turnId: 'turn',
              item: {
                id: requestId,
                type: 'fileChange',
                changes: [{ path: '/project/file.txt', diff: '+hello', kind: { type: 'add' } }],
              },
            },
          });
        child.send({ id: requestId, method: `item/${kind}/requestApproval`, params });
        await nextTick();
        const [approval] = control.approvals.list('thread');
        assert.ok(approval, `${kind} reaches the shared web approval store`);
        assert.equal(approval.canAccept, true);
        assert.equal(
          child.requests.some((request) => request.id === requestId),
          false,
          'the server request must wait for a human decision',
        );
        control.approvals.answer('thread', approval.id, decision);
        await nextTick();
        const reply = child.requests.find((request) => request.id === requestId);
        assert.deepEqual(reply, {
          id: requestId,
          result:
            kind === 'permissions'
              ? {
                  permissions: decision === 'accept' ? params.permissions : {},
                  scope: 'turn',
                }
              : { decision },
        });
        assert.deepEqual(control.approvals.list('thread'), []);
      }
    }
  } finally {
    control.close();
    f.control.close();
  }
});

test('shared app-server approvals stay with their own thread and are cancelled when that runtime exits', async () => {
  const f = fixture();
  const children: AppServerProcess[] = [];
  const control = new NativeDesktopControl(
    { codexHome: '/unused/codex', activity: () => undefined },
    {
      native: f.native,
      launch: () => {
        const child = new AppServerProcess(`thread-${children.length}`);
        children.push(child);
        return child as unknown as ChildProcessWithoutNullStreams;
      },
      generateTitle: async () => undefined,
    },
  );
  try {
    await control.create('', 'project', 'first', { permissionMode: 'workspace-write' });
    await control.create('', 'project', 'second', { permissionMode: 'workspace-write' });
    for (const [index, child] of children.entries())
      child.send({
        id: 'same-server-request-id',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: `thread-${index}`,
          turnId: 'turn',
          itemId: 'command',
          command: 'npm test',
        },
      });
    await nextTick();
    const [first] = control.approvals.list('thread-0');
    const [second] = control.approvals.list('thread-1');
    assert.ok(first);
    assert.ok(second);
    control.approvals.answer('thread-0', first.id, 'accept');
    await nextTick();
    assert.deepEqual(children[0].requests.at(-1), {
      id: 'same-server-request-id',
      result: { decision: 'accept' },
    });
    assert.equal(
      children[1].requests.some((request) => request.id === 'same-server-request-id'),
      false,
    );
    children[1].send({
      id: 'wrong-thread',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-0', turnId: 'turn', itemId: 'command', command: 'npm test' },
    });
    await nextTick();
    assert.match(children[1].requests.at(-1)!.error.message, /不属于此会话运行时/);
    assert.deepEqual(control.approvals.list('thread-0'), []);
    children[1].emit('exit', 1);
    await nextTick();
    assert.equal(control.approvals.get('thread-1', second.id).state, 'cancelled');
    assert.throws(() => control.approvals.answer('thread-1', second.id, 'accept'), /过期或取消/);
  } finally {
    control.close();
    f.control.close();
  }
});

test('native sessions inherit permissions unless full access is explicitly requested', async () => {
  const f = fixture();
  try {
    await f.control.create('', 'project', 'task', {});
    const inherited = f.calls.filter((call) => call.method === 'thread/start').at(-1)!.params;
    assert.equal(inherited.sandbox, undefined);
    assert.equal(inherited.approvalPolicy, undefined);
    await f.control.create('', 'project', 'task', { permissionMode: 'danger-full-access' });
    const explicit = f.calls.filter((call) => call.method === 'thread/start').at(-1)!.params;
    assert.equal(explicit.sandbox, 'danger-full-access');
    assert.equal(explicit.approvalPolicy, 'never');
  } finally {
    f.control.close();
  }
});

test('idle Monitor turns map each permission mode to the Codex sandbox and approval policy', async () => {
  const f = fixture();
  f.ownerError = new ControlError('no owner', false, 409, 'no_owner');
  try {
    for (const [permissionMode, sandboxPolicy, approvalPolicy] of [
      ['read-only', { type: 'readOnly', networkAccess: false }, 'on-request'],
      ['workspace-write', { type: 'workspaceWrite', networkAccess: false }, 'on-request'],
      ['workspace-write-network', { type: 'workspaceWrite', networkAccess: true }, 'on-request'],
      ['danger-full-access', { type: 'dangerFullAccess' }, 'never'],
    ] as const) {
      f.setStatus('idle');
      await f.control.send('', 'thread', 'continue', { permissionMode });
      assert.equal(f.calls.at(-1)?.method, 'turn/start');
      const { sandboxPolicy: actualSandbox, approvalPolicy: actualApproval, approvalsReviewer } = f.calls.at(-1)!.params;
      assert.deepEqual(actualSandbox, sandboxPolicy);
      assert.equal(actualApproval, approvalPolicy);
      assert.equal(approvalsReviewer, 'user');
    }
    assert.equal(f.calls.filter(({ method }) => method === 'thread/resume').length, 1);
    assert.equal(f.ownerCalls[0][1], 'thread-follower-read-model-settings');
    await assert.rejects(f.control.send('', 'thread', 'append', { permissionMode: 'read-only' }), /空闲/);
    await f.control.send('', 'thread', 'append with existing permissions');
    assert.equal(f.calls.at(-1)?.params.sandboxPolicy, undefined);
    assert.equal(f.calls.at(-1)?.params.approvalPolicy, undefined);

    await assert.rejects(f.control.send('', 'thread', 'desktop', {
      channel: 'desktop', permissionMode: 'read-only',
    }), /桌面通道/);
    assert.equal(f.desktopCalls.length, 0);
    f.ownerError = undefined;
    const nativeCalls = f.calls.length;
    await assert.rejects(f.control.send('', 'desktop-thread', 'wrong owner', { permissionMode: 'read-only' }), /桌面端持有/);
    assert.equal(f.calls.length, nativeCalls);
    assert.equal(f.ownerCalls.at(-1)[1], 'thread-follower-read-model-settings');
  } finally {
    f.control.close();
  }
});

test('resuming a Monitor session restores its last confirmed permission without affecting other sessions', async () => {
  const permissionDb = new DatabaseSync(':memory:');
  const original = fixture(undefined, permissionDb);
  const resumed = fixture(undefined, permissionDb);
  const noWriter = new ControlError('no owner', false, 409, 'no_owner');
  try {
    original.ownerError = noWriter;
    await original.control.send('', 'thread', 'enable network', { permissionMode: 'workspace-write-network' });
    await assert.rejects(original.control.send('', 'thread', 'cannot change during a turn', {
      permissionMode: 'danger-full-access',
    }), /空闲/);
    original.control.close();

    resumed.ownerError = noWriter;
    assert.equal((await resumed.control.state('', 'thread')).permissionMode, 'workspace-write-network');
    await resumed.control.send('', 'thread', 'continue using saved permission');
    await resumed.control.send('', 'other-thread', 'keep local defaults');
    assert.deepEqual(resumed.calls.filter(({ method }) => method === 'thread/resume').map(({ params }) => params), [
      {
        threadId: 'thread',
        excludeTurns: true,
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        config: { 'sandbox_workspace_write.network_access': true },
      },
      { threadId: 'other-thread', excludeTurns: true },
    ]);
    assert.ok(resumed.calls.filter(({ method }) => method === 'turn/start').every(
      ({ params }) => !('sandboxPolicy' in params),
    ));
    resumed.setStatus('idle');
    await resumed.control.send('', 'thread', 'use desktop defaults', { channel: 'desktop' });
    assert.deepEqual(resumed.desktopCalls.at(-1), ['thread', 'thread', 'use desktop defaults', {}]);
  } finally {
    original.control.close();
    resumed.control.close();
    permissionDb.close();
  }
});

test('existing desktop threads use the owner, and uncertain sends never fall back to a second writer', async () => {
  const f = fixture();
  await f.control.send('context', 'desktop-thread', 'append');
  assert.equal(f.ownerCalls[0][1], 'thread-follower-start-turn');
  assert.equal(f.ownerCalls[0][3], 2);
  assert.deepEqual(f.ownerCalls[0][2].turnStart.request.input, [
    { type: 'text', text: 'append', text_elements: [] },
  ]);
  assert.equal(f.calls.length, 0);
  f.ownerError = new ControlError('owner disappeared after dispatch', true, 409, 'no_owner');
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
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'turn/start').map((c) => c.params.input),
    ['first', 'second'].map((text) => [{ type: 'text', text, text_elements: [] }]),
  );
});

test('owner status distinguishes live turns from old persisted turn ids without reading full history', async () => {
  const f = fixture();
  f.setStatus('notLoaded');
  assert.equal((await f.control.state('context', 'desktop-thread')).status, 'active');
  f.activity.running = false;
  assert.equal((await f.control.state('context', 'desktop-thread')).status, 'notLoaded');
  assert.equal(f.ownerCalls.length, 1, 'completed records do not need owner discovery');
  const ownerOptions = { inspectOwner: true };
  const idle = await f.control.state('context', 'desktop-thread', ownerOptions);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.owner, 'desktop');
  f.ownerError = new ControlError('owner timed out', false, 504);
  const completed = await f.control.state('context', 'desktop-thread', ownerOptions);
  assert.equal(completed.status, 'notLoaded');
  assert.equal(completed.owner, undefined);
  assert.equal(
    f.calls.every((c) => c.params.includeTurns === false),
    true,
  );
  f.activity.running = true;
  f.ownerError = new ControlError('no owner', false, 409, 'no_owner');
  const unloaded = await f.control.state('context', 'desktop-thread');
  assert.equal(unloaded.status, 'notLoaded');
  assert.equal(unloaded.canAttemptResume, true);
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
