import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSource } from '../server/source.js';
import { fixture, ids } from './fixture.js';

const initial = 'codex-monitor 这个项目都是读取 codex 的数据库吗，自己有没有数据库';
const followup = '继续检查 <配置> & 路径\n附件说明';
function delegated(name: string, prompt: string, type = 'functionCallOutput') {
  const escaped = prompt.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return {
    type,
    namespace: 'codex_app',
    name,
    output: `<codex_delegation>\n  <source_thread_id>${ids.legacy}</source_thread_id>\n  <source_orbit_id>test-orbit</source_orbit_id>\n  <input>${escaped}</input>\n</codex_delegation>`,
  };
}
function cleanup(f: ReturnType<typeof fixture>, source: CodexSource) {
  source.close();
  f.close();
  assert.ok(path.resolve(f.root).startsWith(path.join(os.tmpdir(), 'codex-monitor-test-')));
  rmSync(f.root, { recursive: true, force: true });
}

for (const metadata of [true, false])
  test(`delegated launch and follow-up survive history projection, paging, outline and export (${metadata ? 'current' : 'legacy'} schema)`, async () => {
    const f = fixture();
    f.hist.prepare('DELETE FROM thread_items WHERE thread_id=?').run(ids.modern);
    const items = [
      { ...delegated('create_thread', initial), id: 'launch' },
      { type: 'agentMessage', id: 'reply-1', text: '有自己的本地数据库。', phase: 'final' },
      {
        type: 'commandExecution',
        id: 'ordinary-tool',
        command: 'inspect config',
        aggregatedOutput: 'SECRET_TOOL_RESULT',
      },
      { ...delegated('send_message_to_thread', followup, 'function_call_output'), id: 'follow-up' },
      { type: 'agentMessage', id: 'reply-2', text: '已检查。', phase: 'final' },
      {
        ...delegated('create_thread', 'SECRET_OTHER_NAMESPACE'),
        id: 'other-namespace',
        namespace: 'other',
      },
      {
        type: 'functionCallOutput',
        id: 'ordinary-output',
        namespace: 'codex_app',
        name: 'read_thread',
        output: 'SECRET_OTHER_TOOL',
      },
      {
        type: 'functionCallOutput',
        id: 'malformed',
        namespace: 'codex_app',
        name: 'create_thread',
        output: 'SECRET_NOT_A_PROMPT',
      },
    ];
    for (let i = 0; i < items.length; i++)
      f.hist
        .prepare(
          'INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json) VALUES(?,?,?,?,?,?)',
        )
        .run(ids.modern, 'turn-1', items[i].id, i + 10, Date.now() + i, JSON.stringify(items[i]));
    if (metadata)
      f.hist.exec(
        "ALTER TABLE thread_items ADD COLUMN item_type TEXT; UPDATE thread_items SET item_type=json_extract(item_json,'$.type')",
      );
    const source = new CodexSource(f.home);
    try {
      const events = [];
      let before: number | undefined;
      for (;;) {
        const page = (await source.detail(ids.modern, before, 2))!;
        assert.deepEqual(page.warnings, []);
        events.unshift(...page.events);
        if (page.before === null) break;
        before = page.before;
      }
      assert.deepEqual(
        events.filter((event) => event.kind === 'user').map((event) => event.text),
        [initial, followup],
      );
      assert.equal(events.filter((event) => event.kind === 'tool').length, 4);
      const outline = (await source.outline(ids.modern))!;
      assert.equal(outline.entries.length, 2);
      assert.equal(outline.entries[0].id, 'launch');
      assert.equal(outline.entries[0].ordinal, 10);
      assert.equal(outline.entries[0].prompt, initial);
      assert.equal(outline.entries[0].reply, '有自己的本地数据库。');
      assert.equal(outline.entries[0].tools, 1);
      assert.equal(outline.entries[1].id, 'follow-up');
      assert.equal(outline.entries[1].prompt, followup);
      assert.equal(outline.entries[1].tools, 3);
      const exported = (await source.export(ids.modern))!;
      assert.ok(exported.includes(initial));
      assert.ok(exported.includes(followup));
      assert.equal((exported.match(/## 你 ·/g) ?? []).length, 2);
      assert.ok(!JSON.stringify(events).includes('SECRET_'));
      assert.ok(!exported.includes('SECRET_'));
      assert.ok(!exported.includes('<codex_delegation>'));

      f.hist
        .prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)')
        .run(
          ids.modern,
          'live-input',
          100,
          Date.now(),
          JSON.stringify(delegated('send_message_to_thread', '实时追加提问')),
        );
      assert.equal(
        (await source.detail(ids.modern))!.events.find((event) => event.id === 'live-input')?.text,
        '实时追加提问',
      );
    } finally {
      cleanup(f, source);
    }
  });

test('JSONL launch prompts survive output handling and duplicate projected records', async () => {
  const f = fixture();
  const payload = {
    ...delegated('create_thread', initial, 'function_call_output'),
    id: 'legacy-launch',
  };
  writeFileSync(
    path.join(f.home, 'sessions', `rollout-${ids.legacy}.jsonl`),
    [
      { type: 'session_meta', payload: { id: ids.legacy, cwd: 'D:/work' } },
      { type: 'response_item', payload },
      {
        type: 'event_msg',
        payload: { type: 'item_completed', item: { ...payload, type: 'functionCallOutput' } },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'ordinary-tool',
          name: 'exec_command',
          arguments: '{"cmd":"inspect"}',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'ordinary-tool',
          output: 'SECRET_LEGACY_RESULT',
        },
      },
      {
        type: 'response_item',
        payload: {
          ...delegated('send_message_to_thread', followup, 'function_call_output'),
          id: 'legacy-follow-up',
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const source = new CodexSource(f.home);
  try {
    const page = (await source.detail(ids.legacy))!;
    assert.deepEqual(
      page.events.filter((event) => event.kind === 'user').map((event) => event.text),
      [initial, followup],
    );
    assert.equal(page.events.find((event) => event.id === 'ordinary-tool')?.status, 'completed');
    assert.deepEqual(
      (await source.outline(ids.legacy))!.entries.map((entry) => entry.prompt),
      [initial, followup],
    );
    assert.ok((await source.export(ids.legacy))!.includes(initial));
    assert.ok(!JSON.stringify(page).includes('SECRET_LEGACY_RESULT'));
  } finally {
    cleanup(f, source);
  }
});
