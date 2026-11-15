import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ids } from './fixture.js';

export const screenshot =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPwmJZHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEvsMEwbybntAAAAAElFTkSuQmCC';
export const screenshotB =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY8UAAAAASUVORK5CYII=';
export function computerUseRecords(
  index: number,
  images = index === 1 ? 0 : index === 2 ? 2 : 1,
  time = Date.now() - 60000,
) {
  const id = `cu-${index}`,
    stamp = time + index * 1000;
  const title = ['打开业务页面', '填写查询条件', '查看查询结果'][index] ?? `浏览操作 ${index + 1}`;
  const args = { code: "await tab.playwright.getByRole('button', {name:'查询'}).click();", title };
  const item = {
    type: 'mcpToolCall',
    id,
    server: 'cua_repl',
    tool: 'js',
    status: 'completed',
    arguments: args,
    durationMs: 120,
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            content: [{ type: 'text', text: `页面状态：${title}` }],
            _meta: {
              'codex/toolSurface': {
                kind: 'browserUse',
                backend: 'chrome',
                openTabs: [{ id: 10, title: '业务查询', url: 'https://example.test/query' }],
                screenshot: {
                  tabId: '10',
                  pageUrl: 'https://example.test/query',
                  url: screenshot.slice(0, 40) + '…1000 chars truncated…',
                },
              },
            },
          }),
        },
      ],
    },
  };
  const records = [
    {
      type: 'response_item',
      timestamp: new Date(stamp).toISOString(),
      payload: {
        type: 'function_call',
        name: 'js',
        namespace: 'mcp__cua_repl',
        call_id: id,
        arguments: JSON.stringify(args),
      },
    },
    {
      type: 'event_msg',
      timestamp: new Date(stamp + 120).toISOString(),
      payload: { type: 'item_completed', started_at_ms: stamp, completed_at_ms: stamp + 120, item },
    },
    {
      type: 'response_item',
      timestamp: new Date(stamp + 120).toISOString(),
      payload: {
        type: 'function_call_output',
        call_id: id,
        output: [
          { type: 'input_text', text: `页面状态：${title}` },
          ...Array.from({ length: images }, (_, n) => ({
            type: 'input_image',
            image_url: n ? screenshotB : screenshot,
          })),
        ],
      },
    },
  ];
  return { id, stamp, item, records };
}
export function seedComputerUse(
  home: string,
  hist: DatabaseSync,
  count = 3,
  threadId = ids.modern,
) {
  const file = path.join(home, 'sessions', `rollout-${threadId}.jsonl`),
    time = Date.now() - count * 1000 - 10000;
  for (let i = 0; i < count; i++) {
    const row = computerUseRecords(i, undefined, time);
    hist
      .prepare(
        'INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,started_at_ms,completed_at_ms) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        threadId,
        'turn-1',
        row.id,
        100 + i,
        row.stamp,
        JSON.stringify(row.item),
        row.stamp,
        row.stamp + 120,
      );
    appendFileSync(file, row.records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  }
  return file;
}
