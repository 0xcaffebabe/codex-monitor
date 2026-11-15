import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { UsageParser } from '../server/usage-parser.js';
import { UsageStore } from '../server/usage.js';
import { CodexSource } from '../server/source.js';
import { PricingCatalog } from '../server/pricing.js';
import { createApp } from '../server/app.js';
import { fixture, ids } from './fixture.js';

const base = Date.UTC(2026, 10, 13, 15, 59, 0);
const raw = (input = 1000, cached = 600, output = 100, write = 100) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: write,
  output_tokens: output,
  reasoning_output_tokens: 40,
  total_tokens: input + output,
});
const record = (type: string, payload: unknown, ms: number, ordinal?: number) =>
  JSON.stringify({ type, payload, timestamp: new Date(base + ms).toISOString(), ordinal });
const usageLines = (sessionId = ids.modern, responseId = 'r1', model = 'gpt-6.1-sol', ms = 0) => [
  record('session_meta', { id: sessionId, timestamp: new Date(base).toISOString() }, ms, 0),
  record('event_msg', { type: 'task_started', turn_id: 'turn-1' }, ms, 1),
  record('turn_context', { model }, ms + 50, 2),
  record('response_item', { type: 'message', role: 'assistant', content: [] }, ms + 3000, 3),
  record(
    'event_msg',
    {
      type: 'item_completed',
      item: { type: 'AgentMessage' },
      started_at_ms: base + ms + 1050,
      completed_at_ms: base + ms + 3000,
    },
    ms + 3000,
    4,
  ),
  record(
    'token_usage_record',
    { thread_id: sessionId, response_id: responseId, usage: raw(), thread_token_usage: raw() },
    ms + 5050,
    5,
  ),
  record(
    'event_msg',
    { type: 'token_count', info: { total_token_usage: raw(), last_token_usage: raw() } },
    ms + 5051,
    6,
  ),
];
function parse(lines: string[], id = ids.modern) {
  const parser = new UsageParser(id);
  return { parser, rows: lines.flatMap((line) => parser.parse(line)) };
}
test('native usage records take priority over mirrored cumulative snapshots; cache and reasoning remain subsets', () => {
  const { rows } = parse([
    ...usageLines(),
    record(
      'event_msg',
      { type: 'token_count', info: { total_token_usage: raw(), last_token_usage: raw() } },
      8000,
    ),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 1000);
  assert.equal(rows[0].cached, 600);
  assert.equal(rows[0].cacheWrite, 100);
  assert.equal(rows[0].output, 100);
  assert.equal(rows[0].durationMs, 5000);
  assert.equal(rows[0].firstTokenMs, 1000);
});
test('old snapshots, model changes and repeated rate-limit lanes do not double count', () => {
  const snapshot = (total: any, last: any, ms: number) =>
    record(
      'event_msg',
      { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
      ms,
    );
  const { rows } = parse([
    record('turn_context', { model: 'gpt-6-sol' }, 0),
    snapshot(raw(), raw(), 1000),
    snapshot(raw(), raw(), 2000),
    record(
      'event_msg',
      { type: 'thread_settings_applied', settings: { model: 'gpt-6-astra' } },
      3000,
    ),
    snapshot(raw(1500, 800, 150), raw(500, 200, 50), 4000),
    snapshot(raw(), raw(), 5000),
    snapshot(raw(1800, 1000, 170), undefined, 6000),
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.model),
    ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-astra'],
  );
  // A repeated older lane must not lower the baseline used by cumulative-only logs.
  assert.equal(rows[2].input, 300);
});
test('tool execution and gaps between turns do not inflate request timing; missing starts are unknown', () => {
  const lines = usageLines().slice(0, 5);
  const { rows } = parse([
    ...lines,
    record('response_item', { type: 'function_call_output' }, 60000),
    record(
      'event_msg',
      { type: 'token_count', info: { last_token_usage: raw(), total_token_usage: raw() } },
      60001,
    ),
    record('event_msg', { type: 'task_started' }, 3600000),
    record('turn_context', { model: 'gpt-6-sol' }, 3600050),
    record(
      'event_msg',
      {
        type: 'token_count',
        info: { last_token_usage: raw(10, 0, 1), total_token_usage: raw(1010, 600, 101) },
      },
      3601050,
    ),
  ]);
  assert.equal(rows[0].durationMs, 2950);
  assert.equal(rows[1].durationMs, 1000);
  assert.equal(rows[1].firstTokenMs, null);
  assert.equal(
    parse([record('event_msg', { type: 'token_count', info: { last_token_usage: raw() } }, 0)])
      .rows[0].durationMs,
    null,
  );
});
test('forked copied history is excluded, remote compaction usage is retained, malformed records are skipped', () => {
  const lines = [
    record(
      'session_meta',
      {
        id: ids.child,
        forked_from_id: ids.modern,
        timestamp: new Date(base + 10000).toISOString(),
      },
      10000,
    ),
    record(
      'event_msg',
      { type: 'token_count', info: { last_token_usage: raw(), total_token_usage: raw() } },
      1000,
    ),
    record(
      'token_usage_record',
      { thread_id: ids.child, response_id: 'compaction', usage: raw(50, 0, 10, 0) },
      12000,
    ),
    record(
      'event_msg',
      {
        type: 'token_count',
        info: { last_token_usage: raw(0, 0, 0, 0), total_token_usage: raw() },
      },
      12001,
    ),
    '{"type":"event_msg",broken',
  ];
  const { rows, parser } = parse(lines, ids.child);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 50);
  assert.equal(parser.state.invalid, 1);
});
test('legacy child rollouts retain their own identity even when their header and history were copied from the parent', () => {
  const parser = new UsageParser(ids.child, undefined, undefined, base + 10000);
  const rows = [
    record('session_meta', { id: ids.modern, timestamp: new Date(base).toISOString() }, 0),
    record(
      'event_msg',
      { type: 'token_count', info: { last_token_usage: raw(), total_token_usage: raw() } },
      5000,
    ),
    record('turn_context', { model: 'gpt-6.1-sol' }, 11000),
    record(
      'event_msg',
      {
        type: 'token_count',
        info: { last_token_usage: raw(50, 0, 10, 0), total_token_usage: raw(1050, 600, 110) },
      },
      12000,
    ),
  ].flatMap((line) => parser.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, ids.child);
  assert.equal(rows[0].input, 50);
});
test('nested copied metadata cannot lower the precise fork cutoff to the index timestamp', () => {
  const parser = new UsageParser(ids.child, undefined, undefined, base + 9000);
  const rows = [
    record(
      'session_meta',
      {
        id: ids.child,
        forked_from_id: ids.modern,
        timestamp: new Date(base + 10500).toISOString(),
      },
      10500,
    ),
    record('session_meta', { id: ids.modern, timestamp: new Date(base).toISOString() }, 0),
    record(
      'event_msg',
      { type: 'token_count', info: { last_token_usage: raw(), total_token_usage: raw() } },
      10000,
    ),
    record(
      'event_msg',
      {
        type: 'token_count',
        info: { last_token_usage: raw(50, 0, 10, 0), total_token_usage: raw(1050, 600, 110) },
      },
      12000,
    ),
  ].flatMap((line) => parser.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 50);
});
test('manual pricing deducts cache subsets, reloads valid edits, and reports unknown models', async () => {
  const f = fixture(),
    file = path.join(f.root, 'prices.json');
  const rates = (input: number) =>
    JSON.stringify({
      currency: 'USD',
      models: { model: { input, cachedInput: 1, cacheWrite: 3, output: 10 } },
      aliases: { alias: 'model' },
    });
  try {
    writeFileSync(file, rates(2));
    const catalog = new PricingCatalog(file);
    catalog.reload();
    const usage = parse(usageLines()).rows[0];
    assert.equal(catalog.cost('alias', usage), 0.0025);
    assert.equal(catalog.cost('model-xhigh', usage), 0.0025);
    assert.equal(catalog.cost('missing', usage), null);
    assert.equal(catalog.cost('__proto__', usage), null);
    writeFileSync(file, rates(100));
    catalog.reload();
    assert.equal(catalog.cost('model', usage), 0.0319);
    writeFileSync(file, '{invalid');
    catalog.reload();
    assert.equal(catalog.cost('model', usage), 0.0319);
    assert.match(catalog.warning, /沿用/);
  } finally {
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('persistent scanning handles appends, partial UTF-8 lines, file replacement, duplicate archived copies and deletion', async () => {
  const f = fixture(),
    source = new CodexSource(f.home),
    pricing = path.resolve('config/model-pricing.json');
  let store = new UsageStore(source, f.data, pricing);
  const file = path.join(f.home, 'sessions', `rollout-${ids.modern}.jsonl`);
  try {
    unlinkSync(path.join(f.home, 'sessions', `rollout-${ids.child}.jsonl`));
    writeFileSync(file, usageLines().join('\n') + '\n');
    await store.sync(true);
    let data = await store.query({ session: ids.modern });
    assert.equal(data.total, 1);
    assert.equal(data.summary.totalTokens, 1100);
    assert.equal(data.summary.uncachedInputTokens, 300);
    assert.equal(data.summary.tps, 25);
    const next = Buffer.from(
      record(
        'token_usage_record',
        { thread_id: ids.modern, response_id: '中文响应', usage: raw(200, 0, 20, 0) },
        10000,
      ) + '\n',
    );
    const split = next.indexOf(Buffer.from('文')) + 1;
    appendFileSync(file, next.subarray(0, split));
    await store.sync(true);
    assert.equal((await store.query()).total, 1);
    await store.close();
    store = new UsageStore(source, f.data, pricing);
    appendFileSync(file, next.subarray(split));
    await store.sync(true);
    assert.equal((await store.query()).total, 2);
    mkdirSync(path.join(f.home, 'archived_sessions'));
    const copy = path.join(f.home, 'archived_sessions', path.basename(file));
    copyFileSync(file, copy);
    await store.sync(true);
    assert.equal((await store.query()).total, 2);
    unlinkSync(copy);
    await store.sync(true);
    assert.equal((await store.query()).total, 2);
    writeFileSync(file, usageLines(ids.modern, 'replacement').join('\n') + '\n');
    await store.sync(true);
    assert.equal((await store.query()).total, 1);
    unlinkSync(file);
    await store.sync(true);
    assert.equal((await store.query()).total, 0);
  } finally {
    await store.close();
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('usage filters, timezone buckets, unknown cost and pagination use the same request set', async () => {
  const f = fixture(),
    source = new CodexSource(f.home),
    store = new UsageStore(source, f.data, path.resolve('config/model-pricing.json'));
  try {
    unlinkSync(path.join(f.home, 'sessions', `rollout-${ids.child}.jsonl`));
    writeFileSync(
      path.join(f.home, 'sessions', `rollout-${ids.modern}.jsonl`),
      [...usageLines(), ...usageLines(ids.modern, 'r2', 'custom-unknown', 120000)].join('\n') +
        '\n',
    );
    await store.sync(true);
    const all = await store.query({ timezoneOffset: -480, limit: 1 });
    assert.equal(all.total, 2);
    assert.equal(all.requests.length, 1);
    assert.equal(all.summary.unpricedRequests, 1);
    assert.equal(all.requests[0].costUsd, null);
    assert.deepEqual(
      all.days.map((d) => d.date),
      ['2026-11-13', '2026-11-14'],
    );
    assert.equal((await store.query({ model: 'gpt-6.1-sol' })).summary.requests, 1);
    assert.equal((await store.query({ to: base + 60000 })).summary.requests, 1);
    assert.equal((await store.query({ offset: 1 })).requests[0].model, 'gpt-6.1-sol');
  } finally {
    await store.close();
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('cached usage stays current after prices, session metadata and token records change', async () => {
  const f = fixture(),
    source = new CodexSource(f.home),
    pricing = path.join(f.root, 'pricing.json');
  const rates = (input: number) =>
    JSON.stringify({
      currency: 'USD',
      models: { 'gpt-6.1-sol': { input, cachedInput: 1, cacheWrite: 1, output: 2 } },
    });
  writeFileSync(pricing, rates(2));
  const store = new UsageStore(source, f.data, pricing);
  const file = path.join(f.home, 'sessions', `rollout-${ids.modern}.jsonl`);
  try {
    unlinkSync(path.join(f.home, 'sessions', `rollout-${ids.child}.jsonl`));
    writeFileSync(file, usageLines().join('\n') + '\n');
    await store.sync(true);
    const first = await store.query();
    assert.deepEqual(await store.query(), first);
    writeFileSync(pricing, rates(100));
    assert.ok((await store.query()).summary.costUsd > first.summary.costUsd);
    writeFileSync(pricing, '{invalid');
    assert.ok((await store.query()).warnings.some((warning) => warning.includes('沿用')));
    f.state
      .prepare('UPDATE threads SET title=?,cwd=? WHERE id=?')
      .run('renamed session', 'D:/moved', ids.modern);
    await source.refresh(true);
    const moved = await store.query({ project: 'D:/moved' });
    assert.equal(moved.total, 1);
    assert.equal(moved.requests[0].sessionTitle, 'renamed session');
    assert.equal((await store.query({ project: 'D:/project/codex-monitor' })).total, 0);
    appendFileSync(
      file,
      record(
        'token_usage_record',
        { thread_id: ids.modern, response_id: 'cache-new', usage: raw(200, 0, 20, 0) },
        10000,
      ) + '\n',
    );
    await store.sync(true);
    assert.equal((await store.query()).total, 2);
  } finally {
    await store.close();
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('tool-only log appends retain cached aggregation while token replacement and deletion invalidate it', async () => {
  const f = fixture(),
    source = new CodexSource(f.home),
    store = new UsageStore(source, f.data, path.resolve('config/model-pricing.json'));
  const file = path.join(f.home, 'sessions', `rollout-${ids.modern}.jsonl`);
  let calculations = 0;
  const price = store.pricing.cost.bind(store.pricing);
  store.pricing.cost = (...args) => {
    calculations++;
    return price(...args);
  };
  try {
    unlinkSync(path.join(f.home, 'sessions', `rollout-${ids.child}.jsonl`));
    writeFileSync(file, usageLines().join('\n') + '\n');
    await store.sync(true);
    const first = await store.query(),
      priced = calculations;
    appendFileSync(
      file,
      record(
        'event_msg',
        { type: 'agent_reasoning', text: 'new progress, no token record' },
        10000,
      ) + '\n',
    );
    await store.sync(true);
    assert.deepEqual((await store.query()).summary, first.summary);
    assert.equal(calculations, priced, 'unchanged token data must not repeat aggregation');
    appendFileSync(
      file,
      record(
        'token_usage_record',
        { thread_id: ids.modern, response_id: 'new-count', usage: raw(200, 0, 20, 0) },
        12000,
      ) + '\n',
    );
    await store.sync(true);
    assert.equal((await store.query()).total, 2);
    assert.ok(calculations > priced);
    writeFileSync(file, record('session_meta', { id: ids.modern }, 0) + '\n');
    await store.sync(true);
    assert.equal((await store.query()).total, 0);
  } finally {
    await store.close();
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('bounded usage pages preserve tied timestamps, filters and totals across page boundaries', async () => {
  const f = fixture(),
    source = new CodexSource(f.home),
    store = new UsageStore(source, f.data, path.resolve('config/model-pricing.json'));
  const db = new DatabaseSync(path.join(f.data, 'usage.sqlite'));
  try {
    const insert = db.prepare('INSERT INTO usage_requests VALUES(?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (let index = 0; index < 4501; index++) {
      const id = `request-${String(index).padStart(5, '0')}`,
        timestamp = base + Math.floor(index / 3) * 1000;
      insert.run(
        id,
        'fixture',
        ids.modern,
        'gpt-6.1-sol',
        timestamp,
        JSON.stringify({
          id,
          sessionId: ids.modern,
          model: 'gpt-6.1-sol',
          timestamp,
          input: 1,
          cached: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          durationMs: null,
          firstTokenMs: null,
        }),
      );
    }
    db.exec('COMMIT');
    const all = await store.query({ offset: 1999, limit: 3 });
    assert.equal(all.total, 4501);
    assert.equal(all.summary.inputTokens, 4501);
    const expected = db
      .prepare('SELECT id FROM usage_requests ORDER BY timestamp DESC,id LIMIT 3 OFFSET 1999')
      .all()
      .map((row) => String(row.id));
    assert.deepEqual(
      all.requests.map((row) => row.id),
      expected,
    );
    assert.equal((await store.query({ from: base + 1499 * 1000 })).total, 4);
    assert.equal((await store.query({ model: 'missing' })).total, 0);
  } finally {
    db.close();
    await store.close();
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('usage API requires authentication and rejects invalid ranges and pagination', async () => {
  const f = fixture(),
    app = createApp(f.config),
    server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(baseUrl + '/api/usage')).status, 401);
    const user = await app.auth.setup('owner', 'a-long-password'),
      session = app.auth.issue(user, 'usage test');
    const headers = { Authorization: 'Bearer ' + session.token };
    for (const q of [
      'limit=101',
      'offset=-1',
      'from=100&to=99',
      'session=invalid',
      'timezoneOffset=9999',
      'extra=1',
    ])
      assert.equal((await fetch(baseUrl + '/api/usage?' + q, { headers })).status, 400, q);
    assert.equal((await fetch(baseUrl + '/api/usage', { headers })).status, 200);
    await app.usage.sync(true);
  } finally {
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('compressed history is parsed without extracting files, and mirrored JSONL copies are deduplicated', async () => {
  const f = fixture(),
    source = new CodexSource(f.home),
    store = new UsageStore(source, f.data, path.resolve('config/model-pricing.json'));
  const file = path.join(f.home, 'sessions', `rollout-${ids.modern}.jsonl`);
  try {
    const content = Buffer.from(usageLines().join('\n') + '\n');
    writeFileSync(file, content);
    writeFileSync(file + '.zst', zstdCompressSync(content));
    await store.sync(true);
    assert.equal((await store.query({ session: ids.modern })).total, 1);
    unlinkSync(file);
    await store.sync(true);
    assert.equal((await store.query({ session: ids.modern })).summary.totalTokens, 1100);
    assert.equal(readFileSync(file + '.zst').compare(zstdCompressSync(content)), 0);
  } finally {
    await store.close();
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
