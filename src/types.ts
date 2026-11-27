import type { SessionFileLink } from './file-preview-types.js';

export type SessionStatus =
  'running' | 'waiting' | 'completed' | 'interrupted' | 'failed' | 'idle' | 'stale';
export const reasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export type CodexModel = {
  model: string;
  displayName: string;
  supportedReasoningEfforts: ReasoningEffort[];
};
export type SessionModelSettings = {
  model?: string;
  thinking?: ReasoningEffort;
};
export type SessionMessageSettings = SessionModelSettings & {
  channel?: 'desktop';
  permissionMode?: import('./approval-types').SessionPermissionMode;
};
export type SessionCreationSettings = SessionMessageSettings;
export interface Session {
  id: string;
  title: string;
  cwd: string;
  project: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  model: string;
  tokens: number;
  preview: string;
  status: SessionStatus;
  statusSource: string;
  parentId?: string;
  latestTurn?: string;
}
export interface SessionImageRef {
  id: string;
  name: string;
  index?: number;
  offset?: number;
  source?: 'computer-use';
}
export interface TimelineEvent {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'reasoning' | 'system' | 'plan';
  timestamp: number;
  text: string;
  name?: string;
  title?: string;
  callId?: string;
  output?: string;
  status?: string;
  phase?: string;
  durationMs?: number;
  turnId?: string;
  transient?: boolean;
  image?: SessionImageRef;
  images?: SessionImageRef[];
  files?: SessionFileLink[];
  computerUse?: boolean;
}
export interface ComputerUseStep {
  id: string;
  timestamp: number;
  title: string;
  status: string;
  durationMs?: number;
  url?: string;
  pageTitle?: string;
  text?: string;
  screenshots: number;
}
export interface ComputerUsePage {
  sessionId: string;
  steps: ComputerUseStep[];
  total: number;
  before: number | null;
  version: string;
  warnings: string[];
}
export interface SessionPage {
  session: Session;
  events: TimelineEvent[];
  total: number;
  before: number | null;
  version: string;
  warnings: string[];
  context?: SessionContext;
  hasComputerUse?: boolean;
  turnTiming?: SessionTurnTiming;
}
export interface SessionTurnTiming {
  startedAt: number;
  finishedAt: number | null;
}
export interface SessionReconnect {
  turnId: string;
  message: string;
  details?: string;
}
export interface PendingSession {
  state: 'syncing';
}
export interface SessionContext {
  compactionCount?: number;
  usedTokens: number | null;
  limitTokens: number | null;
  percent: number | null;
  updatedAt: number | null;
}
export interface OutlineEntry {
  id: string;
  turnId?: string;
  ordinal: number;
  timestamp: number;
  prompt: string;
  reply: string;
  tools: number;
  status: SessionStatus;
}
export interface SessionOutline {
  sessionId: string;
  entries: OutlineEntry[];
  version: string;
}
export interface Overview {
  total: number;
  running: number;
  today: number;
  projects: { name: string; path: string; count: number }[];
  source: {
    available: boolean;
    home: string;
    database: boolean;
    history: boolean;
    warnings: string[];
  };
  updatedAt: number;
}
export interface User {
  id: string;
  username: string;
  role: 'admin' | 'viewer';
}
export type LarkStartTarget = { alias: string; workspaceId: string; projectId: string; projectName?: string };
export type LarkStartSettings = { defaultAlias: string; targets: LarkStartTarget[] };

export interface NotificationSettings {
  completionMode: 'watched' | 'all';
  enabled: boolean;
  provider: 'lark';
  mode: 'webhook' | 'app';
  appRegion: 'lark' | 'feishu';
  appId: string;
  appSecretConfigured: boolean;
  chatId: string;
  replyOpenIds: string[];
  larkStart: LarkStartSettings;
  replyConnection?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  webhookConfigured: boolean;
  webhookHint: string;
  signingSecretConfigured: boolean;
  publicUrl: string;
  monitorError: string;
}
export interface NotificationDelivery {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  kind: 'test' | 'session.completed' | 'session.input_required';
  sessionId: string | null;
  title: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  attempts: number;
  error: string;
  larkReadStatus?: string;
  createdAt: number;
  sentAt: number | null;
}
export interface CompletionNotification {
  id: number;
  workspaceId: string;
  workspaceName: string;
  sessionId: string;
  title: string;
  completedAt: number;
}
export interface CompletionNotificationSnapshot {
  generation: string;
  revision: number;
  notifications: CompletionNotification[];
}
export interface UsageSummary {
  requests: number;
  sessions: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  unpricedRequests: number;
  cacheHitRate: number | null;
  firstTokenMs: number | null;
  firstTokenSamples: number;
  tps: number | null;
  tpsSamples: number;
}
export interface UsageRequest {
  id: string;
  sessionId: string;
  sessionTitle: string;
  project: string;
  model: string;
  timestamp: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  tps: number | null;
}
export interface UsageData {
  summary: UsageSummary;
  models: {
    model: string;
    requests: number;
    tokens: number;
    costUsd: number;
    unpricedRequests: number;
  }[];
  days: { date: string; tokens: number; requests: number; costUsd: number }[];
  hours: { timestamp: number; tokens: number; requests: number }[];
  requests: UsageRequest[];
  total: number;
  offset: number;
  availableModels: string[];
  scan: {
    running: boolean;
    completed: number;
    files: number;
    updatedAt: number;
    errors: number;
    invalidLines: number;
    uncertainRecords: number;
  };
  warnings: string[];
}
