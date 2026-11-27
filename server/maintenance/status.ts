import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UpdateStatus } from '../../src/workspaces.js';

export const UPDATE_LOCK = '.monitor-update-lock';
export const UPDATE_LOG = 'server-update.log';

export type ServerUpdateJob = {
  dataDir: string;
  pmId: number;
  healthUrl: string;
  buildId: string;
  dependencies: string;
};

export function readUpdateStatus(dataDir: string): UpdateStatus | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, 'server-update.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function writeUpdateStatus(dataDir: string, status: UpdateStatus) {
  const file = path.join(dataDir, 'server-update.json');
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 });
  renameSync(temporary, file);
}
