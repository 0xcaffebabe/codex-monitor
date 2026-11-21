import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTick } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { launchAppServer, NativeRpc } from '../server/native.js';
import { ControlError } from '../server/control-error.js';
import { NativeApprovals } from '../server/native-approvals.js';

class GoalProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  respond = true;
  requests: { id?: number | string; method: string; params: any; error?: any; result?: any }[] = [];
  result = (request: { method: string; params: any }): unknown =>
    request.method === 'initialize' ? {} : { goal: { objective: 'test', status: 'active' } };
  stdin = new Writable({
    write: (data, _encoding, done) => {
      const request = JSON.parse(String(data));
      this.requests.push(request);
      if (this.respond && request.id && request.method)
        queueMicrotask(() =>
          this.stdout.write(
            JSON.stringify({
              id: request.id,
              result: this.result(request),
            }) + '\n',
          ),
        );
      done();
    },
  });
  kill() {
    this.killed = true;
    return true;
  }
  unref() {}
}

test('native launch falls back after synchronous and asynchronous executable permission errors', async () => {
  const attempts: string[] = [];
  const started = new GoalProcess();
  const blocked = new GoalProcess();
  const child = await launchAppServer(
    ['desktop-cli', 'desktop-cli', 'blocked-cli', 'terminal-cli', 'cached-cli'],
    { CODEX_HOME: 'test-home' },
    new AbortController().signal,
    (file, args, options) => {
      attempts.push(file);
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      assert.equal(options.env?.CODEX_HOME, 'test-home');
      if (file === 'desktop-cli') throw Object.assign(new Error('spawn failed'), { code: 'EPERM' });
      if (file === 'blocked-cli') {
        queueMicrotask(() =>
          blocked.emit('error', Object.assign(new Error('spawn failed'), { code: 'EACCES' })),
        );
        return blocked as unknown as ChildProcessWithoutNullStreams;
      }
      queueMicrotask(() => started.emit('spawn'));
      return started as unknown as ChildProcessWithoutNullStreams;
    },
  );
  assert.deepEqual(attempts, ['desktop-cli', 'blocked-cli', 'terminal-cli']);
  assert.equal(child, started);
});

test('closing during CLI discovery prevents a later candidate from starting', async () => {
  const abort = new AbortController();
  const closed = new ControlError('cancelled');
  async function* candidates() {
    await nextTick();
    abort.abort(closed);
    yield 'terminal-cli';
  }
  await assert.rejects(
    launchAppServer(candidates(), {}, abort.signal, () => {
      assert.fail('CLI started after close');
    }),
    closed,
  );
});

test('project and model reads share a cold start that takes more than 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new GoalProcess();
  child.respond = false;
  child.result = () => ({ data: [] });
  let launches = 0;
  const rpc = new NativeRpc(undefined, () => {
    launches++;
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  try {
    const loading = Promise.allSettled([rpc.request('project/list', {}), rpc.models()]);
    await nextTick();
    assert.equal(launches, 1);
    assert.deepEqual(
      child.requests.map(({ method }) => method),
      ['initialize'],
    );
    t.mock.timers.tick(35_000);
    child.respond = true;
    child.stdout.write(JSON.stringify({ id: child.requests[0].id, result: {} }) + '\n');
    assert.deepEqual(await loading, [
      { status: 'fulfilled', value: { data: [] } },
      { status: 'fulfilled', value: [] },
    ]);
    assert.deepEqual(
      child.requests.map(({ method }) => method),
      ['initialize', 'initialized', 'project/list', 'model/list'],
    );
    assert.equal(child.killed, false);
  } finally {
    rpc.close();
  }
});

test('a timed-out initialization is released and the next read can start a new process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = new GoalProcess(),
    ready = new GoalProcess();
  slow.respond = false;
  ready.result = () => ({ data: [] });
  const children = [slow, ready];
  const rpc = new NativeRpc(
    undefined,
    () => children.shift() as unknown as ChildProcessWithoutNullStreams,
  );
  try {
    const rejected = assert.rejects(
      rpc.models(),
      (error: unknown) =>
        error instanceof ControlError &&
        error.status === 504 &&
        !error.uncertain &&
        /启动超时/.test(error.message),
    );
    await nextTick();
    t.mock.timers.tick(60_000);
    await rejected;
    assert.equal(slow.killed, true);
    assert.deepEqual(await rpc.models(), []);
    assert.equal(ready.killed, false);
  } finally {
    rpc.close();
  }
});

test('synchronous and asynchronous process launch errors report the OS code and allow retry', async () => {
  const child = new GoalProcess();
  child.respond = false;
  let launches = 0;
  const rpc = new NativeRpc(undefined, () => {
    if (++launches === 1) throw Object.assign(new Error('spawn failed'), { code: 'EAGAIN' });
    if (launches === 2) {
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn failed'), { code: 'EACCES' })),
      );
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    return new GoalProcess() as unknown as ChildProcessWithoutNullStreams;
  });
  const failedWith = (code: string) => (error: unknown) =>
    error instanceof ControlError && !error.uncertain && error.message.includes(code);
  try {
    await Promise.all([
      assert.rejects(rpc.request('project/list', {}), failedWith('EAGAIN')),
      assert.rejects(rpc.models(), failedWith('EAGAIN')),
    ]);
    await assert.rejects(rpc.models(), failedWith('EACCES'));
    assert.equal(child.killed, true);
    assert.equal((await rpc.get('test-thread')).status, 'active');
  } finally {
    rpc.close();
  }
});

test('late exits from an old goal process cannot kill its replacement and stdin errors reject pending work', async () => {
  const children: GoalProcess[] = [];
  const rpc = new NativeRpc(undefined, () => {
    const child = new GoalProcess();
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  try {
    assert.equal((await rpc.get('test-thread')).objective, 'test');
    rpc.close();
    assert.equal((await rpc.get('test-thread')).objective, 'test');
    children[0].emit('exit', 0);
    assert.equal(children[1].killed, false);
    assert.equal((await rpc.get('test-thread')).status, 'active');
    children[1].respond = false;
    const pending = rpc.get('test-thread');
    const rejection = assert.rejects(pending, /Codex 服务连接中断/);
    await nextTick();
    children[1].stdin.emit('error', new Error('EPIPE'));
    await rejection;
    assert.equal(children[1].killed, true);
    assert.equal((await rpc.get('test-thread')).objective, 'test');
  } finally {
    rpc.close();
  }
});

test('server requests cannot resolve a colliding client request or silently approve execution', async () => {
  const child = new GoalProcess();
  const rpc = new NativeRpc(undefined, () => child as unknown as ChildProcessWithoutNullStreams);
  try {
    await rpc.get('initial');
    child.respond = false;
    const pending = rpc.get('next');
    await nextTick();
    const id = child.requests.at(-1)!.id;
    child.stdout.write(
      JSON.stringify({
        id,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'test' },
      }) + '\n',
    );
    await nextTick();
    assert.equal(child.requests.at(-1)!.error.code, -32601);
    child.stdout.write(
      JSON.stringify({
        id,
        result: { goal: { objective: 'correct response', status: 'paused' } },
      }) + '\n',
    );
    assert.equal((await pending).objective, 'correct response');
    const compacting = rpc.request('turn/start', { threadId: 'next', input: [] });
    const rejected = assert.rejects(
      compacting,
      (error: unknown) =>
        error instanceof ControlError && error.code === 'compacting' && !error.uncertain,
    );
    await nextTick();
    child.stdout.write(
      JSON.stringify({
        id: child.requests.at(-1)!.id,
        error: { message: 'ActiveTurnNotSteerable { turn_kind: Compact }' },
      }) + '\n',
    );
    await rejected;
  } finally {
    rpc.close();
  }
});

test('native approval callbacks wait for the original human answer without colliding with client response ids', async () => {
  const child = new GoalProcess(),
    approvals = new NativeApprovals();
  const rpc = new NativeRpc(undefined, () => child as unknown as ChildProcessWithoutNullStreams, {
    request: (method, params, signal) => approvals.request(method, params, signal),
  });
  try {
    await rpc.get('initial');
    child.respond = false;
    const pending = rpc.get('next');
    await nextTick();
    const id = child.requests.at(-1)!.id;
    const before = child.requests.length;
    child.stdout.write(
      JSON.stringify({
        id,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'item',
          cwd: '/project',
          permissions: { network: { enabled: true } },
        },
      }) + '\n',
    );
    await nextTick();
    assert.equal(child.requests.length, before, 'no answer before the user acts');
    const [approval] = approvals.list('thread');
    approvals.answer('thread', approval.id, 'accept');
    await nextTick();
    assert.deepEqual(child.requests.at(-1), {
      id,
      result: { permissions: { network: { enabled: true } }, scope: 'turn' },
    });
    child.stdout.write(
      JSON.stringify({
        id,
        result: { goal: { objective: 'actual client response', status: 'paused' } },
      }) + '\n',
    );
    assert.equal((await pending).objective, 'actual client response');
    child.stdout.write(
      JSON.stringify({
        id: 'resolved-approval',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'test' },
      }) + '\n',
    );
    await nextTick();
    const last = approvals.list('thread')[0];
    child.stdout.write(
      JSON.stringify({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread', requestId: 'resolved-approval' },
      }) + '\n',
    );
    await nextTick();
    assert.equal(approvals.get('thread', last.id).state, 'cancelled');
    assert.equal(
      child.requests.some((request) => request.id === 'resolved-approval'),
      false,
    );
  } finally {
    rpc.close();
    approvals.close();
  }
});

test('a disconnected native runtime cancels approvals and cannot answer through its replacement', async () => {
  const children: GoalProcess[] = [],
    approvals = new NativeApprovals();
  const rpc = new NativeRpc(
    undefined,
    () => {
      const child = new GoalProcess();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    { request: (method, params, signal) => approvals.request(method, params, signal) },
  );
  try {
    await rpc.get('initial');
    children[0].stdout.write(
      JSON.stringify({
        id: 'old-approval',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'test' },
      }) + '\n',
    );
    await nextTick();
    const [pending] = approvals.list('thread');
    rpc.close();
    await rpc.get('replacement');
    assert.equal(approvals.get('thread', pending.id).state, 'cancelled');
    assert.throws(() => approvals.answer('thread', pending.id, 'accept'));
    assert.equal(
      children[1].requests.some((request) => request.id === 'old-approval'),
      false,
    );
  } finally {
    rpc.close();
    approvals.close();
  }
});

test('model discovery paginates, hides unavailable entries, and preserves model-specific effort options', async () => {
  const child = new GoalProcess();
  child.result = ({ method, params }) =>
    method === 'initialize'
      ? {}
      : params.cursor
        ? {
            data: [
              {
                model: 'quick',
                displayName: 'Quick',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              },
            ],
            nextCursor: null,
          }
        : {
            data: [
              { model: 'hidden', hidden: true },
              {
                model: 'deep',
                displayName: 'Deep',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'ultra' },
                  { reasoningEffort: 'high' },
                  { reasoningEffort: 'high' },
                  { reasoningEffort: 'unsupported' },
                  null,
                ],
              },
            ],
            nextCursor: 'next',
          };
  const rpc = new NativeRpc(undefined, () => child as unknown as ChildProcessWithoutNullStreams);
  try {
    assert.deepEqual(await rpc.models(), [
      { model: 'deep', displayName: 'Deep', supportedReasoningEfforts: ['ultra', 'high'] },
      { model: 'quick', displayName: 'Quick', supportedReasoningEfforts: ['low'] },
    ]);
    assert.deepEqual(
      child.requests
        .filter((request) => request.method === 'model/list')
        .map((request) => request.params),
      [
        { includeHidden: false, limit: 100 },
        { includeHidden: false, limit: 100, cursor: 'next' },
      ],
    );
    child.result = () => ({ data: [], nextCursor: 'repeated' });
    await assert.rejects(rpc.models(), /模型列表分页异常/);
    child.respond = false;
    const pending = rpc.models();
    const rejection = assert.rejects(
      pending,
      (error: unknown) => error instanceof ControlError && !error.uncertain,
    );
    await nextTick();
    child.stdin.emit('error', new Error('EPIPE'));
    await rejection;
  } finally {
    rpc.close();
  }
});
