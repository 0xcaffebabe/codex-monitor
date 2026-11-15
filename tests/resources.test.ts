import test from 'node:test';
import assert from 'node:assert/strict';
import type { CpuInfo } from 'node:os';
import { HostResourceSampler } from '../server/client/resources.js';
import { frameSchema } from '../server/transport/protocol.js';
import { HOST_RESOURCE_STALE_MS } from '../src/workspaces.js';

const cpu = (user: number, idle: number, sys = 0): CpuInfo => ({
  model: 'test',
  speed: 1000,
  times: { user, nice: 0, sys, idle, irq: 0 },
});

test('host CPU reports the interval average over all logical CPUs and memory reports bytes and percentage', () => {
  let cpus = [cpu(100, 800, 100), cpu(100, 800, 100)];
  const sampler = new HostResourceSampler({
    cpus: () => cpus,
    totalmem: () => 8 * 2 ** 30,
    freemem: () => 2 * 2 ** 30,
  });
  const first = sampler.sample(1000);
  assert.equal(first.cpuPercent, null);
  assert.deepEqual(first.memory, {
    totalBytes: 8 * 2 ** 30,
    usedBytes: 6 * 2 ** 30,
    usedPercent: 75,
  });
  // One core is 50% busy and the other is idle: host utilization is 25%.
  cpus = [cpu(500, 1300, 200), cpu(100, 1800, 100)];
  assert.equal(sampler.sample(6000).cpuPercent, 25);
  cpus = [cpu(500, 2300, 200), cpu(100, 2800, 100)];
  assert.equal(sampler.sample(11000).cpuPercent, 0);
  cpus = [cpu(1500, 2300, 200), cpu(1100, 2800, 100)];
  assert.equal(sampler.sample(16000).cpuPercent, 100);
});

test('CPU counter resets, missing counters, CPU count changes and long pauses require a new baseline', () => {
  let cpus = [cpu(100, 100)];
  const sampler = new HostResourceSampler({
    cpus: () => cpus,
    totalmem: () => 100,
    freemem: () => 40,
  });
  sampler.sample(1000);
  assert.equal(sampler.sample(2000).cpuPercent, null, 'unchanged counters are unknown');
  cpus = [cpu(10, 10)];
  assert.equal(sampler.sample(3000).cpuPercent, null, 'reset counters are unknown');
  cpus = [cpu(20, 20)];
  assert.equal(sampler.sample(4000).cpuPercent, 50);
  cpus = [];
  assert.equal(sampler.sample(5000).cpuPercent, null);
  cpus = [cpu(30, 30)];
  assert.equal(sampler.sample(6000).cpuPercent, null);
  cpus = [cpu(40, 40), cpu(40, 40)];
  assert.equal(sampler.sample(7000).cpuPercent, null);
  cpus = [cpu(50, 50), cpu(50, 50)];
  const afterPause = 7000 + HOST_RESOURCE_STALE_MS + 1;
  assert.equal(sampler.sample(afterPause).cpuPercent, null);
  cpus = [cpu(60, 60), cpu(60, 60)];
  assert.equal(sampler.sample(afterPause + 5000).cpuPercent, 50);
});

test('CPU and memory sampling failures are isolated, reported as unknown, and recover', () => {
  let cpuFailed = true;
  let memoryFailed = false;
  let cpus = [cpu(100, 100)];
  const sampler = new HostResourceSampler({
    cpus: () => {
      if (cpuFailed) throw new Error('not supported');
      return cpus;
    },
    totalmem: () => 100,
    freemem: () => {
      if (memoryFailed) throw new Error('not supported');
      return 25;
    },
  });
  assert.deepEqual(sampler.sample(1000), {
    sampledAt: 1000,
    cpuPercent: null,
    memory: { totalBytes: 100, usedBytes: 75, usedPercent: 75 },
  });
  cpuFailed = false;
  sampler.sample(2000);
  memoryFailed = true;
  cpus = [cpu(200, 200)];
  assert.deepEqual(sampler.sample(7000), { sampledAt: 7000, cpuPercent: 50, memory: null });
  memoryFailed = false;
  cpus = [cpu(Number.NaN, 300)];
  assert.equal(sampler.sample(12000).cpuPercent, null);
  cpus = [cpu(300, 300)];
  assert.equal(sampler.sample(17000).cpuPercent, null);
  cpus = [cpu(400, 400)];
  assert.equal(sampler.sample(22000).cpuPercent, 50);
});

test('unavailable or inconsistent system memory counters never become valid percentages', () => {
  for (const [total, free] of [
    [0, 0],
    [100, 101],
    [100, -1],
    [NaN, 0],
    [100, Infinity],
  ]) {
    const sampler = new HostResourceSampler({
      cpus: () => [],
      totalmem: () => total,
      freemem: () => free,
    });
    assert.equal(sampler.sample().memory, null);
  }
});

test('resource frames validate numeric bounds and consistency and cannot claim a different workspace', () => {
  const sample = {
    sampledAt: 1000,
    cpuPercent: 25,
    memory: { totalBytes: 100, usedBytes: 75, usedPercent: 75 },
  };
  const frame = { type: 'host-resources', sample };
  assert.ok(frameSchema.safeParse(frame).success);
  assert.ok(
    frameSchema.safeParse({ ...frame, sample: { ...sample, cpuPercent: null, memory: null } })
      .success,
  );
  for (const cpuPercent of [-1, 101, Infinity, NaN])
    assert.equal(
      frameSchema.safeParse({ ...frame, sample: { ...sample, cpuPercent } }).success,
      false,
    );
  for (const memory of [
    { totalBytes: 0, usedBytes: 0, usedPercent: 0 },
    { totalBytes: 100, usedBytes: 101, usedPercent: 100 },
    { totalBytes: 100, usedBytes: 50, usedPercent: 75 },
  ])
    assert.equal(frameSchema.safeParse({ ...frame, sample: { ...sample, memory } }).success, false);
  assert.equal(frameSchema.safeParse({ ...frame, workspaceId: 'other' }).success, false);
  assert.equal(
    frameSchema.safeParse({ ...frame, sample: { ...sample, workspaceId: 'other' } }).success,
    false,
  );
});
