import { BookOpen, ChevronRight, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../shared/format';
import type { OutlineProps } from './Outline';

export function MobileOutline({ outlineData, outlineError, page, model }: OutlineProps) {
  const { outlineEntries, activeEntry, jumpingEntry, jumpToEntry } = model;
  const [expanded, setExpanded] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const activeIndex = outlineEntries.findIndex((entry) => entry.id === activeEntry);

  function close() {
    restoreFocus.current = true;
    setExpanded(false);
  }

  useEffect(() => {
    if (expanded) closeRef.current?.focus({ preventScroll: true });
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      launcherRef.current?.focus({ preventScroll: true });
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    function keydown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [expanded]);

  useEffect(() => {
    const list = listRef.current;
    const entry = list?.children[activeIndex] as HTMLElement | undefined;
    if (!expanded || !list || !entry) return;
    if (entry.offsetTop < list.scrollTop) list.scrollTop = entry.offsetTop;
    else if (entry.offsetTop + entry.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = entry.offsetTop + entry.offsetHeight - list.clientHeight;
  }, [expanded, activeIndex]);

  return (
    <>
      <button
        className="icon-button mobile-outline-launcher"
        title="展开对话目录"
        aria-label="展开对话目录"
        aria-expanded={expanded}
        aria-controls={expanded ? 'conversation-outline' : undefined}
        ref={launcherRef}
        onClick={() => setExpanded(true)}
      >
        <BookOpen size={19} />
      </button>
      {expanded &&
        createPortal(
          <>
            <button className="mobile-outline-scrim" aria-label="关闭对话目录" onClick={close} />
            <aside id="conversation-outline" className="mobile-outline" aria-label="对话目录">
              <header className="mobile-outline-header">
                <strong>
                  <BookOpen size={15} />
                  对话目录<span>{outlineEntries.length}</span>
                </strong>
                <button className="icon-button" title="收起对话目录" ref={closeRef} onClick={close}>
                  <X size={17} />
                </button>
              </header>
              <div id="mobile-outline-list" className="mobile-outline-list" ref={listRef}>
                {outlineEntries.map((entry, index) => (
                  <button
                    key={entry.id}
                    className={cx('mobile-outline-entry', entry.id === activeEntry && 'active')}
                    aria-label={`定位第 ${index + 1} 次提问`}
                    aria-current={entry.id === activeEntry ? 'location' : undefined}
                    disabled={!!jumpingEntry || !page}
                    onClick={() => {
                      close();
                      void jumpToEntry(entry);
                    }}
                  >
                    <span className="mobile-outline-index" aria-hidden="true">
                      {jumpingEntry === entry.id ? (
                        <LoaderCircle size={12} className="spin" />
                      ) : (
                        String(index + 1).padStart(2, '0')
                      )}
                    </span>
                    <span className="mobile-outline-body">
                      <strong>{entry.prompt || 'Codex'}</strong>
                      <small>
                        {entry.reply ||
                          (entry.status === 'running' ? '正在执行，等待回复…' : '暂无回复')}
                      </small>
                    </span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                ))}
              </div>
              {(outlineError || !outlineEntries.length) && (
                <p className="mobile-outline-notice" role="status">
                  {outlineError ? (
                    <>
                      <TriangleAlert size={15} />
                      目录暂时不可用，请刷新重试
                    </>
                  ) : outlineData ? (
                    <>
                      <BookOpen size={15} />
                      本会话尚无提问
                    </>
                  ) : (
                    <>
                      <LoaderCircle size={15} className="spin" />
                      正在读取对话目录…
                    </>
                  )}
                </p>
              )}
            </aside>
          </>,
          document.body,
        )}
    </>
  );
}
