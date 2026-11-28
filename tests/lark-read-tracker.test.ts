import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CompletionNotifications } from '../server/notifications/completions.js';
import { notificationKey, type CompletionEvent } from '../server/notifications/events.js';
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

test('only a matching private reader dismisses the exact notice and repeated events are harmless', async () => {
  const f = fixture();
  try {
    const first = f.publish(), other = f.publish();
    const tracker = new LarkReadTracker(f.completions);
    await tracker.track('first', first.eventKey, 'ou_one', async () => ({ messageId: 'om_one' }));
    await tracker.track('first', first.eventKey, 'ou_two', async () => ({ messageId: 'om_two' }));
    tracker.read('ou_one', ['om_two']);
    assert.equal(f.completions.snapshot().notifications.length, 2);
    tracker.read('ou_two', ['om_two']);
    const snapshot = f.completions.snapshot();
    assert.deepEqual(snapshot.notifications, [other.notice]);
    tracker.read('ou_two', ['om_two']);
    assert.deepEqual(f.completions.snapshot(), snapshot);
  } finally {
    f.db.close();
  }
});

test('reads arriving before the send response are matched unless the destination changed', async () => {
  const f = fixture();
  try {
    const tracker = new LarkReadTracker(f.completions);
    for (const reset of [false, true]) {
      const completion = f.publish();
      const send = gate<{ messageId: string }>();
      const tracked = tracker.track('delivery', completion.eventKey, 'ou_one', () => send.promise);
      const messageId = reset ? 'om_two' : 'om_one';
      tracker.read('ou_one', [messageId]);
      if (reset) tracker.reset();
      send.resolve({ messageId });
      await tracked;
      assert.deepEqual(f.completions.snapshot().notifications, reset ? [completion.notice] : []);
    }
  } finally {
    f.db.close();
  }
});

test('expired receipts leave the browser notice pending', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture();
  try {
    const first = f.publish();
    const tracker = new LarkReadTracker(f.completions);
    await tracker.track('first', first.eventKey, 'ou_one', async () => ({ messageId: 'om_one' }));
    t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
    tracker.read('ou_one', ['om_one']);
    assert.deepEqual(f.completions.snapshot().notifications, [first.notice]);
    assert.equal(tracker.status('first'), 'Lark 已读事件等待超时');
  } finally {
    f.db.close();
  }
});
