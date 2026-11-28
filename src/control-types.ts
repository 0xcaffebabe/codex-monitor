/** Control responses shared by workspace services and browser consumers. */
export type Project = { id: string; name: string; path: string };

export type SessionGoal = {
  objective: string;
  status: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
};

export type Receipt = {
  state: string;
  requestId?: string;
  threadId?: string;
  mode?: 'append' | 'start' | 'create' | 'compact' | 'interrupt' | 'goal' | 'help';
  message?: string;
  error?: string;
  goal?: SessionGoal | null;
  acceptedAt?: number;
  goalObjective?: string;
  goalState?: 'pending' | 'saved' | 'failed' | 'unknown' | 'conflict';
  goalError?: string;
};
