import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';

const settings = {
  enabled: true,
  webhookUrl:
    'https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  publicUrl: 'https://monitor.example.com/',
};
const questions = [
  {
    title: '输入提醒测试：选择一个方案',
    options: ['方案 A', '方案 B'],
    answers: ['SECRET_ANSWER_MUST_NOT_BE_SENT'],
  },
];
function addItem(
  f: ReturnType<typeof fixture>,
  item: Record<string, unknown>,
  sessionId = ids.modern,
  at = Date.now(),
) {
  const ordinal = Number(
    f.hist
      .prepare('SELECT COALESCE(MAX(rollout_ordinal),0)+1 AS n FROM thread_items WHERE thread_id=?')
      .get(sessionId)!.n,
  );
  const id = String(item.id ?? randomUUID());
  f.hist
    .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
    .run(sessionId, 'turn-1', id, ordinal, at, JSON.stringify({ ...item, id }), at, at);
  return { id, ordinal };
}
async function harness(status = 200) {
  const f = fixture();
  f.config.pollMs = 60000;
  const messages: string[] = [];
  const service = createApp(f.config, {
    webhookTransport: async (_url, init) => {
      messages.push(JSON.parse(String(init!.body)).content.text);
      return Response.json({ code: 0 }, { status });
    },
  });
  await service.notifications.configure(settings);
  return {
    f,
    service,
    messages,
    async close() {
      await service.close();
      f.close();
      rmSync(f.root, { recursive: true, force: true });
    },
  };
}

test('native async question forms notify with choices, stay separate from completion and deduplicate across restart', async () => {
  const h = await harness();
  let restarted: ReturnType<typeof createApp> | undefined;
  try {
    addItem(h.f, {
      type: 'agentMessage',
      text: '普通文本里提到问题不会触发提醒？',
      phase: 'commentary',
    });
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 0);
    const question = addItem(h.f, {
      type: 'agentMessage',
      questions,
      delivery: 'async',
      phase: 'final_answer',
      text: '请选择方案',
    });
    await h.service.pollNotifications();
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0], /Codex 需要你选择或回答/);
    assert.match(h.messages[0], /输入提醒测试/);
    assert.match(h.messages[0], /方案 A/);
    assert.match(h.messages[0], /方案 B/);
    assert.match(h.messages[0], new RegExp(ids.modern));
    assert.match(h.messages[0], /https:\/\/monitor.example.com\/\?session=/);
    assert.doesNotMatch(h.messages[0], /SECRET_ANSWER/);
    assert.equal(h.service.notifications.state().deliveries[0].kind, 'session.input_required');
    await h.service.close();
    restarted = createApp(h.f.config, {
      webhookTransport: async (_url, init) => {
        h.messages.push(String(init!.body));
        return Response.json({ code: 0 });
      },
    });
    await restarted.pollNotifications();
    assert.equal(h.messages.length, 1);
    assert.ok(restarted.notifications.store.has(`local:input:${ids.modern}:${question.id}`));
  } finally {
    await restarted?.close();
    await h.close();
  }
});

test('realtime questions and their persisted projections share one notification identity', async () => {
  const h = await harness();
  try {
    const id = randomUUID(),
      item = { id, type: 'agentMessage', questions, phase: 'final_answer', delivery: 'async' },
      at = Date.now();
    h.f.hist
      .prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)')
      .run(ids.modern, id, 6, at, JSON.stringify(item));
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 1);
    addItem(h.f, item);
    h.f.hist.prepare('DELETE FROM thread_realtime_items WHERE item_id=?').run(id);
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 1);
  } finally {
    await h.close();
  }
});

test('answered questions are skipped and answering cancels a queued retry without sending another reminder', async () => {
  const h = await harness(503);
  try {
    addItem(h.f, { type: 'agentMessage', questions, delivery: 'async' });
    addItem(h.f, { type: 'userMessage', content: [{ type: 'text', text: '方案 A' }] });
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 0);
    addItem(h.f, { type: 'agentMessage', questions, delivery: 'async' });
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 1);
    assert.equal(h.service.notifications.state().deliveries[0].status, 'pending');
    addItem(h.f, {
      type: 'functionCallOutput',
      namespace: 'codex_app',
      name: 'send_message_to_thread',
      output:
        '<codex_delegation><source_thread_id>test</source_thread_id><input>方案 B</input></codex_delegation>',
    });
    h.service.auth.db.prepare('UPDATE notification_deliveries SET next_attempt_at=0').run();
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 1);
    assert.equal(h.service.notifications.state().deliveries[0].status, 'cancelled');
  } finally {
    await h.close();
  }
});

test('old questions, subagents, archived sessions and disabled notifications do not alert', async () => {
  const h = await harness();
  try {
    addItem(h.f, { type: 'agentMessage', questions }, ids.modern, Date.now() - 60000);
    addItem(h.f, { type: 'agentMessage', questions }, ids.child);
    addItem(h.f, { type: 'agentMessage', questions }, ids.archived);
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 0);
    await h.service.notifications.configure({ ...settings, enabled: false });
    addItem(h.f, { type: 'agentMessage', questions });
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 0);
    await h.service.notifications.configure(settings);
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 0);
  } finally {
    await h.close();
  }
});

test('unanswered questions remain retryable beyond the five-minute scan overlap and cancel only after an answer', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const h = await harness(503);
  try {
    clock++;
    addItem(h.f, { type: 'agentMessage', questions, delivery: 'async' });
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 1);
    clock += 6 * 60000;
    h.service.auth.db.prepare('UPDATE notification_deliveries SET next_attempt_at=0').run();
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 2);
    assert.equal(h.service.notifications.state().deliveries[0].status, 'pending');
    addItem(h.f, { type: 'userMessage', content: [{ type: 'text', text: '方案 A' }] });
    h.service.auth.db.prepare('UPDATE notification_deliveries SET next_attempt_at=0').run();
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 2);
    assert.equal(h.service.notifications.state().deliveries[0].status, 'cancelled');
  } finally {
    await h.close();
  }
});

test('legacy blocking input and async input are recognized while answers clear the pending request', async () => {
  const h = await harness();
  const file = path.join(h.f.home, 'sessions', `rollout-${ids.legacy}.jsonl`);
  const append = (records: unknown[]) =>
    appendFileSync(
      file,
      records
        .map((record) =>
          JSON.stringify({ timestamp: new Date().toISOString(), ...(record as object) }),
        )
        .join('\n') + '\n',
    );
  try {
    append([
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'functions.request_user_input',
          call_id: 'input-1',
          arguments: JSON.stringify({
            questions: [
              { question: '选择输入方式', options: [{ label: '键盘' }, { label: '语音' }] },
            ],
          }),
        },
      },
    ]);
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0], /选择输入方式/);
    append([
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'input-1', output: 'SECRET_ANSWER' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'functions.request_user_input_async',
          call_id: 'input-2',
          arguments: JSON.stringify({ questions }),
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'input-2', output: 'request registered' },
      },
    ]);
    await h.service.pollNotifications();
    assert.equal(h.messages.length, 2);
    append([{ type: 'event_msg', payload: { type: 'user_message', message: '方案 A' } }]);
    const inputs = await h.service.source.inputRequests(
      h.service.notifications.store.config().inputSince,
    );
    assert.equal(inputs.length, 0);
  } finally {
    await h.close();
  }
});
