import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import type { GitFileDiff, GitScope, GitStatus } from '../../git-types';
import { parseDiff } from './diff-model';

export function useGitDiff(sessionId: string) {
  const [scope, setScope] = useState<GitScope>('all');
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<GitStatus>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [diff, setDiff] = useState<GitFileDiff>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  const [diffRevision, setDiffRevision] = useState(0);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [reviewTarget, setReviewTarget] = useState<'all' | 'file' | null>(null);
  const selection = useRef('');
  selection.current = selected;
  const base = `/api/sessions/${sessionId}/git`;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setStatus(undefined);
    setDiff(undefined);
    setReviewTarget(null);
    setReviewed(new Set());
    void api<GitStatus>(`${base}?scope=${scope}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setStatus(data);
        setSelected(
          data.files.some((file) => file.path === selection.current)
            ? selection.current
            : (data.files[0]?.path ?? ''),
        );
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, scope, revision]);

  useEffect(() => {
    setDiff(undefined);
    setDiffError('');
    if (!status || !selected || status.scope !== scope) {
      setDiffLoading(false);
      return;
    }
    const controller = new AbortController();
    setDiffLoading(true);
    const params = new URLSearchParams({ scope, path: selected });
    void api<GitFileDiff>(`${base}/diff?${params}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setDiff(data);
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setDiffError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDiffLoading(false);
      });
    return () => controller.abort();
  }, [base, status, selected, scope, diffRevision]);

  const files = useMemo(
    () =>
      status?.files.filter((file) =>
        file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ) ?? [],
    [status, query],
  );
  const lines = useMemo(() => parseDiff(diff?.patch ?? ''), [diff]);
  const file = status?.files.find((item) => item.path === selected);
  return {
    scope,
    setScope,
    status,
    loading,
    error,
    query,
    setQuery,
    files,
    selected,
    file,
    select: (value: string) => {
      setSelected(value);
      setReviewTarget(null);
    },
    diff,
    lines,
    diffLoading,
    diffError,
    retryDiff: () => setDiffRevision((value) => value + 1),
    refresh: () => setRevision((value) => value + 1),
    reviewed,
    toggleReviewed: () =>
      setReviewed((previous) => {
        const next = new Set(previous);
        if (next.has(selected)) next.delete(selected);
        else next.add(selected);
        return next;
      }),
    reviewTarget,
    setReviewTarget,
  };
}
