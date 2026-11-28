import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedExecutor } from '../server/keyed-executor.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('operations execute in order for one key without blocking other keys or executor instances', async () => {
  const execute = createKeyedExecutor();
  const separate = createKeyedExecutor();
  const blocked = gate();
  const events: string[] = [];
  const first = execute('thread', async () => {
    events.push('first started');
    await blocked.promise;
    events.push('first finished');
    return 1;
  });
  const second = execute('thread', async () => {
    events.push('second');
    return 2;
  });
  assert.deepEqual(events, [], 'execution starts asynchronously');
  assert.equal(await execute('other thread', async () => 'other'), 'other');
  assert.equal(await separate('thread', async () => 'independent'), 'independent');
  assert.deepEqual(events, ['first started']);
  blocked.release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ['first started', 'first finished', 'second']);
});

test('failed operations reject their own result and allow the next operation to proceed', async () => {
  const execute = createKeyedExecutor();
  const syncError = new Error('synchronous failure');
  const asyncError = new Error('asynchronous failure');
  const sync = execute('thread', () => {
    throw syncError;
  });
  const asynchronous = execute('thread', async () => {
    throw asyncError;
  });
  const recovered = execute('thread', async () => 'recovered');
  await Promise.all([
    assert.rejects(sync, (error) => error === syncError),
    assert.rejects(asynchronous, (error) => error === asyncError),
    recovered.then((result) => assert.equal(result, 'recovered')),
  ]);
});

test('completion of an earlier operation cannot release a key still owned by its successor', async () => {
  const execute = createKeyedExecutor();
  const reached = gate(),
    blocked = gate();
  const events: string[] = [];
  const first = execute('thread', async () => 'first');
  const second = execute('thread', async () => {
    reached.release();
    await blocked.promise;
    events.push('second');
  });
  await first;
  await reached.promise;
  const third = execute('thread', async () => {
    events.push('third');
  });
  await execute('other thread', async () => {});
  assert.deepEqual(events, []);
  blocked.release();
  await Promise.all([second, third]);
  assert.deepEqual(events, ['second', 'third']);
});
