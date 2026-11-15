import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { ComputerUsePage } from '../../types';

export function useComputerUse(sessionId: string, revision: string) {
  const [page, setPage] = useState<ComputerUsePage>(),
    [selectedId, setSelectedId] = useState(''),
    [imageIndex, setImageIndex] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const current = useRef<ComputerUsePage | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const pendingRefresh = useRef(false);
  const reload = useRef<() => void>(() => {});
  const load = useCallback(
    async (older = false) => {
      if (request.current) {
        if (!older) pendingRefresh.current = true;
        return;
      }
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError('');
      const before = older ? current.current?.before : undefined;
      try {
        const data = await api<ComputerUsePage>(
          `/api/sessions/${sessionId}/computer-use${before == null ? '' : `?before=${before}`}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        let previous = current.current;
        if (
          !older &&
          previous &&
          data.before !== null &&
          data.steps.length &&
          !data.steps.some((step) => previous!.steps.some((old) => old.id === step.id))
        )
          previous = undefined;
        const map = new Map(
          [...(previous?.steps ?? []), ...data.steps].map((step) => [step.id, step]),
        );
        const merged = {
          ...data,
          steps: [...map.values()].sort(
            (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
          ),
          before: older || !previous ? data.before : previous.before,
        };
        current.current = merged;
        setPage(merged);
        setSelectedId((id) =>
          merged.steps.some((step) => step.id === id)
            ? id
            : ([...merged.steps].reverse().find((step) => step.screenshots > 0)?.id ??
              merged.steps.at(-1)?.id ??
              ''),
        );
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        if (request.current === controller) {
          request.current = undefined;
          if (!controller.signal.aborted) setBusy(false);
          if (pendingRefresh.current && !controller.signal.aborted) {
            pendingRefresh.current = false;
            reload.current();
          }
        }
      }
    },
    [sessionId],
  );
  reload.current = () => void load();
  useEffect(() => {
    void load();
  }, [load, revision]);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [sessionId],
  );
  useEffect(() => {
    setImageIndex(0);
  }, [selectedId]);
  const selected = page?.steps.find((step) => step.id === selectedId);
  const position = page?.steps.findIndex((step) => step.id === selectedId) ?? -1;
  function move(delta: number) {
    const step = page?.steps[position + delta];
    if (step) setSelectedId(step.id);
  }
  return {
    page,
    selected,
    selectedId,
    select: setSelectedId,
    imageIndex,
    setImageIndex,
    error,
    busy,
    refresh: () => void load(),
    older: () => void load(true),
    move,
    position,
  };
}
