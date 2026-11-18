import { useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react';
import type { OutlineEntry, SessionOutline, SessionPage, User } from '../../types';
import { groupTimelineEvents } from './session-model';

export type DetailProps = {
  user: User;
  onMessageSent: () => void;
  page?: SessionPage;
  outlineData?: SessionOutline;
  outlineError: string;
  onOutlineEntry: (entry: OutlineEntry) => Promise<void>;
  loading: boolean;
  syncing?: boolean;
  error: string;
  onBack: () => void;
  onRetry: () => void;
  onOlder: () => Promise<void>;
  notify: (s: string) => void;
  connected: boolean;
};
export function useTimeline({
  page,
  outlineData,
  onOutlineEntry,
  error,
  onOlder,
  notify,
}: DetailProps) {
  const [searchText, setFind] = useState(''),
    [activeEntry, setActiveEntry] = useState(''),
    [jumpingEntry, setJumpingEntry] = useState(''),
    [jumpTarget, setJumpTarget] = useState(''),
    [follow, setFollow] = useState(true),
    [olderBusy, setOlderBusy] = useState(false),
    [olderFailed, setOlderFailed] = useState(false),
    [infoExpanded, setInfoExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null),
    bottomRef = useRef<HTMLDivElement>(null),
    lastId = useRef('');
  const scrollLock = useRef(false);
  const searchScroll = useRef<number | null>(null);
  const previousScrollTop = useRef(0);
  const touchY = useRef<number | null>(null);
  const olderRequest = useRef<object | null>(null);
  const olderScroll = useRef<{
    sessionId: string;
    before: number;
    find: string;
    anchor?: HTMLElement;
    offset: number;
    height: number;
    top: number;
  } | null>(null);
  const session = page?.session;
  const find = searchText.trim().toLowerCase();
  useEffect(() => {
    setFind('');
    setFollow(true);
    setActiveEntry('');
    setJumpTarget('');
    setInfoExpanded(false);
    setOlderBusy(false);
    setOlderFailed(false);
    olderRequest.current = null;
    olderScroll.current = null;
    scrollLock.current = false;
    searchScroll.current = null;
    previousScrollTop.current = 0;
    touchY.current = null;
  }, [session?.id]);
  useLayoutEffect(() => {
    const reader = scrollRef.current;
    if (!reader) return;
    if (find) {
      searchScroll.current ??= previousScrollTop.current;
      reader.scrollTop = 0;
    } else if (searchScroll.current !== null) {
      reader.scrollTop = searchScroll.current;
      searchScroll.current = null;
    }
  }, [find]);
  function rememberOlderPosition() {
    const el = scrollRef.current,
      position = olderScroll.current;
    if (!el || !position) return;
    const top = el.getBoundingClientRect().top;
    position.anchor = [...el.querySelectorAll<HTMLElement>('[id^="event-"]')].find(
      (event) => event.getBoundingClientRect().bottom > top,
    );
    position.offset = position.anchor ? position.anchor.getBoundingClientRect().top - top : 0;
    position.height = el.scrollHeight;
    position.top = el.scrollTop;
  }
  async function loadOlder() {
    if (!session || page?.before == null || olderRequest.current || scrollLock.current) return;
    const request = {};
    olderRequest.current = request;
    olderScroll.current = {
      sessionId: session.id,
      before: page.before,
      find,
      offset: 0,
      height: 0,
      top: 0,
    };
    rememberOlderPosition();
    if (!find) setFollow(false);
    setOlderFailed(false);
    setOlderBusy(true);
    try {
      await onOlder();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      if (olderRequest.current === request) {
        olderRequest.current = null;
        setOlderBusy(false);
      }
    }
  }
  function readOlderFromInput(target: EventTarget | null) {
    const el = scrollRef.current;
    if (!el || find || lastId.current !== session?.id || scrollLock.current) return;
    // Let a nested tool/code panel consume its own upward scroll first.
    for (
      let node = target instanceof Element ? target : null;
      node && node !== el;
      node = node.parentElement
    )
      if (node.scrollTop > 0) return;
    setFollow(false);
    if (el.scrollTop <= 80 && !olderFailed && !error) void loadOlder();
  }
  useLayoutEffect(() => {
    const el = scrollRef.current,
      position = olderScroll.current;
    if (!el || !position) return;
    if (position.sessionId !== session?.id || position.find !== find || scrollLock.current) {
      olderScroll.current = null;
      return;
    }
    if (page?.before !== position.before) {
      el.scrollTop = position.anchor?.isConnected
        ? el.scrollTop +
          position.anchor.getBoundingClientRect().top -
          el.getBoundingClientRect().top -
          position.offset
        : position.top + el.scrollHeight - position.height;
      previousScrollTop.current = el.scrollTop;
      olderScroll.current = null;
    } else if (!olderBusy) {
      olderScroll.current = null;
      setOlderFailed(true);
    }
  }, [page, olderBusy, session?.id, find]);
  useEffect(() => {
    if (outlineData)
      setActiveEntry((previous) =>
        outlineData.entries.some((entry) => entry.id === previous)
          ? previous
          : outlineData.entries.at(-1)?.id || '',
      );
  }, [outlineData]);
  async function jumpToEntry(entry: OutlineEntry) {
    setFind('');
    setFollow(false);
    scrollLock.current = true;
    setJumpingEntry(entry.id);
    try {
      await onOutlineEntry(entry);
      setFollow(false);
      setActiveEntry(entry.id);
      setJumpTarget(entry.id);
    } catch (error) {
      scrollLock.current = false;
      notify((error as Error).message);
    } finally {
      setJumpingEntry('');
    }
  }
  useEffect(() => {
    if (!jumpTarget) return;
    const target = document.getElementById('event-' + jumpTarget);
    if (!target) return;
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
    setJumpTarget('');
    requestAnimationFrame(() => {
      scrollLock.current = false;
    });
  }, [jumpTarget, page, find]);
  useEffect(() => {
    if (follow && page && !find) {
      const frame = requestAnimationFrame(() => {
        if (scrollLock.current) return;
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: lastId.current === session?.id ? 'smooth' : 'instant',
        });
        lastId.current = session?.id || '';
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [page, follow, session?.id, find]);
  useEffect(() => {
    if (!session || page?.before == null || olderBusy || olderFailed || error || find) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (
        el &&
        lastId.current === session.id &&
        !scrollLock.current &&
        (!page.events.length || (!follow && el.scrollTop <= 80))
      )
        void loadOlder();
    });
    return () => cancelAnimationFrame(frame);
  }, [page, olderBusy, olderFailed, error, follow, find, session?.id]);
  const events =
    page?.events.filter(
      (e) => !find || `${e.text} ${e.name || ''} ${e.title || ''}`.toLowerCase().includes(find),
    ) ?? [];
  const toolCount = page?.events.filter((e) => e.kind === 'tool').length ?? 0;
  const outlineEntries = useMemo(
    () =>
      outlineData?.entries ??
      (page?.events.filter((e) => e.kind === 'user') ?? []).map((event, index) => ({
        id: event.id,
        ordinal: index,
        timestamp: event.timestamp,
        prompt: event.text,
        reply: '',
        tools: 0,
        status: session?.status ?? 'idle',
      })),
    [outlineData, page?.events, session?.status],
  );
  useEffect(() => {
    if (!scrollRef.current || find) return;
    const el = scrollRef.current;
    const anchors = outlineEntries.flatMap((entry) => {
      const node = document.getElementById('event-' + entry.id);
      return node && el.contains(node) ? [{ id: entry.id, node }] : [];
    });
    let frame = 0;
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (scrollLock.current || !anchors.length) return;
        const readingLine = el.getBoundingClientRect().top + Math.min(el.clientHeight * 0.2, 100);
        let current = anchors[0].id;
        for (const anchor of anchors) {
          if (anchor.node.getBoundingClientRect().top > readingLine) break;
          current = anchor.id;
        }
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) current = anchors.at(-1)!.id;
        setActiveEntry(current);
      });
    }
    el.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', schedule);
      observer.disconnect();
    };
  }, [outlineEntries, page, find]);

  const scrollHandlers: HTMLAttributes<HTMLDivElement> = {
    onWheel(event) {
      if (event.deltaY < 0) readOlderFromInput(event.target);
    },
    onTouchStart(event) {
      touchY.current = event.touches.length === 1 ? event.touches[0].clientY : null;
    },
    onTouchMove(event) {
      const next = event.touches.length === 1 ? event.touches[0].clientY : null;
      if (next !== null && touchY.current !== null && next > touchY.current)
        readOlderFromInput(event.target);
      touchY.current = next;
    },
    onTouchEnd() {
      touchY.current = null;
    },
    onTouchCancel() {
      touchY.current = null;
    },
    onKeyDown(event) {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) readOlderFromInput(event.target);
    },
    onScroll() {
      const el = scrollRef.current;
      const downward = !!el && el.scrollTop > previousScrollTop.current;
      previousScrollTop.current = el?.scrollTop ?? 0;
      if (el && !scrollLock.current) {
        if (olderScroll.current?.before === page?.before) rememberOlderPosition();
        const nearTop = page?.before != null && el.scrollTop <= 80;
        const readingOlder = !!olderRequest.current || (!follow && (!downward || nearTop));
        const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (!find) setFollow(!readingOlder && bottomGap < 140);
        if (
          lastId.current === session?.id &&
          nearTop &&
          (!follow || bottomGap >= 140) &&
          !find &&
          !olderFailed &&
          !error
        )
          void loadOlder();
      }
    },
  };
  function jumpToLatest() {
    setFollow(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }
  return {
    find,
    searchText,
    setFind,
    activeEntry,
    jumpingEntry,
    follow,
    setFollow,
    olderBusy,
    olderFailed,
    infoExpanded,
    setInfoExpanded,
    scrollRef,
    bottomRef,
    session,
    loadOlder,
    jumpToEntry,
    events,
    blocks: groupTimelineEvents(events),
    scrollHandlers,
    jumpToLatest,
    toolCount,
    outlineEntries,
  };
}
export type TimelineModel = ReturnType<typeof useTimeline>;
