import { useEffect, useState } from 'react';
import { api } from '../../api';

export function useGitReview(sessionId: string) {
  const [state, setState] = useState<{ available: boolean; reason?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void api<{ available: boolean; reason?: string }>(`/api/sessions/${sessionId}/control`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setState(result);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setState({ available: false, reason: error.message });
      });
    return () => controller.abort();
  }, [sessionId]);
  return state;
}
