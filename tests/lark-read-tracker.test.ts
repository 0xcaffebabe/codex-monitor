import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as flush } from 'node:timers/promises';
import test from 'node:test';
import { CompletionNotifications } from '../server/notifications/completions.js';
import { notificationKey, type CompletionEvent } from '../server/notifications/events.js';
import { LarkDeliveryError } from '../server/notifications/lark.js';
import { LarkReadTracker } from '../server/notifications/lark-read-tracker.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const completions = new CompletionNotifications(db);
  return {
    db,
    completions,
    publish() {
      const event: CompletionEvent = {
        kind: 'session.completed',
        sessionId: randomUUID(),
        turnId: randomUUID(),
        title: 'Task',
        project: 'test',
        occurredAt: Date.now(),
        summary: 'Done',
      };
      const notice = completions.record({ id: 'workspace', name: 'Workspace' }, event)!;
      completions.publish([notice]);
      return { notice, eventKey: `workspace:${notificationKey(event)}` };
    },
  };
}

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('any recipient reading a completion card dismisses only that notice and invalid cards stop polling', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  const first = f.publish(),
    second = f.publish();
  const queried: string[] = [];
  let memberRead = false;
  const tracker = new LarkReadTracker(f.completions, async () => ({
    async isRead(id) {
      queried.push(id);
      if (id === 'deleted') throw new LarkDeliveryError('消息已删除', false, 230033);
      return id === 'member' && memberRead;
    },
  }));
  try {
    for (const id of ['deleted', 'owner', 'member']) tracker.track('first', first.eventKey, id);
    tracker.track('second', second.eventKey, 'other');
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(new Set(queried.splice(0)), new Set(['deleted', 'owner', 'member', 'other']));
    assert.equal(f.completions.snapshot().notifications.length, 2);
    memberRead = true;
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(new Set(queried.splice(0)), new Set(['owner', 'member', 'other']));
    assert.deepEqual(f.completions.snapshot().notifications, [second.notice]);
    assert.equal(tracker.status('first'), 'Lark 已读，网页通知已关闭');
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(queried, ['other']);
  } finally {
    await tracker.close();
    f.db.close();
  }
});

test('read tracking expires exactly seven days after the first card without dismissing its notice', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const started = Date.now();
  let now = started;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(),
    completion = f.publish();
  const queried: string[] = [];
  const tracker = new LarkReadTracker(f.completions, async () => ({
    async isRead(id) {
      queried.push(id);
      return false;
    },
  }));
  try {
    tracker.track('delivery', completion.eventKey, 'first-card');
    now = started + 7 * 24 * 60 * 60 * 1000 - 1;
    tracker.track('delivery', completion.eventKey, 'later-recipient');
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(queried.splice(0), ['first-card', 'later-recipient']);
    now++;
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(queried, []);
    assert.equal(tracker.status('delivery'), 'Lark 已读查询已停止，卡片已超过 7 天');
    assert.deepEqual(f.completions.snapshot().notifications, [completion.notice]);
    t.mock.timers.tick(30_000);
    await flush();
    assert.deepEqual(queried, []);
  } finally {
    await tracker.close();
    f.db.close();
  }
});

test('destination reset and close abort in-flight reads and ignore late successful responses', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(),
    completion = f.publish();
  const old = gate<boolean>(),
    next = gate<boolean>();
  const signals: AbortSignal[] = [],
    queried: string[] = [];
  const tracker = new LarkReadTracker(f.completions, async (signal) => {
    signals.push(signal);
    return {
      async isRead(id) {
        queried.push(id);
        return id === 'old' ? old.promise : next.promise;
      },
    };
  });
  try {
    tracker.track('old-delivery', completion.eventKey, 'old');
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(queried, ['old']);
    tracker.reset('destination changed');
    assert.equal(signals[0].aborted, true);
    tracker.track('new-delivery', completion.eventKey, 'new');
    old.resolve(true);
    await flush();
    assert.deepEqual(f.completions.snapshot().notifications, [completion.notice]);
    assert.equal(tracker.status('old-delivery'), 'destination changed');
    assert.equal(tracker.status('new-delivery'), 'Lark 已读查询等待首次检查');
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(queried, ['old', 'new']);
    let closed = false;
    const closing = tracker.close().then(() => {
      closed = true;
    });
    await flush();
    assert.equal(signals[1].aborted, true);
    assert.equal(closed, false);
    next.resolve(true);
    await closing;
    assert.deepEqual(f.completions.snapshot().notifications, [completion.notice]);
    tracker.track('after-close', completion.eventKey, 'must-not-read');
    t.mock.timers.tick(30_000);
    await flush();
    assert.deepEqual(queried, ['old', 'new']);
  } finally {
    old.resolve(false);
    next.resolve(false);
    await tracker.close();
    f.db.close();
  }
});
