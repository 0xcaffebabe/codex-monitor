import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '../../types';
import { useSessionDetail } from '../session/useSessionDetail';
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
export function useWorkspace(workspaceId: string, workspaces: ManagedWorkspace[]) {
  const [initialParams] = useState(() => new URLSearchParams(location.search));
  const [sidebarView, setSidebarView] = useState<'recent' | 'projects'>('recent'),
    [tab, setTab] = useState(() =>
      initialParams.get('view') === 'usage'
        ? 'usage'
        : ['running', 'archived'].includes(initialParams.get('status') || '')
          ? initialParams.get('status')!
          : 'all',
    ),
    [q, setQ] = useState(initialParams.get('q') || ''),
    [query, setQuery] = useState(initialParams.get('q') || ''),
    [project, setProject] = useState(initialParams.get('project') || ''),
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
  const { sessions, total, error, listWarning, listBusy, loadList } = useSessionList({
    query,
    project,
    tab,
    subagents,
    workspaces,
  });
  const { overview, recentSessions, recentLoaded, recentError, loadOverview, loadRecentSessions } =
    useOverview(workspaceId);
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
    if (menu) void loadRecentSessions();
  }, [menu, loadRecentSessions]);
  useEffect(() => {
    return subscribeNavigation(() => {
      const params = new URLSearchParams(location.search);
      setMenu(false);
      setSettings(false);
      setCreating(params.get('view') === 'new' && !params.get('session'));
      setSelected(params.get('session') || undefined);
      setTab(
        params.get('view') === 'usage'
          ? 'usage'
          : ['running', 'archived'].includes(params.get('status') || '')
            ? params.get('status')!
            : 'all',
      );
      setQ(params.get('q') || '');
      setQuery(params.get('q') || '');
      setProject(params.get('project') || '');
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
    else if (tab === 'usage') params.set('view', 'usage');
    else params.delete('view');
    const filters = {
      q,
      project,
      status: tab === 'running' || tab === 'archived' ? tab : '',
      subagents: subagents ? 'true' : '',
      group: group === 'project' ? 'project' : '',
    };
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    history.replaceState(null, '', location.pathname + (params.size ? '?' + params : ''));
  }, [workspaceId, selected, tab, q, project, subagents, group, creating]);
  const reconcile = () => {
    void loadOverview();
  };
  const refreshDetail = () => {
    reconcile();
    if (selected && !navigatingOutline.current) void loadDetail(selected);
  };
  const connected = useRealtime(selected, refreshDetail, reconcile, workspaceId);
  const select = (id: string) => {
    setCreating(false);
    setSelected(id);
    setMenu(false);
  };
  const selectSession = (session: WorkspaceSession) => {
    if (session.workspaceId === workspaceId) select(session.id);
    else navigateWorkspace(session.workspaceId, session.id, new URLSearchParams(location.search));
  };
  const startSession = () => {
    setSelected(undefined);
    setCreating(true);
    setMenu(false);
  };
  const closeDetail = () => {
    setCreating(false);
    setSelected(undefined);
  };
  const changeTab = (value: string) => {
    setTab(value);
    closeDetail();
    setProject('');
    setMenu(false);
  };
  const title =
    tab === 'usage'
      ? '用量统计'
      : tab === 'running'
        ? '正在进行'
        : tab === 'archived'
          ? '已归档会话'
          : project
            ? overview?.projects.find((p) => p.path === project)?.name || '项目会话'
            : '全部会话';
  const rows = sessionRows(sessions, group);

  return {
    workspaceId,
    overview,
    recentSessions,
    recentLoaded,
    recentError,
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
    subagents,
    setSubagents,
    selected,
    page,
    outlineData,
    outlineError,
    listBusy,
    detailBusy,
    detailSyncing,
    error,
    listWarning,
    detailError,
    connected,
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
    loadRecentSessions,
    loadOverview,
    loadDetail,
    loadOutline,
    loadOutlineEntry,
    select,
    selectSession,
    changeTab,
    title,
    rows,
  };
}
export type WorkspaceModel = ReturnType<typeof useWorkspace>;
