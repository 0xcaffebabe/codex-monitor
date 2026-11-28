import { useEffect, useRef, useState } from 'react';
import { ApiError, stream } from '../../api';
import type { SessionReconnect } from '../../types';

export function useRealtime(
  selected: string | undefined,
  onUpdate: () => void,
  onReconcile: () => void,
  workspaceId: string,
) {
  const [connected, setConnected] = useState(false);
  const [retryStatus, setRetryStatus] = useState<{
    workspaceId: string;
    sessionId: string;
    reconnect: SessionReconnect;
  }>();
  const updateRef = useRef(onUpdate),
    reconcileRef = useRef(onReconcile);
  updateRef.current = onUpdate;
  reconcileRef.current = onReconcile;
  useEffect(() => {
    setConnected(false);
    setRetryStatus(undefined);
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    const connect = async () => {
      try {
        await stream(
          `/api/stream${selected ? '?session=' + encodeURIComponent(selected) : ''}`,
          (event, data) => {
            if (controller.signal.aborted) return;
            if (event === 'ready' || event === 'heartbeat') setConnected(true);
            if (event === 'update') {
              setConnected(true);
              delay = 1000;
              updateRef.current();
            }
            if (event === 'source-error') setConnected(false);
            if (event === 'turn-reconnect' && selected && data !== undefined) {
              try {
                const reconnect: SessionReconnect | null = JSON.parse(data);
                if (reconnect === null) setRetryStatus(undefined);
                else if (typeof reconnect?.turnId === 'string' && typeof reconnect.message === 'string')
                  setRetryStatus({ workspaceId, sessionId: selected, reconnect });
              } catch {
                // Ignore a malformed notification without restarting the stream.
              }
            }
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted || (error instanceof ApiError && error.status === 401)) return;
        setConnected(false);
        setRetryStatus(undefined);
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      }
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [selected, workspaceId]);
  // Periodic reconciliation also catches renamed, archived or older sessions that are not the newest row.
  useEffect(() => {
    const t = setInterval(() => {
      reconcileRef.current();
    }, 15000);
    return () => clearInterval(t);
  }, []);

  const reconnect = retryStatus?.workspaceId === workspaceId && retryStatus.sessionId === selected
    ? retryStatus.reconnect
    : undefined;
  return { connected, reconnect };
}
