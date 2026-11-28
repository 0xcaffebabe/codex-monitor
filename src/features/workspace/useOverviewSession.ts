import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { DetailLoader } from '../../detail-loader';
import type { SessionPage } from '../../types';
import { mergeSessionPage } from '../session/session-model';

const pageLimit = 40;

/** Each pane owns its polling, loaded history and reading position, including while enlarged. */
export function useOverviewSession(
  workspaceId: string,
  sessionId: string,
  { hidden, online, expanded }: { hidden: boolean; online: boolean; expanded: boolean },
) {
  const [page, setPage] = useState<SessionPage>();
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(true);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const previousTop = useRef(0);
  const hasHistory = useRef(false);
  const olderPosition = useRef<{
    before: number;
    anchor?: HTMLElement;
    offset: number;
    height: number;
    top: number;
  } | null>(null);
  const loader = useMemo(
    () =>
      new DetailLoader(
        {
          onPage: (data, older) => {
            if (older) hasHistory.current = true;
            const preserveHistory = hasHistory.current || olderPosition.current !== null;
            setPage((current) => (preserveHistory ? mergeSessionPage(current, data, older) : data));
            setError('');
          },
          onError: (_, failure, older) => {
            if (older) setOlderFailed(true);
            setError(failure.message);
          },
          onSettled: () => {},
        },
        workspaceId,
      ),
    [workspaceId],
  );

  useEffect(() => {
    if (hidden || !online) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const refresh = async () => {
      if (!document.hidden) await loader.load(sessionId, false, undefined, pageLimit);
      if (!stopped) timer = setTimeout(() => void refresh(), 1500);
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      loader.cancel();
    };
  }, [hidden, loader, online, sessionId]);

  function rememberPosition(element: HTMLDivElement, before: number) {
    const edge = element.getBoundingClientRect().top;
    const anchor = Array.from(
      element.querySelectorAll<HTMLElement>(':scope > .overview-message, :scope > .activity-group'),
    ).find((block) => block.getBoundingClientRect().bottom > edge);
    olderPosition.current = {
      before,
      anchor,
      offset: anchor ? anchor.getBoundingClientRect().top - edge : 0,
      height: element.scrollHeight,
      top: element.scrollTop,
    };
  }

  async function loadOlder() {
    const element = scroll.current;
    if (!element || hidden || !online || page?.before == null || olderBusy || olderPosition.current)
      return;
    rememberPosition(element, page.before);
    setFollow(false);
    setOlderFailed(false);
    setOlderBusy(true);
    await loader.load(sessionId, true, page.before, pageLimit);
    setOlderBusy(false);
  }

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const position = olderPosition.current;
    if (position && page?.before !== position.before) {
      if (!follow && !hidden) {
        element.scrollTop = position.anchor?.isConnected
          ? element.scrollTop +
            position.anchor.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            position.offset
          : position.top + element.scrollHeight - position.height;
        previousTop.current = element.scrollTop;
      }
      olderPosition.current = null;
    } else if (position && !olderBusy) {
      olderPosition.current = null;
    }
    if (follow && !hidden) {
      element.scrollTop = element.scrollHeight;
      previousTop.current = element.scrollTop;
    }
  }, [page, expanded, follow, hidden, olderBusy]);

  useEffect(() => {
    const element = scroll.current;
    if (
      element?.clientHeight &&
      !olderFailed &&
      (element.scrollHeight <= element.clientHeight || (!follow && element.scrollTop <= 80))
    )
      void loadOlder();
  }, [page, expanded, follow, hidden, online, olderBusy, olderFailed]);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const top = element.scrollTop;
    if (!element.clientHeight || top === previousTop.current) return;
    const upward = top < previousTop.current;
    previousTop.current = top;
    if (olderPosition.current) rememberPosition(element, olderPosition.current.before);
    if (upward && top <= 80 && page?.before != null) {
      setFollow(false);
      if (!olderFailed) void loadOlder();
    } else {
      setFollow(element.scrollHeight - top - element.clientHeight < 24);
    }
  }

  return { page, error, follow, setFollow, olderBusy, olderFailed, scroll, loadOlder, onScroll };
}
