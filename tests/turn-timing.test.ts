import assert from 'node:assert/strict';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CodexSource } from '../server/source.js';
import { fixture, ids } from './fixture.js';

for (const metadata of [true, false])
  test(`turn timing follows the latest human prompt across history pages (${metadata ? 'current' : 'legacy'} schema)`, async () => {
    const f = fixture();
    if (metadata) {
      f.hist.exec('ALTER TABLE thread_items ADD COLUMN item_type TEXT');
      f.hist.exec("UPDATE thread_items SET item_type=json_extract(item_json,'$.type')");
    }
    const source = new CodexSource(f.home);
    const startedAt = Math.floor(Date.now() / 1000) * 1000 - 120000;
    try {
      f.hist
        .prepare('UPDATE thread_items SET created_at_ms=? WHERE thread_id=? AND item_id=?')
        .run(startedAt, ids.modern, 'user-1');
      const first = (await source.detail(ids.modern, undefined, 2))!;
      assert.ok(!first.events.some((event) => event.kind === 'user'));
      assert.deepEqual(first.turnTiming, { startedAt, finishedAt: null });
      assert.deepEqual(
        (await source.detail(ids.modern, first.before!, 2))!.turnTiming,
        first.turnTiming,
      );

      const nextStart = startedAt + 60000;
      f.hist
        .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
        .run(ids.modern, 'turn-2', 2, 'inProgress', nextStart / 1000 + 5, null);
      const items = [
        {
          type: 'function_call_output',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          output: `<codex_delegation><source_thread_id>${ids.legacy}</source_thread_id><input>继续检查</input></codex_delegation>`,
        },
        { type: 'agentMessage', text: '继续处理。' },
        {
          type: 'functionCallOutput',
          namespace: 'codex_app',
          name: 'create_thread',
          output: 'Not a human prompt',
        },
        { type: 'commandExecution', command: 'npm test' },
      ];
      for (const [index, item] of items.entries()) {
        const id = `next-${index}`;
        f.hist
          .prepare(
            'INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,completed_at_ms) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            ids.modern,
            'turn-2',
            id,
            10 + index,
            nextStart + index * 1000,
            JSON.stringify(item),
            nextStart + index * 1000 + 500,
          );
        if (metadata)
          f.hist
            .prepare('UPDATE thread_items SET item_type=? WHERE thread_id=? AND item_id=?')
            .run(item.type, ids.modern, id);
      }
      await source.refresh(true);
      assert.deepEqual((await source.detail(ids.modern, undefined, 1))!.turnTiming, {
        startedAt: nextStart,
        finishedAt: null,
      });
      // Metadata updates after completion must not extend the duration.
      f.state
        .prepare('UPDATE threads SET updated_at_ms=? WHERE id=?')
        .run(nextStart + 3600000, ids.modern);
      for (const status of ['completed', 'interrupted', 'failed']) {
        f.hist
          .prepare(
            'UPDATE thread_turns SET status=?,completed_at=? WHERE thread_id=? AND turn_id=?',
          )
          .run(status, nextStart / 1000 + 12, ids.modern, 'turn-2');
        await source.refresh(true);
        assert.deepEqual((await source.detail(ids.modern, undefined, 1))!.turnTiming, {
          startedAt: nextStart,
          finishedAt: nextStart + 12000,
        });
      }
      f.hist
        .prepare('UPDATE thread_turns SET completed_at=NULL WHERE thread_id=? AND turn_id=?')
        .run(ids.modern, 'turn-2');
      assert.deepEqual((await source.detail(ids.modern, undefined, 1))!.turnTiming, {
        startedAt: nextStart,
        finishedAt: nextStart + 3500,
      });
    } finally {
      source.close();
      f.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

test('rollout timing uses the original prompt timestamp, stops at completion and resets on follow-up', async () => {
  const f = fixture(),
    source = new CodexSource(f.home),
    file = path.join(f.home, 'sessions', `rollout-${ids.legacy}.jsonl`),
    startedAt = Date.now() - 120000;
  const record = (offset: number, type: string, payload: unknown) =>
    JSON.stringify({ timestamp: new Date(startedAt + offset).toISOString(), type, payload }) + '\n';
  try {
    writeFileSync(
      file,
      record(-30000, 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ text: '上一轮' }],
      }) +
        record(-20000, 'event_msg', { type: 'task_complete' }) +
        record(0, 'response_item', {
          type: 'message',
          role: 'user',
          content: [{ text: '最近一轮' }],
        }) +
        record(2000, 'event_msg', { type: 'user_message', message: '最近一轮' }) +
        record(4000, 'event_msg', { type: 'task_started' }) +
        record(12000, 'event_msg', { type: 'task_complete' }) +
        record(30000, 'event_msg', { type: 'context_compacted' }),
    );
    const completed = (await source.detail(ids.legacy, undefined, 1))!;
    assert.equal(completed.events.length, 1);
    assert.equal(completed.events[0].kind, 'system');
    assert.deepEqual(completed.turnTiming, { startedAt, finishedAt: startedAt + 12000 });
    assert.deepEqual(
      (await source.detail(ids.legacy, completed.before!, 1))!.turnTiming,
      completed.turnTiming,
    );
    appendFileSync(
      file,
      record(40000, 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ text: '跟进问题' }],
      }) + record(45000, 'event_msg', { type: 'turn_started' }),
    );
    assert.deepEqual((await source.detail(ids.legacy, undefined, 1))!.turnTiming, {
      startedAt: startedAt + 40000,
      finishedAt: null,
    });
    appendFileSync(file, record(55000, 'event_msg', { type: 'turn_aborted' }));
    assert.deepEqual((await source.detail(ids.legacy, undefined, 1))!.turnTiming, {
      startedAt: startedAt + 40000,
      finishedAt: startedAt + 55000,
    });
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('sessions without a valid human prompt have no turn timing', async () => {
  const f = fixture(),
    source = new CodexSource(f.home);
  try {
    f.hist
      .prepare('UPDATE thread_items SET created_at_ms=0 WHERE thread_id=? AND item_id=?')
      .run(ids.modern, 'user-1');
    assert.equal((await source.detail(ids.modern))!.turnTiming, undefined);
    writeFileSync(
      path.join(f.home, 'sessions', `rollout-${ids.legacy}.jsonl`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete' },
      }) + '\n',
    );
    assert.equal((await source.detail(ids.legacy))!.turnTiming, undefined);
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
