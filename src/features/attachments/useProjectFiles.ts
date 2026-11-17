import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { ProjectFileListing } from '../../project-file-types';

type ListingState = { listing?: ProjectFileListing; loading: boolean; error?: string };

export function useProjectFiles(url: string) {
  const [directories, setDirectories] = useState(new Map<string, ListingState>());
  const [expanded, setExpanded] = useState(new Set(['']));
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<ListingState & { query: string }>({
    query: '',
    loading: false,
  });
  const [selected, setSelected] = useState(new Set<string>());
  const requests = useRef(new Map<string, AbortController>());
  const [revision, setRevision] = useState(0);

  async function load(directory: string) {
    requests.current.get(directory)?.abort();
    const controller = new AbortController();
    requests.current.set(directory, controller);
    setDirectories((previous) => new Map(previous).set(directory, { loading: true }));
    try {
      const listing = await api<ProjectFileListing>(
        `${url}?path=${encodeURIComponent(directory)}`,
        {
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted)
        setDirectories((previous) => new Map(previous).set(directory, { listing, loading: false }));
    } catch (error) {
      if (!controller.signal.aborted)
        setDirectories((previous) =>
          new Map(previous).set(directory, { loading: false, error: (error as Error).message }),
        );
    } finally {
      if (requests.current.get(directory) === controller) requests.current.delete(directory);
    }
  }

  useEffect(() => {
    void load('');
    const pending = requests.current;
    return () => {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, [url, revision]);

  const term = query.trim();
  useEffect(() => {
    if (!term) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearch({ query: term, loading: true });
      try {
        const listing = await api<ProjectFileListing>(`${url}?search=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setSearch({ query: term, listing, loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setSearch({ query: term, loading: false, error: (error as Error).message });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, url, revision]);

  function toggleDirectory(directory: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      return next;
    });
    if (!expanded.has(directory) && !directories.has(directory)) void load(directory);
  }
  function toggleFile(file: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }
  function refresh() {
    setDirectories(new Map());
    setExpanded(new Set(['']));
    setSearch({ query: '', loading: false });
    setRevision((previous) => previous + 1);
  }
  const visibleSearch: ListingState = term && search.query !== term ? { loading: true } : search;
  return {
    directories,
    expanded,
    query,
    setQuery,
    search: visibleSearch,
    searching: !!term,
    selected,
    toggleDirectory,
    toggleFile,
    clearSelection: () => setSelected(new Set()),
    load,
    refresh,
  };
}
