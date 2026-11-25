import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '../../types';
import { useSessionDetail } from '../session/useSessionDetail';
import { preferredNewSessionWorkspace } from '../control/new-session-preferences';
import { sessionRows, type SessionGroup, type WorkspaceSession } from './session-list-model';
import { useOverview } from './useOverview';
import { useRealtime } from './useRealtime';
import { useSessionList } from './useSessionList';
import type { ReactNode } from 'react';
import type { ManagedWorkspace } from '../../workspaces';
import { navigateWorkspace, subscribeNavigation } from '../../workspace-scope';

export type WorkspaceProps = {
  user: User;
  onLogout: () => void;
  dark: boolean;
  setDark: (v: boolean) => void;
  workspaceName?: string;
  workspaceControls?: ReactNode;
  workspaceNotice?: string;
};

function tabFromParams(params: URLSearchParams) {
  const view = params.get('view');
  const status = params.get('status');
  if (view === 'usage' || view === 'attention') return view;
  if (status === 'running' || status === 'archived') return status;
  return ['view', 'session', 'q', 'project', 'scope', 'subagents', 'group'].some((key) => params.has(key))
    ? 'all'
    : 'attention';
}

export function useWorkspace(workspaceId: string, workspaces: ManagedWorkspace[], userId: string) {
  const [initialParams] = useState(() => new URLSearchParams(location.search));
  const [sidebarView, setSidebarView] = useState<'recent' | 'projects'>('recent'),
    [tab, setTab] = useState(() => tabFromParams(initialParams)),
    [result, setResult] = useState(() => ({ turn: initialParams.get('result'), observed: Number(initialParams.get('observed')) })),
    [attentionRequest, setAttentionRequest] = useState(() => initialParams.get('request')),
    [q, setQ] = useState(initialParams.get('q') || ''),
    [query, setQuery] = useState(initialParams.get('q') || ''),
    [project, setProject] = useState(initialParams.get('project') || ''),
    [scope, setScope] = useState(initialParams.get('scope') || ''),
    [subagents, setSubagents] = useState(initialParams.get('subagents') === 'true'),
    [selected, setSelected] = useState<string | undefined>(
      () => new URLSearchParams(location.search).get('session') || undefined,
    ),
    [menu, setMenu] = useState(false),
    [settings, setSettings] = useState(false),
    [creating, setCreating] = useState(
      initialParams.get('view') === 'new' && !initialParams.get('session'),
    ),
    [usageRevision, setUsageRevision] = useState(0),
    [toast, setToast] = useState(''),
    [group, setGroup] = useState<SessionGroup>(
      initialParams.get('group') === 'project' ? 'project' : 'time',
    );
  const workspaceScope = project
    ? workspaceId
    : workspaces.some((workspace) => workspace.id === scope) ? scope : '';
  const { sessions, total, error, listWarning, listWarningLabels, listBusy, loadList } = useSessionList({
    query,
    project,
    tab,
    subagents,
    workspaces: workspaceScope ? workspaces.filter((workspace) => workspace.id === workspaceScope) : workspaces,
    enabled: !!selected || creating || (tab !== 'attention' && tab !== 'usage'),
  });
  const { overviews, loadOverviews } = useOverview(workspaces);
  const overview = overviews[workspaceId]?.summary;
  const loadOverview = () => loadOverviews(workspaceId);
  const {
    page,
    outlineData,
    outlineError,
    detailBusy,
    detailSyncing,
    detailError,
    loadDetail,
    loadOutline,
    loadOutlineEntry,
    navigatingOutline,
  } = useSessionDetail(selected, workspaceId);
  const searchRef = useRef<HTMLInputElement>(null);
  const notify = useCallback((text: string) => setToast(text), []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setMenu(false);
        setSettings(false);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    return subscribeNavigation(() => {
      const params = new URLSearchParams(location.search);
      setMenu(false);
      setSettings(false);
      setCreating(params.get('view') === 'new' && !params.get('session'));
      setSelected(params.get('session') || undefined);
      setTab(tabFromParams(params));
      setResult({ turn: params.get('result'), observed: Number(params.get('observed')) });
      setAttentionRequest(params.get('request'));
      setQ(params.get('q') || '');
      setQuery(params.get('q') || '');
      setProject(params.get('project') || '');
      setScope(params.get('scope') || '');
      setSubagents(params.get('subagents') === 'true');
      setGroup(params.get('group') === 'project' ? 'project' : 'time');
    });
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('workspace') !== workspaceId) return;
    if (selected) params.set('session', selected);
    else params.delete('session');
    if (creating) params.set('view', 'new');
    else if (tab === 'usage' || tab === 'attention' || tab === 'all') params.set('view', tab);
    else params.delete('view');
    if (!selected || !result.turn) {
      params.delete('result');
      params.delete('observed');
    }
    if (!selected || !attentionRequest) params.delete('request');
    const filters = {
      q,
      project,
      scope: workspaceScope,
      status: tab === 'running' || tab === 'archived' ? tab : '',
      subagents: subagents ? 'true' : '',
      group: group === 'project' ? 'project' : '',
    };
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    history.replaceState(history.state, '', location.pathname + (params.size ? '?' + params : ''));
  }, [workspaceId, selected, tab, q, project, workspaceScope, subagents, group, creating, result.turn, attentionRequest]);
  const refreshDetail = () => {
    loadOverview();
    if (selected && !navigatingOutline.current) void loadDetail(selected);
  };
  const { connected, reconnect } = useRealtime(selected, refreshDetail, loadOverviews, workspaceId);
  const select = (id: string) => {
    setAttentionRequest(null);
    setResult({ turn: null, observed: 0 });
    setCreating(false);
    setSelected(id);
    setMenu(false);
  };
  const selectSession = (session: WorkspaceSession) => {
    if (session.workspaceId === workspaceId) select(session.id);
    else {
      const params = new URLSearchParams(location.search);
      for (const key of ['result', 'observed', 'request']) params.delete(key);
      navigateWorkspace(session.workspaceId, session.id, params);
    }
  };
  const selectProject = (id: string, path: string) => {
    const params = new URLSearchParams({ view: 'all', project: path, scope: id });
    if (q) params.set('q', q);
    if (subagents) params.set('subagents', 'true');
    if (group === 'project') params.set('group', group);
    navigateWorkspace(id, undefined, params);
  };
  const startSession = () => {
    if (!creating && !project) {
      const workspace = preferredNewSessionWorkspace(userId, workspaces, workspaceId);
      if (workspace && workspace.id !== workspaceId) {
        navigateWorkspace(workspace.id, undefined, new URLSearchParams({ view: 'new' }));
        return;
      }
    }
    setTab('all');
    setSelected(undefined);
    setCreating(true);
    setMenu(false);
  };
  const closeDetail = () => {
    setAttentionRequest(null);
    setResult({ turn: null, observed: 0 });
    setCreating(false);
    setSelected(undefined);
  };
  const changeTab = (value: string) => {
    if (value === 'attention') {
      navigateWorkspace(workspaceId, undefined, new URLSearchParams({ view: 'attention' }));
      return;
    }
    setTab(value);
    closeDetail();
    setProject('');
    if (value === 'all') setScope('');
    setMenu(false);
  };
  const title =
    tab === 'attention'
      ? '任务动态'
      : tab === 'usage'
      ? '用量统计'
      : project
        ? overview?.projects.find((p) => p.path === project)?.name ||
          project.split(/[\\/]/).filter(Boolean).at(-1) || project
        : tab === 'running'
          ? '正在进行'
          : tab === 'archived'
            ? '已归档会话'
            : '全部会话';
  const rows = sessionRows(sessions, group);

  return {
    workspaceId,
    overview,
    overviews,
    sidebarView,
    setSidebarView,
    sessions,
    total,
    tab,
    setTab,
    q,
    setQ,
    setQuery,
    project,
    setProject,
    scope: workspaceScope,
    setScope,
    subagents,
    setSubagents,
    selected,
    page,
    result,
    attentionRequest,
    outlineData,
    outlineError,
    listBusy,
    detailBusy,
    detailSyncing,
    error,
    listWarning,
    listWarningLabels,
    detailError,
    connected,
    reconnect,
    menu,
    setMenu,
    settings,
    setSettings,
    creating,
    startSession,
    closeDetail,
    usageRevision,
    setUsageRevision,
    toast,
    group,
    setGroup,
    searchRef,
    notify,
    loadList,
    loadOverview,
    loadOverviews,
    loadDetail,
    loadOutline,
    loadOutlineEntry,
    select,
    selectProject,
    selectSession,
    changeTab,
    title,
    rows,
  };
}
export type WorkspaceModel = ReturnType<typeof useWorkspace>;
