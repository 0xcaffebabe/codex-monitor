import { useEffect, useState, type RefObject } from 'react';
import { useMediaQuery } from '../../shared/useMediaQuery';

type Preferences = { navigationCollapsed?: boolean; sessionsVisible?: boolean };
const storageKey = 'codex-monitor.desktop-layout.v1';

function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return {
      navigationCollapsed:
        typeof saved?.navigationCollapsed === 'boolean' ? saved.navigationCollapsed : undefined,
      sessionsVisible:
        typeof saved?.sessionsVisible === 'boolean' ? saved.sessionsVisible : undefined,
    };
  } catch {
    return {};
  }
}

export function useDesktopLayout(
  selected: string | undefined,
  searchRef: RefObject<HTMLInputElement | null>,
) {
  const desktop = useMediaQuery('(min-width: 761px)');
  const wide = useMediaQuery('(min-width: 1280px)');
  const [preferences, setPreferences] = useState(readPreferences);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigationCollapsed = desktop && (preferences.navigationCollapsed ?? (!!selected || !wide));
  const sessionsVisible = !desktop || (wide ? (preferences.sessionsVisible ?? true) : drawerOpen);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      // Layout controls still work when browser storage is unavailable.
    }
  }, [preferences]);
  useEffect(() => setDrawerOpen(false), [selected, wide, desktop]);
  useEffect(() => {
    let frame = 0;
    const keydown = (event: KeyboardEvent) => {
      if (!desktop || !selected || event.isComposing) return;
      const target = event.target as HTMLElement;
      if (
        event.key !== '/' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target.closest('input, textarea, select, [contenteditable="true"], dialog, [role="dialog"]')
      )
        return;
      event.preventDefault();
      if (wide) setPreferences((previous) => ({ ...previous, sessionsVisible: true }));
      else setDrawerOpen(true);
      frame = requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('keydown', keydown);
      cancelAnimationFrame(frame);
    };
  }, [desktop, selected, wide, searchRef]);

  return {
    navigationCollapsed,
    sessionsVisible,
    sessionDrawerOpen: desktop && !wide && sessionsVisible,
    closeSessionDrawer: () => setDrawerOpen(false),
    toggleNavigation: () => {
      setPreferences((previous) => ({
        ...previous,
        navigationCollapsed: !navigationCollapsed,
      }));
    },
    toggleSessions: () => {
      if (wide)
        setPreferences((previous) => ({
          ...previous,
          sessionsVisible: !sessionsVisible,
        }));
      else setDrawerOpen((previous) => !previous);
    },
    reset: () => {
      setPreferences({});
      setDrawerOpen(false);
    },
  };
}
