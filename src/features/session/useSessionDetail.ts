import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { DetailLoader } from '../../detail-loader';
import type { OutlineEntry, SessionOutline, SessionPage } from '../../types';
import { mergeSessionPage } from './session-model';

export function useSessionDetail(selected: string | undefined, workspaceId: string) {
  const [page, setPage] = useState<SessionPage>(),
    [outlineData, setOutlineData] = useState<SessionOutline>(),
    [outlineError, setOutlineError] = useState(''),
    [detailError, setDetailError] = useState(''),
    [detailSyncing, setDetailSyncing] = useState(false),
    [detailBusy, setDetailBusy] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const detailKey = JSON.stringify([workspaceId, selected]);
  const loadedKey = useRef('');
  const detailPageRef = useRef<SessionPage | undefined>(undefined);
  const outlineRequest = useRef<{ id: string; controller: AbortController } | null>(null);
  const outlineReloadRef = useRef<((id: string) => Promise<void>) | null>(null);
  const navigatingOutline = useRef(false);
  const detailLoader = useMemo(
    () =>
      new DetailLoader({
        onPage(data, older) {
          if (workspaceRef.current !== workspaceId || selectedRef.current !== data.session.id)
            return;
          const id = data.session.id;
          detailPageRef.current = mergeSessionPage(detailPageRef.current, data, older);
          setPage(detailPageRef.current);
          setDetailSyncing(false);
          setDetailError('');
          if (!older) void outlineReloadRef.current?.(id);
        },
        onError(id, error) {
          if (workspaceRef.current === workspaceId && selectedRef.current === id)
            setDetailError(error.message);
        },
        onPending(id) {
          if (workspaceRef.current !== workspaceId || selectedRef.current !== id) return;
          setDetailBusy(true);
          setDetailSyncing(true);
          setDetailError('');
        },
        onSettled(id) {
          if (workspaceRef.current !== workspaceId || selectedRef.current !== id) return;
          setDetailBusy(false);
          setDetailSyncing(false);
        },
      }),
    [workspaceId],
  );
  const loadDetail = useCallback(
    (id: string, older = false, before?: number) => {
      if (workspaceRef.current !== workspaceId) return Promise.resolve();
      if (selectedRef.current === id && !older && !detailPageRef.current) {
        setDetailBusy(true);
        setDetailError('');
      }
      return detailLoader.load(id, older, before);
    },
    [detailLoader, workspaceId],
  );
  const loadOutline = useCallback(
    async (id: string) => {
      if (workspaceRef.current !== workspaceId) return;
      if (outlineRequest.current?.id === id) return;
      outlineRequest.current?.controller.abort();
      const request = { id, controller: new AbortController() };
      outlineRequest.current = request;
      try {
        const data = await api<SessionOutline>(`/api/sessions/${id}/outline`, {
          signal: request.controller.signal,
        });
        if (
          workspaceRef.current === workspaceId &&
          selectedRef.current === id &&
          !request.controller.signal.aborted
        ) {
          setOutlineData(data);
          setOutlineError('');
        }
      } catch (error) {
        if (
          workspaceRef.current === workspaceId &&
          selectedRef.current === id &&
          !request.controller.signal.aborted
        )
          setOutlineError((error as Error).message);
      } finally {
        if (outlineRequest.current === request) outlineRequest.current = null;
      }
    },
    [workspaceId],
  );
  outlineReloadRef.current = loadOutline;
  const loadOutlineEntry = useCallback(
    async (entry: OutlineEntry) => {
      const id = selectedRef.current;
      if (!id) return;
      navigatingOutline.current = true;
      try {
        while (workspaceRef.current === workspaceId && selectedRef.current === id) {
          const current = detailPageRef.current;
          if (current?.events.some((event) => event.id === entry.id)) return;
          const before = current?.before;
          if (before === null || before === undefined)
            throw new Error('暂时无法定位这条提问，请重试');
          await detailLoader.load(id, true, before, 200);
          if (workspaceRef.current !== workspaceId || selectedRef.current !== id) return;
          if (detailPageRef.current?.before === before) throw new Error('历史记录加载失败，请重试');
        }
      } finally {
        navigatingOutline.current = false;
      }
    },
    [detailLoader, workspaceId],
  );

  useEffect(() => {
    loadedKey.current = detailKey;
    setPage(undefined);
    detailPageRef.current = undefined;
    setOutlineData(undefined);
    setOutlineError('');
    setDetailError('');
    setDetailSyncing(false);
    setDetailBusy(!!selected);
    if (selected) {
      void loadDetail(selected);
    }
    return () => {
      detailLoader.cancel();
      outlineRequest.current?.controller.abort();
      outlineRequest.current = null;
      navigatingOutline.current = false;
    };
  }, [detailKey, selected, detailLoader, loadDetail, loadOutline]);

  const current = loadedKey.current === detailKey;
  return {
    page: current ? page : undefined,
    outlineData: current ? outlineData : undefined,
    outlineError: current ? outlineError : '',
    detailError: current ? detailError : '',
    detailBusy: current ? detailBusy : !!selected,
    detailSyncing: current && detailSyncing,
    loadDetail,
    loadOutline,
    loadOutlineEntry,
    navigatingOutline,
  };
}
