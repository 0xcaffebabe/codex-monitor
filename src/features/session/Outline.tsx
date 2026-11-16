import { ArrowUpRight, BookOpen, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { cx, date, number, time } from '../../shared/format';
import type { TimelineModel } from './useTimeline';
import type { DetailProps } from './useTimeline';

export function Outline({
  outlineData,
  outlineError,
  page,
  model,
}: Pick<DetailProps, 'outlineData' | 'outlineError' | 'page'> & {
  model: Pick<TimelineModel, 'outlineEntries' | 'activeEntry' | 'jumpingEntry' | 'jumpToEntry'>;
}) {
  const { outlineEntries, activeEntry, jumpingEntry, jumpToEntry } = model;
  const [previewId, setPreviewId] = useState('');
  const [previewTop, setPreviewTop] = useState(0);
  const railRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLButtonElement>(null);
  const keyboardPreview = useRef(false);
  const activeIndex = outlineEntries.findIndex((entry) => entry.id === activeEntry);
  const previewIndex = outlineEntries.findIndex((entry) => entry.id === previewId);
  const preview = outlineEntries[previewIndex];

  function positionPreview() {
    const rail = railRef.current;
    const popover = previewRef.current;
    const marker = listRef.current?.children[previewIndex];
    if (!rail || !popover || !marker) return;
    const reader = rail.closest('.timeline-reader')!.getBoundingClientRect();
    const anchor = marker.getBoundingClientRect();
    const height = popover.getBoundingClientRect().height;
    const top = Math.max(
      reader.top + 12,
      Math.min(anchor.y + anchor.height / 2 - height / 2, reader.bottom - height - 12),
    );
    setPreviewTop(top - rail.getBoundingClientRect().top);
  }
  useLayoutEffect(positionPreview, [preview, previewIndex]);

  useEffect(() => {
    if (!previewId) return;
    function dismiss(event: PointerEvent) {
      if (!railRef.current?.contains(event.target as Node)) setPreviewId('');
    }
    function closePreview() {
      setPreviewId('');
    }
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', closePreview);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', closePreview);
    };
  }, [previewId]);

  useEffect(() => {
    const list = listRef.current;
    const marker = list?.children[activeIndex] as HTMLElement | undefined;
    if (!list || !marker || previewId) return;
    if (marker.offsetTop < list.scrollTop) list.scrollTop = marker.offsetTop;
    else if (marker.offsetTop + marker.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = marker.offsetTop + marker.offsetHeight - list.clientHeight;
  }, [activeIndex, previewId]);

  function selectEntry(index: number) {
    setPreviewId('');
    void jumpToEntry(outlineEntries[index]);
  }

  return (
    <aside
      id="conversation-outline"
      className="outline"
      aria-label="对话目录"
      ref={railRef}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse' && !keyboardPreview.current) setPreviewId('');
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPreviewId('');
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && previewId) {
          event.preventDefault();
          event.stopPropagation();
          setPreviewId('');
        }
      }}
    >
      <div
        className="outline-list"
        ref={listRef}
        onScroll={() => {
          const marker = listRef.current?.children[previewIndex]?.getBoundingClientRect();
          const list = listRef.current?.getBoundingClientRect();
          if (marker && list && (marker.bottom <= list.top || marker.top >= list.bottom))
            setPreviewId('');
          else positionPreview();
        }}
      >
        {outlineEntries.map((entry, index) => {
          const distance = activeIndex < 0 ? 3 : Math.abs(index - activeIndex);
          return (
            <button
              key={entry.id}
              className={cx(
                'outline-entry',
                activeEntry === entry.id && 'active',
                previewId === entry.id && 'previewing',
              )}
              aria-label={`定位第 ${index + 1} 次提问`}
              aria-current={activeEntry === entry.id ? 'location' : undefined}
              aria-describedby={previewId === entry.id ? 'outline-preview' : undefined}
              disabled={!!jumpingEntry || !page}
              style={{ '--marker-width': `${Math.max(8, 26 - distance * 6)}px` } as CSSProperties}
              onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') {
                  keyboardPreview.current = false;
                  setPreviewId(entry.id);
                }
              }}
              onFocus={(event) => {
                if (event.currentTarget.matches(':focus-visible')) {
                  keyboardPreview.current = true;
                  setPreviewId(entry.id);
                }
              }}
              onKeyDown={(event) => {
                const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
                if (direction) {
                  event.preventDefault();
                  const next = (index + direction + outlineEntries.length) % outlineEntries.length;
                  keyboardPreview.current = true;
                  (listRef.current?.children[next] as HTMLElement)?.focus();
                  setPreviewId(outlineEntries[next].id);
                }
              }}
              onClick={(event) => {
                if (
                  event.detail > 0 &&
                  matchMedia('(hover: none)').matches &&
                  previewId !== entry.id
                )
                  setPreviewId(entry.id);
                else selectEntry(index);
              }}
            >
              {jumpingEntry === entry.id ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <span className="outline-marker" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
      {preview && (
        <button
          id="outline-preview"
          className="outline-popover"
          ref={previewRef}
          style={{ top: previewTop }}
          aria-label={`跳转到第 ${previewIndex + 1} 次提问`}
          disabled={!!jumpingEntry || !page}
          onClick={() => selectEntry(previewIndex)}
        >
          <span className="outline-popover-heading">
            <span className="outline-question">{preview.prompt || 'Codex'}</span>
            <ArrowUpRight size={15} aria-hidden="true" />
          </span>
          <span className="outline-preview">
            {preview.reply || (preview.status === 'running' ? '正在执行，等待回复…' : '暂无回复')}
          </span>
          <span className="outline-meta">
            <span>
              {preview.prompt ? '你' : 'Codex'} · {date(preview.timestamp)}{' '}
              {time(preview.timestamp)}
            </span>
            <span>{number(preview.tools)} 次调用</span>
          </span>
        </button>
      )}
      {outlineError ? (
        <span
          className="outline-notice"
          role="status"
          title="目录暂时不可用，请刷新重试"
          aria-label="目录暂时不可用，请刷新重试"
        >
          <TriangleAlert size={14} />
        </span>
      ) : !outlineEntries.length ? (
        <span
          className="outline-notice"
          role="status"
          title={outlineData ? '本会话尚无提问' : '正在读取对话目录…'}
          aria-label={outlineData ? '本会话尚无提问' : '正在读取对话目录…'}
        >
          {outlineData ? <BookOpen size={14} /> : <LoaderCircle size={14} className="spin" />}
        </span>
      ) : null}
    </aside>
  );
}
