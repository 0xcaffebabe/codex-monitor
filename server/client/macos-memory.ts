import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function macOSUsedMemory(totalBytes: number, output: string): number | null {
  const pageSize = Number(output.match(/\bpage size of (\d+) bytes\b/)?.[1]);
  const counters = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(\d+)\.?\s*$/);
    if (match) counters.set(match[1].trim(), Number(match[2]));
  }
  const free = counters.get('Pages free');
  const fileBacked = counters.get('File-backed pages');
  const purgeable = counters.get('Pages purgeable');
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    ![free, fileBacked, purgeable].every(
      (value) => value !== undefined && Number.isSafeInteger(value) && value >= 0,
    )
  )
    return null;

  // Cached files (file-backed + purgeable pages) are available for reuse.
  // vm_stat's "Pages free" excludes speculative pages; file-backed pages already
  // include them. Do not subtract speculative or all inactive pages again.
  // Subtracting from physical RAM also counts compressed data at its physical size.
  const availableBytes = (free! + fileBacked! + purgeable!) * pageSize;
  if (!Number.isSafeInteger(availableBytes) || availableBytes > totalBytes) return null;
  return totalBytes - availableBytes;
}

export async function readMacOSUsedMemory(totalBytes: number): Promise<number | null> {
  const { stdout } = await execute('/usr/bin/vm_stat', [], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return macOSUsedMemory(totalBytes, stdout);
}
