import type { SessionPage, TimelineEvent } from '../../types';

export function mergeSessionPage(
  old: SessionPage | undefined,
  data: SessionPage,
  older: boolean,
): SessionPage {
  const id = data.session.id;
  if (!old || old.session.id !== id) return data;
  if (
    !older &&
    data.before !== null &&
    data.events.length &&
    !data.events.some((event) => old.events.some((previous) => previous.id === event.id))
  )
    return data;
  const map = new Map<string, TimelineEvent>();
  for (const e of older
    ? [...data.events, ...old.events]
    : [...old.events.filter((e) => !e.transient), ...data.events])
    map.set(e.id, e);
  return {
    ...data,
    events: [...map.values()].sort((a, b) => a.timestamp - b.timestamp),
    before: older ? data.before : old.before,
  };
}
export const isActivity = (event: TimelineEvent) =>
  !event.image && (event.kind === 'tool' || event.kind === 'reasoning');
export const isToolRunning = (event: TimelineEvent) =>
  ['inProgress', 'in_progress', 'running'].includes(event.status || '');

export type TimelineBlock =
  | { kind: 'activity' | 'images'; id: string; events: TimelineEvent[] }
  | { kind: 'event'; id: string; event: TimelineEvent };

/** Group adjacent activity within a turn; images keep their own preview group. */
export function groupTimelineEvents(events: TimelineEvent[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  for (const event of events) {
    const previous = blocks.at(-1);
    if (isActivity(event)) {
      if (previous?.kind === 'activity' && previous.events[0].turnId === event.turnId)
        previous.events.push(event);
      else blocks.push({ kind: 'activity', id: event.id, events: [event] });
    } else if (event.image) {
      if (previous?.kind === 'images') previous.events.push(event);
      else blocks.push({ kind: 'images', id: event.id, events: [event] });
    } else blocks.push({ kind: 'event', id: event.id, event });
  }
  return blocks;
}
