import { useEffect, useState } from 'react';
import { api } from '../../api';
import { workspaceUrl } from '../../workspace-scope';
import { dateKey, localDay } from './format';
import { useUsage } from './useUsage';

export function useUsageDashboard({
  revision,
  workspaceId,
}: {
  revision?: number;
  workspaceId?: string;
}) {
  const [range, setRange] = useState('24h'),
    [model, setModel] = useState(''),
    [project, setProject] = useState(''),
    [subagents, setSubagents] = useState(true),
    [offset, setOffset] = useState(0);
  const [from, setFrom] = useState(dateKey(new Date(Date.now() - 6 * 86400000))),
    [to, setTo] = useState(dateKey(new Date()));
  const [anchor, setAnchor] = useState(Date.now());
  const [filterWorkspace, setFilterWorkspace] = useState(workspaceId);
  if (filterWorkspace !== workspaceId) {
    setFilterWorkspace(workspaceId);
    setModel('');
    setProject('');
    setOffset(0);
  }
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
  const { data, error, busy, reload } = useUsage(params.toString(), revision, workspaceId);
  const [projectList, setProjectList] = useState<{
    workspaceId?: string;
    projects: { name: string; path: string }[];
  }>();
  useEffect(() => {
    const abort = new AbortController();
    const url = workspaceId ? workspaceUrl('/api/overview', workspaceId) : '/api/overview';
    void api<{ projects: { name: string; path: string }[] }>(url, { signal: abort.signal })
      .then(({ projects }) => setProjectList({ workspaceId, projects }))
      .catch(() => {});
    return () => abort.abort();
  }, [workspaceId]);
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
    projects: projectList && projectList.workspaceId === workspaceId ? projectList.projects : [],
    change,
    s,
  };
}
export type UsageDashboardModel = ReturnType<typeof useUsageDashboard>;
