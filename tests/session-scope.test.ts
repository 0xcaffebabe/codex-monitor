import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SessionScope } from '../server/session-scope.js';
import { CodexSource } from '../server/source.js';
import { fixture, ids } from './fixture.js';
import { UsageStore } from '../server/usage.js';
import { DatabaseSync } from 'node:sqlite';

test('created session scope excludes existing history, usage, images and notifications, and survives restart', async () => {
  const f = fixture();
  const scope = new SessionScope(f.config.dataDir, 'created');
  const source = new CodexSource(f.home, scope);
  try {
    assert.equal((await source.overview()).total, 0);
    assert.deepEqual((await source.list({})).sessions, []);
    assert.deepEqual(await source.usageSessions(), []);
    assert.equal(await source.get(ids.modern), undefined);
    assert.equal(await source.detail(ids.modern), null);
    assert.equal(await source.outline(ids.modern), null);
    assert.equal(source.activity(ids.modern), undefined);
    assert.deepEqual(await source.completions(0), []);
    assert.deepEqual(await source.inputRequests(0), []);
    source.include(ids.modern);
    await source.refresh(true);
    assert.equal((await source.overview()).total, 1);
    assert.equal((await source.list({})).sessions[0].id, ids.modern);
    assert.equal((await source.detail(ids.modern))!.session.id, ids.modern);
    assert.equal(await source.detail(ids.legacy), null);
    const reopened = new SessionScope(f.config.dataDir, 'created');
    assert.equal(reopened.allows(ids.modern), true);
    assert.equal(reopened.allows(ids.legacy), false);
    writeFileSync(path.join(f.config.dataDir, 'session-scope.json'), 'invalid');
    assert.throws(() => new SessionScope(f.config.dataDir, 'created'), /refusing to expose/);
  } finally {
    source.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('usage scope filters native records and pre-existing caches before the first scan', async () => {
  const f = fixture();
  const now = Date.now();
  for (const [id, model] of [
    [ids.modern, 'allowed-model'],
    [ids.legacy, 'private-model'],
  ]) {
    const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
    const entries = [
      { type: 'session_meta', payload: { id } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'scope-turn' } },
      { type: 'turn_context', payload: { model } },
      {
        type: 'token_usage_record',
        payload: { thread_id: id, response_id: 'usage-' + id, usage, thread_token_usage: usage },
      },
    ];
    writeFileSync(
      path.join(f.home, 'sessions', `rollout-${id}.jsonl`),
      entries
        .map((e, i) => JSON.stringify({ ...e, timestamp: new Date(now + i * 1000).toISOString() }))
        .join('\n') + '\n',
    );
  }
  const all = new CodexSource(f.home);
  let store = new UsageStore(all, f.config.dataDir, path.resolve('config/model-pricing.json'));
  let scoped: CodexSource | undefined;
  try {
    await store.sync(true);
    const original = await store.query();
    assert.ok(original.summary.requests >= 2);
    assert.ok(original.requests.some((r) => r.sessionId === ids.legacy));
    await store.close();
    all.close();
    const scope = new SessionScope(f.config.dataDir, 'created');
    scope.include(ids.modern);
    scoped = new CodexSource(f.home, scope);
    store = new UsageStore(scoped, f.config.dataDir, path.resolve('config/model-pricing.json'));
    const cached = await store.query();
    assert.equal(cached.summary.requests, 1);
    assert.deepEqual(cached.availableModels, ['allowed-model']);
    assert.equal(cached.requests[0].sessionId, ids.modern);
    assert.equal(JSON.stringify(cached).includes(ids.legacy), false);
    assert.equal((await store.query({ session: ids.legacy })).summary.requests, 0);
    await store.sync(true);
    assert.equal((await store.query()).scan.files, 1);
    const db = new DatabaseSync(path.join(f.config.dataDir, 'usage.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(
        db
          .prepare('SELECT DISTINCT session_id FROM usage_requests')
          .all()
          .map((r) => String(r.session_id)),
        [ids.modern],
      );
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    scoped?.close();
    if (!scoped) all.close();
    f.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
