import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
    assert.equal(first.compactionCount, 0);
    appendFileSync(file, JSON.stringify({ type: 'compacted', payload: {} }) + '\n');
    const compacted = await contextFromRollout(file);
    assert.equal(compacted.percent, null);
    assert.equal(compacted.compactionCount, 1);
    appendFileSync(file, record(null));
    assert.equal((await contextFromRollout(file)).usedTokens, null);
    appendFileSync(file, record({ input_tokens: 30000, output_tokens: 5000 }));
    assert.equal((await contextFromRollout(file)).percent, 17.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('context rescans a replacement rollout with the same size and modification time', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-context-')),
    file = path.join(root, 'rollout.jsonl'),
    replacement = path.join(root, 'replacement.jsonl'),
    timestamp = new Date('2026-11-14T05:20:00Z');
  try {
    writeFileSync(file, '{"type":"compacted","payload":{}}\n');
    utimesSync(file, timestamp, timestamp);
    assert.equal((await contextFromRollout(file)).compactionCount, 1);

    writeFileSync(replacement, '{"type":"unrelated","payload":{}}\n');
    utimesSync(replacement, timestamp, timestamp);
    renameSync(replacement, file);
    assert.equal((await contextFromRollout(file)).compactionCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('context counts checkpoints across the full rollout without double-counting completion events', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-context-')),
    file = path.join(root, 'rollout.jsonl');
  const line = (record: unknown) => JSON.stringify(record) + '\n';
  const completion = (id: string) => ({
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'ContextCompaction', id } },
  });
  try {
    writeFileSync(file, line({ type: 'compacted', payload: { message: 'a'.repeat(8_000_000) } }));
    appendFileSync(file, line({ type: 'event_msg', payload: { type: 'context_compacted' } }));
    appendFileSync(file, line(completion('first')));
    appendFileSync(file, line({ type: 'response_item', payload: { text: 'b'.repeat(2_097_152) } }));
    assert.equal((await contextFromRollout(file)).compactionCount, 1);

    const checkpoint = line({ type: 'compacted', payload: {} });
    appendFileSync(file, checkpoint.slice(0, -5));
    assert.equal((await contextFromRollout(file)).compactionCount, 1);
    appendFileSync(file, checkpoint.slice(-5) + line(completion('second')));
    assert.equal((await contextFromRollout(file)).compactionCount, 2);

    writeFileSync(file, line(completion('replacement')));
    assert.equal((await contextFromRollout(file)).compactionCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
