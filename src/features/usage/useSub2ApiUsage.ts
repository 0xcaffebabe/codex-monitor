import { useEffect, useState } from 'react';
import { api } from '../../api';
import type {
  Sub2ApiAccount,
  Sub2ApiAccountDetails,
  Sub2ApiCallRecord,
  Sub2ApiKeyUsage,
  Sub2ApiPage,
  Sub2ApiSettings,
} from '../../sub2api-types';
import { dateKey } from './format';

export type Sub2ApiView = 'accounts' | 'keys' | 'calls';

export function defaultCallRecordFilters() {
  const today = dateKey(new Date());
  return {
    startDate: today,
    endDate: today,
    apiKey: '',
    model: '',
    requestType: '',
    billingMode: '',
    billingType: '',
    userId: '',
    accountId: '',
    groupId: '',
  };
}

export type CallRecordFilters = ReturnType<typeof defaultCallRecordFilters>;

function useQuery<T>(url: string | undefined, revision = 0) {
  const [result, setResult] = useState<{
    url: string;
    revision: number;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!url) return;
    const abort = new AbortController();
    void api<T>(url, { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted) setResult({ url, revision, data });
      })
      .catch((e: Error) => {
        if (!abort.signal.aborted) setResult({ url, revision, error: e.message });
      });
    return () => abort.abort();
  }, [url, revision]);
  const current = result?.url === url ? result : undefined;
  const busy = !!url && current?.revision !== revision;
  return { data: current?.data, error: busy ? undefined : current?.error, busy };
}

export function useSub2ApiAccountDetails(
  accountId: number,
  platform: 'openai' | 'anthropic',
  enabled: boolean,
) {
  return useQuery<Sub2ApiAccountDetails>(
    enabled
      ? `/api/sub2api/account-details?accountId=${accountId}&platform=${platform}`
      : undefined,
  );
}

export function useSub2ApiUsage(revision = 0) {
  const [view, setView] = useState<Sub2ApiView>('accounts');
  const [page, setPage] = useState(1);
  const [draftSearch, setDraftSearch] = useState('');
  const [search, setSearch] = useState('');
  const [accountType, setAccountType] = useState('oauth');
  const [days, setDays] = useState('7');
  const [callFilters, setCallFilters] = useState(defaultCallRecordFilters);
  const [refreshCount, setRefreshCount] = useState(0);
  const generation = revision + refreshCount;
  const settings = useQuery<Sub2ApiSettings>('/api/sub2api/settings', generation);
  const configured = settings.data?.configured;
  const params = new URLSearchParams({ page: String(page) });
  if (view === 'calls') {
    for (const [key, value] of Object.entries(callFilters)) {
      if (value) params.set(key, value);
    }
  } else params.set('search', search);

  if (view === 'accounts') params.set('type', accountType);
  if (view === 'keys') {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - Number(days) + 1);
    params.set('startDate', dateKey(start));
    params.set('endDate', dateKey(end));
  }
  if (view !== 'accounts') params.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
  const query = configured ? `/api/sub2api/${view}?${params}` : undefined;
  const accounts = useQuery<Sub2ApiPage<Sub2ApiAccount>>(
    view === 'accounts' ? query : undefined,
    generation,
  );
  const keys = useQuery<Sub2ApiPage<Sub2ApiKeyUsage>>(
    view === 'keys' ? query : undefined,
    generation,
  );
  const calls = useQuery<Sub2ApiPage<Sub2ApiCallRecord>>(
    view === 'calls' ? query : undefined,
    generation,
  );
  const result = { accounts, keys, calls }[view];
  const busy = settings.busy || result.busy;
  const error = settings.error || result.error;
  const nextPage = !!result.data && page * result.data.pageSize < result.data.total;
  const refresh = () => setRefreshCount((value) => value + 1);

  function show(next: Sub2ApiView) {
    if (next === view) return;
    setView(next);
    setPage(1);
    setDraftSearch('');
    setSearch('');
  }

  function submitSearch() {
    const nextSearch = draftSearch.trim();
    if (page === 1 && search === nextSearch && result.error) {
      refresh();
      return;
    }
    setPage(1);
    setSearch(nextSearch);
  }

  function selectAccountType(value: string) {
    setPage(1);
    setAccountType(value);
  }

  function selectDays(value: string) {
    setPage(1);
    setDays(value);
  }

  function applyCallFilters(filters: CallRecordFilters) {
    setCallFilters(filters);
    setPage(1);
    refresh();
  }

  return {
    view,
    page,
    draftSearch,
    setDraftSearch,
    accountType,
    days,
    callFilters,
    generation,
    settings,
    configured,
    accounts,
    keys,
    calls,
    result,
    busy,
    error,
    nextPage,
    show,
    refresh,
    submitSearch,
    selectAccountType,
    selectDays,
    applyCallFilters,
    previous: () => setPage(page - 1),
    next: () => setPage(page + 1),
  };
}
