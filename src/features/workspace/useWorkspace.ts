import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '../../types';
import { useSessionDetail } from '../session/useSessionDetail';
import { sessionRows, type SessionGroup } from './session-list-model';
import { useOverview } from './useOverview';
import { useRealtime } from './useRealtime';
import { useSessionList } from './useSessionList';
import type { ReactNode } from 'react';

export type WorkspaceProps = {
  user: User;
  onLogout: () => void;
  dark: boolean;
  setDark: (v: boolean) => void;
  workspaceName?: string;
  workspaceControls?: ReactNode;
  workspaceNotice?: string;
};
export function useWorkspace() {
  const [sidebarView, setSidebarView] = useState<'recent' | 'projects'>('recent'),
    [tab, setTab] = useState(() =>
      new URLSearchParams(location.search).get('view') === 'usage' ? 'usage' : 'all',
    ),
    [q, setQ] = useState(''),
    [query, setQuery] = useState(''),
    [project, setProject] = useState(''),
    [subagents, setSubagents] = useState(false),
    [selected, setSelected] = useState<string | undefined>(
      () => new URLSearchParams(location.search).get('session') || undefined,
    ),
    [menu, setMenu] = useState(false),
    [settings, setSettings] = useState(false),
    [creating, setCreating] = useState(false),
    [usageRevision, setUsageRevision] = useState(0),
    [toast, setToast] = useState(''),
    [group, setGroup] = useState<SessionGroup>('time');
  const {
    sessions,
    total,
    error: listError,
    listBusy,
    loadList,
  } = useSessionList({ query, project, tab, subagents });
  const {
    overview,
    recentSessions,
    recentLoaded,
    recentError,
    overviewError,
    loadOverview,
    loadRecentSessions,
  } = useOverview();
  const error = listError || overviewError;
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
  } = useSessionDetail(selected);
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
    const pop = () => {
      const params = new URLSearchParams(location.search);
      setCreating(false);
      setSelected(params.get('session') || undefined);
      setTab(params.get('view') === 'usage' ? 'usage' : 'all');
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (tab === 'usage') params.set('view', 'usage');
    else params.delete('view');
    history.replaceState(null, '', location.pathname + (params.size ? '?' + params : ''));
  }, [tab]);
  const reconcile = () => {
    void loadOverview();
    void loadList(false, true);
  };
  const refreshDetail = () => {
    reconcile();
    if (selected && !navigatingOutline.current) void loadDetail(selected);
  };
  const connected = useRealtime(selected, refreshDetail, reconcile);
  const select = (id: string) => {
    setCreating(false);
    setSelected(id);
    setMenu(false);
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
    changeTab,
    title,
    rows,
  };
}
export type WorkspaceModel = ReturnType<typeof useWorkspace>;
