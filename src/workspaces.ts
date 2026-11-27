export const HOST_RESOURCE_INTERVAL_MS = 5000;
export const HOST_RESOURCE_STALE_MS = 15000;

export const CLIENT_UPDATE_TIMEOUT_MS = 26 * 60_000;
export const clientUpdatePhases = [
  'pulling',
  'installing',
  'building',
  'restarting',
  'succeeded',
  'failed',
] as const;
export type ClientUpdatePhase = (typeof clientUpdatePhases)[number];
export type UpdateStatus = { phase: ClientUpdatePhase | 'requested'; message?: string };
export type ClientUpdateStatus = UpdateStatus;

export function clientUpdateInProgress(status?: ClientUpdateStatus) {
  return !!status && status.phase !== 'succeeded' && status.phase !== 'failed';
}

export type HostResourceSample = {
  sampledAt: number;
  cpuPercent: number | null;
  memory: { totalBytes: number; usedBytes: number; usedPercent: number } | null;
  uptimeSeconds?: number;
};

export type WorkspaceResources = HostResourceSample & {
  /** Age at the time of the HTTP response, measured by Server's clock. */
  ageMs: number;
};

export type ManagedWorkspace = {
  id: string;
  name: string;
  online: boolean;
  createdAt: number;
  lastSeen: number | null;
  hostname: string;
  platform: string;
  buildCommitAt?: number | null;
  privacyWorkEnabled?: boolean;
  privacyWorkSupported?: boolean;
  clientUpdateSupported?: boolean;
  clientUpdate?: ClientUpdateStatus;
  resources?: WorkspaceResources | null;
};
