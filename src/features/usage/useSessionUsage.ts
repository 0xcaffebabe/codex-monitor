import { useUsage } from './useUsage';

export function useSessionUsage(sessionId: string, revision?: string) {
  const params = new URLSearchParams({
    session: sessionId,
    limit: '5',
    timezoneOffset: String(new Date().getTimezoneOffset()),
  }).toString();
  return useUsage(params, revision);
}
