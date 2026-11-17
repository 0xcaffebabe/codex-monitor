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
  const [focused, setFocused] = useState(false);
  const focusMode = desktop && !!selected && focused;
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
    if (!selected || !desktop) setFocused(false);
  }, [selected, desktop]);
  useEffect(() => {
    let frame = 0;
    const keydown = (event: KeyboardEvent) => {
      if (!desktop || !selected || event.isComposing) return;
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) setFocused(false);
      const target = event.target as HTMLElement;
      if (
        event.key !== '/' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')
      )
        return;
      event.preventDefault();
      setFocused(false);
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
    sessionDrawerOpen: desktop && !wide && sessionsVisible && !focusMode,
    focusMode,
    toggleFocus: () => setFocused((previous) => !previous),
    closeSessionDrawer: () => setDrawerOpen(false),
    toggleNavigation: () => {
      setFocused(false);
      setPreferences((previous) => ({
        ...previous,
        navigationCollapsed: focusMode ? false : !navigationCollapsed,
      }));
    },
    toggleSessions: () => {
      setFocused(false);
      if (wide)
        setPreferences((previous) => ({
          ...previous,
          sessionsVisible: focusMode || !sessionsVisible,
        }));
      else setDrawerOpen((previous) => focusMode || !previous);
    },
    reset: () => {
      setPreferences({});
      setFocused(false);
      setDrawerOpen(false);
    },
  };
}
