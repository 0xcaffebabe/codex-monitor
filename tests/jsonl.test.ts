import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonLines } from '../server/jsonl.js';
import { CodexSource } from '../server/source.js';
import { fixture, ids } from './fixture.js';

test('bounded JSONL reads preserve UTF-8, line ordinals and valid records after oversized lines', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-lines-')),
    file = path.join(root, 'input.jsonl');
  const splitUtf8 = 'x'.repeat(65535) + '中🙂文';
  try {
    writeFileSync(file, splitUtf8 + '\r\n' + 'y'.repeat(200000) + '\n\n{"ok":true}\nlast');
    const lines: string[] = [];
    for await (const line of jsonLines(file, 100000)) lines.push(line);
    assert.deepEqual(lines, [splitUtf8 + '\r', '', '', '{"ok":true}', 'last']);
    writeFileSync(file, 'z'.repeat(200000));
    const oversized: string[] = [];
    for await (const line of jsonLines(file, 100000)) oversized.push(line);
    assert.deepEqual(oversized, ['']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent legacy detail and export reads recover after an oversized or partially written record', async () => {
  const f = fixture(),
    source = new CodexSource(f.home);
  const file = path.join(f.home, 'sessions', `rollout-${ids.legacy}.jsonl`);
  try {
    appendFileSync(file, 'x'.repeat(8_000_001) + '\n');
    appendFileSync(
      file,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'after large record' },
      }) + '\n{"type":',
    );
    const pages = await Promise.all(Array.from({ length: 8 }, () => source.detail(ids.legacy)));
    for (const page of pages)
      assert.equal(page!.events.filter((event) => event.text === 'after large record').length, 1);
    assert.ok((await source.export(ids.legacy))!.includes('after large record'));
    appendFileSync(
      file,
      '"response_item","payload":{"type":"message","role":"assistant","content":"completed partial"}}\n',
    );
    assert.ok(
      (await source.detail(ids.legacy))!.events.some((event) => event.text === 'completed partial'),
    );
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
