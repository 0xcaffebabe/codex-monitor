import { ChevronDown, GitBranch, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Session } from '../../types';
import { useGitBranches } from './useGitBranches';

export function GitBranchSelector({ session }: { session: Session }) {
  const model = useGitBranches(session.id);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="session-branch-trigger"
        aria-label="选择 Git 分支"
        aria-haspopup="dialog"
        title={
          model.data
            ? `当前分支：${model.data.branch}${model.data.detached ? '（分离 HEAD）' : ''}`
            : model.error || '正在读取 Git 分支'
        }
        onClick={() => {
          setOpen(true);
          void model.refresh();
        }}
      >
        {model.loading && !model.data ? (
          <LoaderCircle size={12} className="spin" />
        ) : (
          <GitBranch size={12} />
        )}
        <span>{model.data?.branch || (model.error ? 'Git 不可用' : '读取分支…')}</span>
        <ChevronDown size={12} />
      </button>
      {open && <BranchDialog session={session} model={model} onClose={() => setOpen(false)} />}
    </>
  );
}

function BranchDialog({
  session,
  model,
  onClose,
}: {
  session: Session;
  model: ReturnType<typeof useGitBranches>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [selected, setSelected] = useState('');
  const data = model.data;
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    setSelected(data && !data.detached ? data.branch : '');
  }, [data?.branch, data?.detached]);
  const target = data?.branches.find((branch) => branch.name === selected);
  const busy = model.loading || model.switching;
  const canSwitch = target && !target.current && !target.worktree && !busy;
  return (
    <dialog
      ref={dialog}
      className="git-branch-dialog"
      aria-labelledby="git-branch-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!model.switching) onClose();
      }}
    >
      <header className="git-branch-header">
        <GitBranch size={20} />
        <div>
          <h2 id="git-branch-heading">切换 Git 分支</h2>
          <p title={data?.root || session.cwd}>{data?.root || session.cwd}</p>
        </div>
        <button
          className="icon-button"
          title="刷新 Git 分支"
          disabled={busy}
          onClick={() => void model.refresh()}
        >
          <RefreshCw size={16} className={model.loading ? 'spin' : ''} />
        </button>
        <button
          className="icon-button"
          title="关闭分支切换"
          disabled={model.switching}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      <div className="git-branch-body">
        {model.error ? (
          <div className="git-branch-error" role="alert">
            <p>{model.error}</p>
            <button className="secondary" disabled={busy} onClick={() => void model.refresh()}>
              重试
            </button>
          </div>
        ) : !data ? (
          <p className="git-branch-loading" role="status">
            <LoaderCircle size={16} className="spin" /> 正在读取项目分支…
          </p>
        ) : (
          <>
            <p className="git-branch-current">
              当前分支 <strong>{data.branch}</strong>
              {data.detached && <small>分离 HEAD</small>}
              {!data.head && <small>尚无提交</small>}
            </p>
            <label className="git-branch-select">
              <span>目标分支</span>
              <select
                aria-label="目标分支"
                value={selected}
                disabled={busy || !data.branches.length}
                onChange={(event) => setSelected(event.target.value)}
              >
                {!data.branches.some((branch) => branch.name === selected) && (
                  <option value="">选择本地分支</option>
                )}
                {data.branches.map((branch) => (
                  <option
                    key={branch.name}
                    value={branch.name}
                    disabled={!!branch.worktree && !branch.current}
                  >
                    {branch.name}
                    {branch.current ? '（当前）' : branch.worktree ? '（其他工作区使用中）' : ''}
                  </option>
                ))}
              </select>
            </label>
            {!data.branches.length && (
              <p className="muted">暂无可切换的本地分支，请先在项目中创建分支。</p>
            )}
            <p className="git-branch-hint">
              切换会作用于此项目目录，使用同一目录的其他会话也会受影响。未提交的改动若与目标分支冲突，Git
              会阻止切换。
            </p>
          </>
        )}
        {model.switchError && (
          <p className="git-branch-error" role="alert">
            {model.switchError}
          </p>
        )}
      </div>
      <footer className="git-branch-footer">
        <button className="secondary" disabled={model.switching} onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={!canSwitch}
          onClick={async () => {
            if (await model.switchBranch(selected)) onClose();
          }}
        >
          {model.switching ? <LoaderCircle size={14} className="spin" /> : <GitBranch size={14} />}
          {model.switching ? '正在切换…' : '切换分支'}
        </button>
      </footer>
    </dialog>
  );
}
