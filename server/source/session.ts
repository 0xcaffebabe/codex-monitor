import type { Session } from '../../src/types.js';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const validId = (id: string) => UUID.test(id);
export type InternalSession = Session & { file: string; historyMode: string; subagent: boolean };
export function publicSession(s: InternalSession): Session {
  const { file, historyMode, subagent, ...result } = s;
  return result;
}
