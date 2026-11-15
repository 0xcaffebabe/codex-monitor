import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { contextFromRollout } from '../server/context.js';
test('context reports the last request, handles compaction and never substitutes cumulative usage', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-context-')),
    file = path.join(root, 'rollout.jsonl');
  const record = (last: unknown) =>
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-11-14T05:20:00Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 9000000 },
          last_token_usage: last,
          model_context_window: 200000,
        },
      },
    }) + '\n';
  try {
    writeFileSync(
      file,
      record({
        input_tokens: 90000,
        output_tokens: 10000,
        reasoning_output_tokens: 5000,
        total_tokens: 100000,
      }),
    );
    const first = await contextFromRollout(file);
    assert.equal(first.usedTokens, 100000);
    assert.equal(first.limitTokens, 200000);
    assert.equal(first.percent, 50);
    appendFileSync(file, JSON.stringify({ type: 'compacted', payload: {} }) + '\n');
    assert.equal((await contextFromRollout(file)).percent, null);
    appendFileSync(file, record(null));
    assert.equal((await contextFromRollout(file)).usedTokens, null);
    appendFileSync(file, record({ input_tokens: 30000, output_tokens: 5000 }));
    assert.equal((await contextFromRollout(file)).percent, 17.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
