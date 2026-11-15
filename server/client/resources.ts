import os from 'node:os';
import { HOST_RESOURCE_STALE_MS, type HostResourceSample } from '../../src/workspaces.js';

type ResourceSource = Pick<typeof os, 'cpus' | 'totalmem' | 'freemem'>;
type CpuSnapshot = { idle: number; total: number; count: number; at: number };

/** Host counters only; sampling failures must not interrupt the workspace connection. */
export class HostResourceSampler {
  private previous?: CpuSnapshot;

  constructor(private source: ResourceSource = os) {}

  sample(now = Date.now()): HostResourceSample {
    let cpuPercent: number | null = null;
    let memory: HostResourceSample['memory'] = null;
    try {
      const cpus = this.source.cpus();
      const current: CpuSnapshot = { idle: 0, total: 0, count: cpus.length, at: now };
      for (const cpu of cpus) {
        for (const value of Object.values(cpu.times))
          if (!Number.isFinite(value) || value < 0) throw new Error('Invalid CPU counter');
        current.idle += cpu.times.idle;
        current.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      }
      const previous = this.previous;
      this.previous = current.count ? current : undefined;
      if (
        previous &&
        current.count === previous.count &&
        now > previous.at &&
        now - previous.at <= HOST_RESOURCE_STALE_MS
      ) {
        const total = current.total - previous.total;
        const idle = current.idle - previous.idle;
        if (total > 0 && idle >= 0 && idle <= total)
          cpuPercent = Math.max(0, Math.min(100, (1 - idle / total) * 100));
      }
    } catch {
      this.previous = undefined;
    }
    try {
      const totalBytes = this.source.totalmem();
      const freeBytes = this.source.freemem();
      if (
        Number.isSafeInteger(totalBytes) &&
        totalBytes > 0 &&
        Number.isSafeInteger(freeBytes) &&
        freeBytes >= 0 &&
        freeBytes <= totalBytes
      ) {
        const usedBytes = totalBytes - freeBytes;
        memory = { totalBytes, usedBytes, usedPercent: (usedBytes / totalBytes) * 100 };
      }
    } catch {}
    return { sampledAt: now, cpuPercent, memory };
  }
}
