export type ManagedWorkspace = {
  id: string;
  name: string;
  online: boolean;
  createdAt: number;
  lastSeen: number | null;
  hostname: string;
  platform: string;
};
