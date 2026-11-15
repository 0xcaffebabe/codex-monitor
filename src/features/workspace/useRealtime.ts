import { useEffect, useRef, useState } from 'react';
import { stream } from '../../api';

export function useRealtime(
  selected: string | undefined,
  onUpdate: () => void,
  onReconcile: () => void,
) {
  const [connected, setConnected] = useState(false);
  const updateRef = useRef(onUpdate),
    reconcileRef = useRef(onReconcile);
  updateRef.current = onUpdate;
  reconcileRef.current = onReconcile;
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    const connect = async () => {
      try {
        await stream(
          selected,
          (event) => {
            if (controller.signal.aborted) return;
            if (event === 'ready' || event === 'heartbeat') setConnected(true);
            if (event === 'update') {
              setConnected(true);
              delay = 1000;
              updateRef.current();
            }
            if (event === 'source-error') setConnected(false);
          },
          controller.signal,
        );
      } catch {
        if (controller.signal.aborted) return;
        setConnected(false);
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      }
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [selected]);
  // Periodic reconciliation also catches renamed, archived or older sessions that are not the newest row.
  useEffect(() => {
    const t = setInterval(() => {
      reconcileRef.current();
    }, 15000);
    return () => clearInterval(t);
  }, []);

  return connected;
}
