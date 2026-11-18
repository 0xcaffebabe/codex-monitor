import { useEffect } from 'react';

export function useScreenWakeLock(enabled: boolean) {
  useEffect(() => {
    // iPadOS can use a desktop Safari user agent, including in landscape.
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (!enabled || !ios || !window.isSecureContext) return;
    const wakeLock = navigator.wakeLock;
    if (!wakeLock?.request) return;

    let disposed = false;
    let pageShown = true;
    let generation = 0;
    let pendingGeneration: number | undefined;
    let requestAfterPending = false;
    let held: WakeLockSentinel | undefined;
    const visible = () => !disposed && pageShown && document.visibilityState === 'visible';
    const release = (lock: WakeLockSentinel) => {
      void lock.release().catch(() => {});
    };
    const suspend = () => {
      generation++;
      const lock = held;
      held = undefined;
      if (lock) release(lock);
    };
    const request = async () => {
      if (!visible() || held) return;
      if (pendingGeneration !== undefined) {
        if (pendingGeneration !== generation) requestAfterPending = true;
        return;
      }
      const requestedGeneration = generation;
      pendingGeneration = requestedGeneration;
      try {
        const lock = await wakeLock.request('screen');
        // Requests cannot be aborted. Release late results after leaving or hiding the page.
        if (!visible() || requestedGeneration !== generation) {
          release(lock);
          return;
        }
        if (lock.released) return;
        held = lock;
        lock.addEventListener(
          'release',
          () => {
            if (held !== lock) return;
            held = undefined;
          },
          { once: true },
        );
      } catch {
      } finally {
        pendingGeneration = undefined;
        if (requestAfterPending) {
          requestAfterPending = false;
          void request();
        }
      }
    };
    const resume = () => void request();
    const visibilityChanged = () => {
      if (document.visibilityState === 'visible') resume();
      else suspend();
    };
    const pageHidden = () => {
      pageShown = false;
      suspend();
    };
    const pageRestored = () => {
      pageShown = true;
      resume();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('pagehide', pageHidden);
    window.addEventListener('pageshow', pageRestored);
    // Retry after a system refusal or release on the next interaction, without a polling loop.
    document.addEventListener('pointerdown', resume, { capture: true, passive: true });
    document.addEventListener('keydown', resume, true);
    resume();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('pagehide', pageHidden);
      window.removeEventListener('pageshow', pageRestored);
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      suspend();
    };
  }, [enabled]);
}
