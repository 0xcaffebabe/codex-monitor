import { useLayoutEffect, useRef } from 'react';
import { Eraser, LoaderCircle, RotateCcw, Square, TerminalSquare, X } from 'lucide-react';
import type { Session } from '../../types';
import { useProjectTerminal } from './useProjectTerminal';
import '@xterm/xterm/css/xterm.css';

export default function ProjectTerminal({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const model = useProjectTerminal(session.id);
  const active = model.status === 'ready';
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="project-terminal-dialog"
      aria-labelledby="project-terminal-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="project-terminal-header">
        <TerminalSquare size={20} />
        <div>
          <h2 id="project-terminal-heading">项目终端</h2>
          <p title={model.info?.cwd || session.cwd}>{model.info?.cwd || session.cwd}</p>
        </div>
        <button
          className="icon-button"
          title="清空终端显示"
          disabled={!active}
          onClick={model.clear}
        >
          <Eraser size={17} />
        </button>
        <button className="icon-button" title="关闭项目终端" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="project-terminal-status" role="status">
        {model.status === 'opening' ? (
          <>
            <LoaderCircle size={13} className="spin" />
            正在启动终端…
          </>
        ) : model.status === 'ready' ? (
          `${model.info?.shell} · 已连接`
        ) : model.status === 'exited' ? (
          `进程已退出 · 退出码 ${model.info?.exitCode}`
        ) : (
          '终端连接中断'
        )}
        <span>关闭窗口将结束此终端</span>
      </div>
      {model.error && (
        <div className="alert error" role="alert">
          {model.error}
        </div>
      )}
      <div
        className="project-terminal-screen"
        ref={model.host}
        aria-label="终端输入和输出"
        onClick={model.focus}
      />
      <footer className="project-terminal-footer">
        <button type="button" disabled={!active} onClick={() => model.send('\x03')}>
          <Square size={13} />
          中断命令 <kbd>Ctrl+C</kbd>
        </button>
        {(model.status === 'error' || model.status === 'exited') && (
          <button type="button" onClick={model.restart}>
            <RotateCcw size={14} />
            重新打开
          </button>
        )}
      </footer>
    </dialog>
  );
}
