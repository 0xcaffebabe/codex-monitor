import { BookOpen, Code2, LoaderCircle, X } from 'lucide-react';
import { cx, date, number, time } from '../../shared/format';
import type { TimelineModel } from './useTimeline';
import { DetailProps } from './useTimeline';

export function Outline({
  outlineData,
  outlineError,
  page,
  model,
}: Pick<DetailProps, 'outlineData' | 'outlineError' | 'page'> & {
  model: Pick<
    TimelineModel,
    'outlineEntries' | 'activeEntry' | 'jumpingEntry' | 'jumpToEntry' | 'setOutline'
  >;
}) {
  const { outlineEntries, activeEntry, jumpingEntry, jumpToEntry, setOutline } = model;
  return (
    <aside className="outline" aria-label="对话目录">
      <header className="outline-header">
        <strong>
          对话目录 <span>{outlineEntries.length}</span>
        </strong>
        <button className="icon-button" title="关闭目录" onClick={() => setOutline(false)}>
          <X size={15} />
        </button>
      </header>
      <div className="outline-list">
        {outlineError && <p className="outline-error">目录暂时不可用，可点击刷新重试。</p>}
        {outlineEntries.length ? (
          outlineEntries.map((entry, index) => (
            <button
              key={entry.id}
              className={cx('outline-entry', activeEntry === entry.id && 'active')}
              aria-label={`定位第 ${index + 1} 次提问`}
              disabled={!!jumpingEntry || !page}
              onClick={() => void jumpToEntry(entry)}
            >
              <span className="outline-time">
                {entry.prompt ? '你' : 'Codex'} · {date(entry.timestamp)} {time(entry.timestamp)}
              </span>
              {entry.prompt && <span className="outline-question">{entry.prompt}</span>}
              <span className="outline-answer">
                <span className="outline-avatar">
                  <Code2 size={14} />
                </span>
                <span className="outline-answer-body">
                  <span className="outline-steps">
                    {jumpingEntry === entry.id ? (
                      <>
                        <LoaderCircle size={11} className="spin" /> 正在定位…
                      </>
                    ) : (
                      <>
                        {number(entry.tools)} 次调用
                        <span className={cx('outline-status', entry.status)} />
                      </>
                    )}
                  </span>
                  <span className="outline-preview">
                    {entry.reply ||
                      (entry.status === 'running' ? '正在执行，等待回复…' : '暂无回复')}
                  </span>
                </span>
              </span>
            </button>
          ))
        ) : (
          <div className="outline-empty">
            <BookOpen size={20} />
            <p>{outlineData ? '本会话尚无提问' : '正在读取对话目录…'}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
