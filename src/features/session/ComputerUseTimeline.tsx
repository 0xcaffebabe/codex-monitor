import { useEffect, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  LoaderCircle,
  Monitor,
  RefreshCw,
  X,
} from 'lucide-react';
import { cx } from '../../shared/format';
import type { Session } from '../../types';
import { SessionImage } from './SessionImage';
import { useComputerUse } from './useComputerUse';

const stamp = (value: number) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(value)
    : '时间未知';
const status = (value: string) =>
  ['inProgress', 'in_progress', 'running'].includes(value)
    ? '执行中'
    : value === 'failed'
      ? '失败'
      : value === 'interrupted'
        ? '已中断'
        : '已完成';

export function ComputerUseTimeline({
  session,
  revision,
  onClose,
}: {
  session: Session;
  revision: string;
  onClose: () => void;
}) {
  const model = useComputerUse(session.id, revision);
  const { page, selected, selectedId, imageIndex, busy, error, position } = model;
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const selectedButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    selectedButton.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);
  return (
    <dialog
      ref={dialog}
      className="computer-use-dialog"
      aria-labelledby="computer-use-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!dialog.current?.querySelector('.image-lightbox')) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="computer-use-header">
        <Monitor size={20} />
        <div>
          <h2 id="computer-use-heading">Computer Use 时间线</h2>
          <p title={session.title}>{session.title}</p>
        </div>
        <button
          className="icon-button"
          title="刷新操作时间线"
          disabled={busy}
          onClick={model.refresh}
        >
          <RefreshCw size={17} className={busy ? 'spin' : ''} />
        </button>
        <button className="icon-button" title="关闭操作时间线" autoFocus onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={model.refresh}>重试</button>
        </div>
      )}
      {page?.warnings.map((warning) => (
        <div className="alert warning" key={warning}>
          {warning}
        </div>
      ))}
      {!page ? (
        <div className="computer-use-empty">
          {error ? <Monitor size={24} /> : <LoaderCircle className="spin" size={24} />}
          <span>{error ? '暂时无法读取操作记录' : '正在读取操作记录…'}</span>
        </div>
      ) : !page.steps.length ? (
        <div className="computer-use-empty">
          <Monitor size={30} />
          <span>暂未记录 Computer Use 操作</span>
        </div>
      ) : (
        <div className="computer-use-layout">
          <nav className="computer-use-steps" aria-label="Computer Use 操作步骤">
            <div className="computer-use-count">{page.total} 个操作 · 按时间排列</div>
            {page.before !== null && (
              <button className="computer-use-older" disabled={busy} onClick={model.older}>
                {busy ? '读取中…' : '加载更早操作'}
              </button>
            )}
            <ol>
              {page.steps.map((step, index) => (
                <li key={step.id}>
                  <button
                    ref={step.id === selectedId ? selectedButton : undefined}
                    className={cx('computer-use-step', step.id === selectedId && 'active')}
                    aria-current={step.id === selectedId ? 'step' : undefined}
                    onClick={() => model.select(step.id)}
                  >
                    <span className="computer-use-step-number">
                      {page.total - page.steps.length + index + 1}
                    </span>
                    <span className="computer-use-step-content">
                      <time
                        dateTime={
                          step.timestamp ? new Date(step.timestamp).toISOString() : undefined
                        }
                      >
                        {stamp(step.timestamp)}
                      </time>
                      <strong>{step.title}</strong>
                      <small>
                        {status(step.status)} ·{' '}
                        {step.screenshots ? `${step.screenshots} 张截图` : '未记录截图'}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <section className="computer-use-preview" aria-label="操作截图">
            {selected && (
              <>
                <div className="computer-use-selection">
                  <div>
                    <h3>{selected.title}</h3>
                    <p>
                      {stamp(selected.timestamp)} · {status(selected.status)}
                      {selected.durationMs !== undefined
                        ? ` · ${(selected.durationMs / 1000).toFixed(1)} 秒`
                        : ''}
                    </p>
                  </div>
                  <div className="computer-use-navigation">
                    <button
                      className="icon-button"
                      title="上一个操作"
                      disabled={position <= 0}
                      onClick={() => model.move(-1)}
                    >
                      <ChevronLeft size={19} />
                    </button>
                    <span>
                      {page.total - page.steps.length + position + 1} / {page.total}
                    </span>
                    <button
                      className="icon-button"
                      title="下一个操作"
                      disabled={position >= page.steps.length - 1}
                      onClick={() => model.move(1)}
                    >
                      <ChevronRight size={19} />
                    </button>
                  </div>
                </div>
                {(selected.pageTitle || selected.url) && (
                  <div className="computer-use-page">
                    <span>{selected.pageTitle}</span>
                    <span title={selected.url}>{selected.url}</span>
                  </div>
                )}
                {selected.screenshots > 1 && (
                  <div className="computer-use-image-tabs" role="group" aria-label="此操作的截图">
                    {Array.from({ length: selected.screenshots }, (_, index) => (
                      <button
                        key={index}
                        aria-pressed={imageIndex === index}
                        onClick={() => model.setImageIndex(index)}
                      >
                        截图 {index + 1}
                      </button>
                    ))}
                  </div>
                )}
                {selected.screenshots ? (
                  <div className="computer-use-screenshot">
                    <SessionImage
                      key={`${selected.id}-${Math.min(imageIndex, selected.screenshots - 1)}`}
                      sessionId={session.id}
                      image={{
                        id: selected.id,
                        name: `${selected.title} · 截图 ${Math.min(imageIndex, selected.screenshots - 1) + 1}`,
                        index: Math.min(imageIndex, selected.screenshots - 1),
                        source: 'computer-use',
                      }}
                      portalTarget={dialog.current ?? undefined}
                    />
                  </div>
                ) : (
                  <div className="computer-use-empty">
                    <ImageOff size={30} />
                    <span>这一步未记录完整截图</span>
                    <small>可以选择相邻操作查看画面</small>
                  </div>
                )}
                {selected.text && (
                  <details className="computer-use-text" key={selected.id}>
                    <summary>查看页面文字</summary>
                    <pre>{selected.text}</pre>
                  </details>
                )}
              </>
            )}
          </section>
        </div>
      )}
      <footer className="computer-use-footer">操作与截图随会话更新 · 仅显示已记录的画面</footer>
    </dialog>
  );
}
