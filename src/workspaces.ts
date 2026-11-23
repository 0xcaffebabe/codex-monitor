export const HOST_RESOURCE_INTERVAL_MS = 5000;
export const HOST_RESOURCE_STALE_MS = 15000;

export type HostResourceSample = {
  sampledAt: number;
  cpuPercent: number | null;
  memory: { totalBytes: number; usedBytes: number; usedPercent: number } | null;
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
  resources?: WorkspaceResources | null;
};
