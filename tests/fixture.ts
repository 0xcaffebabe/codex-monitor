import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../server/config.js';
export const ids = {
  modern: '11111111-1111-4111-8111-111111111111',
  legacy: '22222222-2222-4222-8222-222222222222',
  archived: '33333333-3333-4333-8333-333333333333',
  child: '44444444-4444-4444-8444-444444444444',
  outside: '55555555-5555-4555-8555-555555555555',
};
export function fixture(root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-test-'))) {
  const home = path.join(root, 'codex'),
    data = path.join(root, 'data');
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  mkdirSync(data, { recursive: true });
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  state.exec(
    `PRAGMA journal_mode=WAL;CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,created_at INTEGER,updated_at INTEGER,updated_at_ms INTEGER,archived INTEGER,tokens_used INTEGER,source TEXT,model TEXT,preview TEXT,first_user_message TEXT,agent_role TEXT,history_mode TEXT);`,
  );
  const hist = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  hist.exec(
    `PRAGMA journal_mode=WAL;CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,started_at INTEGER,completed_at INTEGER,PRIMARY KEY(thread_id,turn_id));CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,started_at_ms INTEGER,completed_at_ms INTEGER,PRIMARY KEY(thread_id,turn_id,item_id));CREATE TABLE thread_realtime_items(thread_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,PRIMARY KEY(thread_id,item_id));`,
  );
  const now = Date.now();
  for (const [key, id] of Object.entries(ids)) {
    const file =
      key === 'outside'
        ? path.join(root, 'private.jsonl')
        : path.join(home, 'sessions', `rollout-${id}.jsonl`);
    const name =
      key === 'modern'
        ? '开发 codex-monitor 实时监控'
        : key === 'legacy'
          ? '检查旧版本会话解析'
          : key === 'archived'
            ? '已归档的历史会话'
            : key === 'child'
              ? '内部子代理任务'
              : '不可访问的外部文件';
    const records = [
      {
        type: 'session_meta',
        timestamp: new Date(now).toISOString(),
        payload: { id, cwd: 'D:/project/codex-monitor', timestamp: new Date(now).toISOString() },
      },
      {
        type: 'response_item',
        timestamp: new Date(now).toISOString(),
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '请检查历史会话' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: new Date(now).toISOString(),
        payload: { type: 'task_started' },
      },
      {
        type: 'response_item',
        timestamp: new Date(now).toISOString(),
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-legacy',
          arguments: '{"cmd":"npm test"}',
        },
      },
      {
        type: 'response_item',
        timestamp: new Date(now).toISOString(),
        payload: {
          type: 'function_call_output',
          call_id: 'call-legacy',
          output: 'legacy tests passed',
        },
      },
      {
        type: 'response_item',
        timestamp: new Date(now).toISOString(),
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: key === 'outside' ? 'SECRET_OUTSIDE_FILE' : '旧版会话读取成功。',
            },
          ],
        },
      },
      {
        type: 'event_msg',
        timestamp: new Date(now).toISOString(),
        payload: { type: 'task_complete' },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (key === 'modern' || key === 'child') {
      const stamp = now - 90000;
      const tokenUsage = { input_tokens: 100000, cached_input_tokens: 90000, output_tokens: 1200, reasoning_output_tokens: 300, total_tokens: 101200 };
      const usageRecords = [
        { type: 'turn_context', timestamp: new Date(stamp).toISOString(), payload: { model: 'gpt-6.1-sol' } },
        { type: 'response_item', timestamp: new Date(stamp + 15000).toISOString(), payload: { type: 'message', role: 'assistant', content: [] } },
        { type: 'event_msg', timestamp: new Date(stamp + 15000).toISOString(), payload: { type: 'item_completed', item: { type: 'AgentMessage' }, started_at_ms: stamp + 5000 } },
        { type: 'token_usage_record', timestamp: new Date(stamp + 35000).toISOString(), payload: { thread_id: id, response_id: 'fixture-' + id, usage: tokenUsage, thread_token_usage: tokenUsage } },
        { type: 'event_msg', timestamp: new Date(stamp + 35001).toISOString(), payload: { type: 'token_count', info: { last_token_usage: tokenUsage, total_token_usage: tokenUsage } } },
      ];
      writeFileSync(file, [records[0], ...usageRecords, ...records.slice(1)].map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    state
      .prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        name,
        'D:/project/' + (key === 'legacy' ? 'sample-project' : 'codex-monitor'),
        file,
        Math.floor(now / 1000) - 3600,
        Math.floor(now / 1000),
        now,
        key === 'archived' ? 1 : 0,
        12800,
        key === 'child' ? '[{"subagent":true}]' : 'vscode',
        'gpt-6.1-sol',
        '验证会话内容与执行进度',
        '请开发这个应用',
        null,
        key === 'modern' ? 'paginated' : 'legacy',
      );
  }
  hist
    .prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)')
    .run(ids.modern, 'turn-1', 1, 'inProgress', Math.floor(now / 1000), null);
  const items = [
    {
      type: 'userMessage',
      id: 'user-1',
      content: [{ type: 'text', text: '请开发一个实时会话监控应用。' }],
    },
    {
      type: 'agentMessage',
      id: 'agent-1',
      text: '已接入本机会话。\n\n| 项目 | 结果 |\n|---|---|\n| 权限 | 通过 |\n\n<script>window.__xss=true</script>\n\n![tracker](https://example.com/tracker.png)',
      phase: 'commentary',
    },
    {
      type: 'commandExecution',
      id: 'tool-1',
      command: 'npm test',
      aggregatedOutput: 'All tests passed.\n✓ authentication verified',
      exitCode: 0,
      status: 'completed',
      durationMs: 1200,
    },
    { type: 'reasoning', id: 'reasoning-1', summary: ['检查权限边界并验证分页。'] },
    {
      type: 'commandExecution',
      id: 'tool-fail',
      command: 'exit 1',
      aggregatedOutput: 'Expected fixture failure',
      exitCode: 1,
      status: 'failed',
    },
  ];
  for (let i = 0; i < items.length; i++)
    hist
      .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(
        ids.modern,
        'turn-1',
        items[i].id,
        i + 1,
        now - 10000 + i * 1000,
        JSON.stringify(items[i]),
        now - 10000 + i * 1000,
        now - 9000 + i * 1000,
      );
  const config: Config = {
    codexHome: home,
    dataDir: data,
    host: '127.0.0.1',
    port: 0,
    origins: [],
    sessionDays: 90,
    pollMs: 500,
    secure: false,
  };
  return {
    root,
    home,
    data,
    state,
    hist,
    config,
    append(text: string) {
      const n =
        Number(hist.prepare('SELECT MAX(rollout_ordinal) AS n FROM thread_items').get()!.n) + 1;
      const item = { type: 'agentMessage', id: `live-${n}`, text, phase: 'commentary' };
      hist
        .prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
        .run(
          ids.modern,
          'turn-1',
          item.id,
          n,
          Date.now(),
          JSON.stringify(item),
          Date.now(),
          Date.now(),
        );
      state
        .prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?')
        .run(Math.floor(Date.now() / 1000), Date.now(), ids.modern);
      appendFileSync(
        path.join(home, 'sessions', `rollout-${ids.modern}.jsonl`),
        JSON.stringify({
          type: 'response_item',
          timestamp: new Date().toISOString(),
          payload: { type: 'message', role: 'assistant', content: [{ text }] },
        }) + '\n',
      );
    },
    close() {
      state.close();
      hist.close();
    },
  };
}
