import os from 'node:os';
import { HOST_RESOURCE_STALE_MS, type HostResourceSample } from '../../src/workspaces.js';
import { readMacOSUsedMemory } from './macos-memory.js';

type ResourceSource = Pick<typeof os, 'cpus' | 'totalmem' | 'freemem'> & {
  usedmem?: (totalBytes: number) => Promise<number | null>;
};
type CpuSnapshot = { idle: number; total: number; count: number; at: number };
const systemSource: ResourceSource = {
  cpus: os.cpus,
  totalmem: os.totalmem,
  freemem: os.freemem,
  ...(process.platform === 'darwin' ? { usedmem: readMacOSUsedMemory } : {}),
};

/** Host counters only; sampling failures must not interrupt the workspace connection. */
export class HostResourceSampler {
  private previous?: CpuSnapshot;

  constructor(private source: ResourceSource = systemSource) {}

  async sample(now = Date.now(), readUptime = false): Promise<HostResourceSample> {
    let cpuPercent: number | null = null;
    let memory: HostResourceSample['memory'] = null;
    let uptimeSeconds: number | undefined;
    if (readUptime) {
      try {
        const seconds = Math.floor(os.uptime());
        if (Number.isSafeInteger(seconds) && seconds >= 0) uptimeSeconds = seconds;
      } catch {}
    }
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
      const usedBytes = this.source.usedmem
        ? await this.source.usedmem(totalBytes)
        : totalBytes - this.source.freemem();
      if (
        Number.isSafeInteger(totalBytes) &&
        totalBytes > 0 &&
        usedBytes !== null &&
        Number.isSafeInteger(usedBytes) &&
        usedBytes >= 0 &&
        usedBytes <= totalBytes
      ) {
        memory = { totalBytes, usedBytes, usedPercent: (usedBytes / totalBytes) * 100 };
      }
    } catch {}
    return {
      sampledAt: now,
      cpuPercent,
      memory,
      ...(uptimeSeconds !== undefined && { uptimeSeconds }),
    };
  }
}
