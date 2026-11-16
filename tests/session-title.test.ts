import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTick } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { generateSessionTitle, type SessionTitleInput } from '../server/session-title.js';

class TitleProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  requests: { id: number; method: string; params: any }[] = [];
  onTurn = () => {};
  result = (method: string): any => {
    if (method === 'config/read')
      return { config: { model: 'configured', mcp_servers: { external: { command: 'tool' } } } };
    if (method === 'model/list')
      return {
        data: [
          { model: 'configured', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
          { model: 'selected', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
        ],
      };
    if (method === 'thread/start') return { thread: { id: 'temporary' } };
    if (method === 'turn/start') return { turn: { id: 'title-turn', status: 'inProgress' } };
    return {};
  };
  stdin = new Writable({
    write: (data, _encoding, done) => {
      const request = JSON.parse(String(data));
      this.requests.push(request);
      if (request.id)
        queueMicrotask(() => {
          if (request.method === 'turn/start') this.onTurn();
          this.emitMessage({ id: request.id, result: this.result(request.method) });
        });
      done();
    },
  });
  emitMessage(value: object) {
    this.stdout.write(JSON.stringify(value) + '\n');
  }
  complete(text: string, status = 'completed') {
    this.emitMessage({
      method: 'item/completed',
      params: {
        threadId: 'temporary',
        turnId: 'title-turn',
        item: { type: 'agentMessage', text },
      },
    });
    this.emitMessage({
      method: 'turn/completed',
      params: { threadId: 'temporary', turn: { id: 'title-turn', status, items: [] } },
    });
  }
  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0);
    return true;
  }
  unref() {}
}

function fixture(overrides: Partial<SessionTitleInput> = {}) {
  const child = new TitleProcess();
  const controller = new AbortController();
  const input = {
    codexHome: '/tmp/codex',
    cwd: '/tmp/project',
    prompt: '请帮我分析 macOS 内存使用情况并修复统计口径',
    signal: controller.signal,
    ...overrides,
  };
  return {
    child,
    controller,
    input,
    generate: () =>
      generateSessionTitle(input, () => child as unknown as ChildProcessWithoutNullStreams),
  };
}

test('title generation uses a temporary read-only thread, configured model and final structured output', async () => {
  const f = fixture();
  const pending = f.generate();
  try {
    await nextTick();
    const start = f.child.requests.find((request) => request.method === 'thread/start')!.params;
    assert.equal(start.ephemeral, true);
    assert.equal(start.threadSource, 'thread_title');
    assert.equal(start.model, 'configured');
    assert.equal(start.sandbox, 'read-only');
    assert.equal(start.approvalPolicy, 'never');
    assert.deepEqual(start.runtimeWorkspaceRoots, []);
    assert.deepEqual(start.config.mcp_servers, { external: { enabled: false } });
    assert.equal(start.config['features.hooks'], false);
    assert.equal(start.config['features.plugins'], false);
    assert.equal(start.config['features.shell_tool'], false);
    assert.equal(start.config.web_search, 'disabled');
    const turn = f.child.requests.find((request) => request.method === 'turn/start')!.params;
    assert.equal(turn.threadId, 'temporary');
    assert.equal(turn.effort, 'low');
    assert.equal(JSON.parse(turn.input[0].text).userMessage, f.input.prompt);
    assert.equal(turn.outputSchema.additionalProperties, false);
    f.child.emitMessage({
      method: 'turn/completed',
      params: { threadId: 'another-thread', turn: { id: 'title-turn', status: 'failed' } },
    });
    f.child.emitMessage({
      method: 'turn/completed',
      params: { threadId: 'temporary', turn: { id: 'another-turn', status: 'failed' } },
    });
    f.child.emitMessage({
      method: 'item/completed',
      params: {
        threadId: 'temporary',
        turnId: 'title-turn',
        item: { type: 'agentMessage', phase: 'commentary', text: '{"title":"错误的进展标题"}' },
      },
    });
    f.child.complete('{"title":"  修复 macOS\n内存统计  "}'.replace('\n', '\\n'));
    assert.equal(await pending, '修复 macOS 内存统计');
    assert.equal(f.child.killed, true);
  } finally {
    f.controller.abort();
    await pending;
  }
});

test('title results can arrive before turn acknowledgement or inside a completed turn response', async () => {
  for (const mode of ['notification', 'response']) {
    const f = fixture({ model: 'selected' });
    if (mode === 'notification') f.child.onTurn = () => f.child.complete('{"title":"概括任务"}');
    else {
      const original = f.child.result;
      f.child.result = (method) =>
        method === 'turn/start'
          ? {
              turn: {
                id: 'title-turn',
                status: 'completed',
                items: [{ type: 'agentMessage', text: '{"title":"概括任务"}' }],
              },
            }
          : original(method);
    }
    assert.equal(await f.generate(), '概括任务');
    const start = f.child.requests.find((request) => request.method === 'thread/start')!.params;
    assert.equal(start.model, 'selected');
    assert.equal(start.config.model_reasoning_effort, 'medium', 'respect supported effort levels');
    assert.equal(f.child.killed, true);
  }
});

test('invalid or failed title output is ignored and long Unicode titles stay bounded', async () => {
  for (const [text, status, expected] of [
    ['not JSON', 'completed', undefined],
    ['{"title":42}', 'completed', undefined],
    ['{"title":"   "}', 'completed', undefined],
    ['{"title":"不要保存"}', 'failed', undefined],
    [JSON.stringify({ title: '😀'.repeat(80) }), 'completed', '😀'.repeat(60)],
  ] as const) {
    const f = fixture();
    f.child.onTurn = () => f.child.complete(text, status);
    assert.equal(await f.generate(), expected);
    assert.equal(f.child.killed, true);
  }
});

test('aborting, timing out and disconnecting title generation release its process', async () => {
  for (const reason of ['abort', 'timeout', 'disconnect']) {
    const f = fixture(reason === 'timeout' ? { timeoutMs: 30 } : {});
    const pending = f.generate();
    await nextTick();
    if (reason === 'abort') f.controller.abort();
    if (reason === 'disconnect') f.child.emit('exit', 1);
    assert.equal(await pending, undefined);
    assert.equal(f.child.killed, true);
  }
  const f = fixture();
  f.controller.abort();
  assert.equal(await f.generate(), undefined);
  assert.equal(f.child.requests.length, 0);
});
