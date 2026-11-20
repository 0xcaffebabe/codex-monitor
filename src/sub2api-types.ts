export type Sub2ApiSettings = {
  baseUrl: string;
  configured: boolean;
};

export type Sub2ApiPage<T> = {
  items: T[];
  total: number;
  pageSize: number;
  warning?: string;
};

export type Sub2ApiQuota = {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  requests: number | null;
  tokens: number | null;
};

export type Sub2ApiAccount = {
  id: number;
  name: string;
  platform: string;
  status: string;
  updatedAt: string | null;
  quotas: Sub2ApiQuota[];
  quotaUnavailable: boolean;
};

export type Sub2ApiCredits = {
  balance: string | null;
  hasCredits: boolean;
  unlimited: boolean;
};

export type Sub2ApiKeyUsage = {
  id: number;
  name: string;
  requests: number;
  tokens: number;
  actualCost: number | null;
};
