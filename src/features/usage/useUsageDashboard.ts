import { useEffect, useState } from 'react';
import { api } from '../../api';
import { dateKey, localDay } from './format';
import { useUsage } from './useUsage';

export type UsageDashboardProps = {
  onSession: (id: string) => void;
  revision?: number;
  openSub2ApiSettings?: () => void;
};
export function useUsageDashboard({ revision }: UsageDashboardProps) {
  const [range, setRange] = useState('24h'),
    [model, setModel] = useState(''),
    [project, setProject] = useState(''),
    [subagents, setSubagents] = useState(true),
    [offset, setOffset] = useState(0);
  const [from, setFrom] = useState(dateKey(new Date(Date.now() - 6 * 86400000))),
    [to, setTo] = useState(dateKey(new Date()));
  const [anchor, setAnchor] = useState(Date.now());
  const params = new URLSearchParams({
    limit: '50',
    offset: String(offset),
    timezoneOffset: String(new Date().getTimezoneOffset()),
    subagents: String(subagents),
  });
  if (range === 'custom') {
    if (from) params.set('from', String(localDay(from)));
    if (to) {
      const end = new Date(to + 'T00:00:00');
      end.setDate(end.getDate() + 1);
      params.set('to', String(+end));
    }
  } else if (range !== 'all')
    params.set(
      'from',
      String(anchor - Number(range === '24h' ? 1 : range === '7d' ? 7 : 30) * 86400000),
    );
  if (model) params.set('model', model);
  if (project) params.set('project', project);
  const { data, error, busy, reload } = useUsage(params.toString(), revision);
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  useEffect(() => {
    void api<{ projects: { name: string; path: string }[] }>('/api/overview')
      .then((o) => setProjects(o.projects))
      .catch(() => {});
  }, []);
  const change = (fn: () => void) => {
    fn();
    setOffset(0);
    setAnchor(Date.now());
  };
  const s = data?.summary;

  return {
    range,
    setRange,
    model,
    setModel,
    project,
    setProject,
    subagents,
    setSubagents,
    offset,
    setOffset,
    from,
    setFrom,
    to,
    setTo,
    anchor,
    setAnchor,
    data,
    error,
    busy,
    reload,
    projects,
    change,
    s,
  };
}
export type UsageDashboardModel = ReturnType<typeof useUsageDashboard>;
