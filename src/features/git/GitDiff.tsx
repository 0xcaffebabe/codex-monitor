import { useLayoutEffect, useRef } from 'react';
import {
  Check,
  CheckCheck,
  FileCode2,
  FileDiff,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import type { Session, User } from '../../types';
import type { GitScope } from '../../git-types';
import { cx } from '../../shared/format';
import { gitFileStatuses, gitScopes } from './diff-model';
import { useGitDiff } from './useGitDiff';
import { GitReview } from './GitReview';

export default function GitDiff({
  session,
  user,
  onClose,
  onReviewSent,
}: {
  session: Session;
  user: User;
  onClose: () => void;
  onReviewSent: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const model = useGitDiff(session.id);
  const diffScroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    diffScroll.current?.scrollTo(0, 0);
  }, [model.selected, model.scope]);
  const canReview = user.role === 'admin' && !session.archived;
  const loaded = !!model.diff && !model.diffLoading;
  return (
    <dialog
      ref={dialog}
      className="git-diff-dialog"
      aria-labelledby="git-diff-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="git-diff-header">
        <FileDiff size={21} />
        <div>
          <h2 id="git-diff-heading">代码变更</h2>
          <p title={model.status?.root || session.cwd}>{model.status?.root || session.cwd}</p>
        </div>
        <button
          className="icon-button"
          title="刷新代码变更"
          disabled={model.loading}
          onClick={model.refresh}
        >
          <RefreshCw size={17} className={model.loading ? 'spin' : ''} />
        </button>
        <button className="icon-button" title="关闭代码变更" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="git-diff-toolbar">
        <div className="git-diff-scopes" role="group" aria-label="变更范围">
          {(Object.keys(gitScopes) as GitScope[]).map((scope) => (
            <button
              key={scope}
              aria-pressed={model.scope === scope}
              onClick={() => model.setScope(scope)}
            >
              {gitScopes[scope]}
            </button>
          ))}
        </div>
        {model.status && (
          <span className="git-diff-branch" title={model.status.branch}>
            <GitBranch size={13} />
            {model.status.branch}
            {!model.status.head && <small>尚无提交</small>}
          </span>
        )}
        {canReview && (
          <button
            className="secondary git-review-trigger"
            disabled={!model.status?.files.length || model.loading}
            onClick={() => model.setReviewTarget(model.reviewTarget ? null : 'all')}
          >
            <Sparkles size={14} />
            <span>让 Codex 审查</span>
          </button>
        )}
      </div>
      {model.error ? (
        <div className="git-diff-empty" role="alert">
          <FileDiff size={30} />
          <p>{model.error}</p>
          <button className="secondary" onClick={model.refresh}>
            重试
          </button>
        </div>
      ) : model.loading ? (
        <div className="git-diff-empty" role="status">
          <LoaderCircle size={25} className="spin" />
          <p>正在读取项目变更…</p>
        </div>
      ) : !model.status?.files.length ? (
        <div className="git-diff-empty" role="status">
          <CheckCheck size={32} />
          <strong>
            {model.scope === 'all' ? '当前没有代码变更' : `没有${gitScopes[model.scope]}的变更`}
          </strong>
          <p>修改文件后，可刷新查看最新变更。</p>
        </div>
      ) : (
        <>
          {model.reviewTarget && model.status && (
            <GitReview
              key={`${model.scope}:${model.reviewTarget === 'file' ? model.selected : ':all'}`}
              user={user}
              sessionId={session.id}
              status={model.status}
              file={model.reviewTarget === 'file' ? model.file : undefined}
              onClose={() => model.setReviewTarget(null)}
              onAccepted={onReviewSent}
            />
          )}
          <div className="git-diff-body">
            <aside className="git-diff-files" aria-label="变更文件">
              <div className="git-files-heading">
                <strong>{model.status.files.length} 个文件</strong>
                <span>已读 {model.reviewed.size}</span>
              </div>
              <label className="git-file-search">
                <Search size={13} />
                <input
                  aria-label="筛选变更文件"
                  placeholder="筛选文件…"
                  value={model.query}
                  onChange={(event) => model.setQuery(event.target.value)}
                />
              </label>
              <div className="git-file-list">
                {model.files.map((file) => (
                  <button
                    key={file.path}
                    className={cx('git-file', file.path === model.selected && 'selected')}
                    aria-label={`查看变更：${file.path}`}
                    aria-current={file.path === model.selected ? 'true' : undefined}
                    onClick={() => model.select(file.path)}
                    title={file.path}
                  >
                    {model.reviewed.has(file.path) ? (
                      <Check size={14} className="git-file-read" />
                    ) : (
                      <FileCode2 size={14} />
                    )}
                    <span className="git-file-name">{file.path}</span>
                    <span
                      className={`git-file-status ${file.status}`}
                      title={gitFileStatuses[file.status]}
                    >
                      {file.status === 'untracked'
                        ? '?'
                        : file.status === 'conflicted'
                          ? '!'
                          : file.status[0].toUpperCase()}
                    </span>
                    <span className="git-file-counts">
                      {file.additions !== null && (
                        <span className="git-added">+{file.additions}</span>
                      )}
                      {file.deletions !== null && (
                        <span className="git-deleted">−{file.deletions}</span>
                      )}
                    </span>
                  </button>
                ))}
                {!model.files.length && <p className="git-files-no-match">没有匹配的文件</p>}
              </div>
            </aside>
            <section
              className="git-file-content"
              aria-label="文件差异"
              aria-busy={model.diffLoading}
            >
              {model.file && (
                <header className="git-file-heading">
                  <div>
                    <strong title={model.file.path}>{model.file.path}</strong>
                    <span>
                      {gitFileStatuses[model.file.status]}
                      {model.file.previousPath && ` · 原路径：${model.file.previousPath}`}
                    </span>
                  </div>
                  <label className="git-reviewed-toggle">
                    <input
                      type="checkbox"
                      checked={model.reviewed.has(model.selected)}
                      disabled={!loaded || !!model.diff?.truncated}
                      onChange={model.toggleReviewed}
                    />
                    已读
                  </label>
                  {canReview && (
                    <button
                      className="icon-button"
                      title="审查当前文件"
                      disabled={!loaded}
                      onClick={() => model.setReviewTarget('file')}
                    >
                      <Sparkles size={16} />
                    </button>
                  )}
                </header>
              )}
              {model.diffError ? (
                <div className="git-diff-empty" role="alert">
                  <p>{model.diffError}</p>
                  <button className="secondary" onClick={model.retryDiff}>
                    重试读取
                  </button>
                </div>
              ) : model.diffLoading ? (
                <div className="git-diff-empty" role="status">
                  <LoaderCircle size={23} className="spin" />
                  <p>正在读取 diff…</p>
                </div>
              ) : model.diff?.binary ? (
                <div className="git-diff-empty">
                  <FileCode2 size={30} />
                  <p>二进制文件发生变更，无法显示文本 diff。</p>
                </div>
              ) : (
                <div
                  className="git-patch-scroll"
                  ref={diffScroll}
                  tabIndex={0}
                  aria-label="代码 diff"
                >
                  {model.lines.length ? (
                    <table className="git-patch" aria-label="逐行代码差异">
                      <tbody>
                        {model.lines.map((line, index) => (
                          <tr key={index} className={`git-line ${line.kind}`}>
                            <td className="git-line-number">{line.oldLine}</td>
                            <td className="git-line-number">{line.newLine}</td>
                            <td className="git-line-sign" aria-hidden="true">
                              {line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ''}
                            </td>
                            <td className="git-line-code">
                              <code>{line.text || ' '}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="git-diff-empty">
                      <p>没有可显示的文本差异；文件可能仅变更了权限，或变更已更新。</p>
                    </div>
                  )}
                </div>
              )}
              {model.diff?.truncated && (
                <div className="git-diff-truncated" role="status">
                  文件较大，仅显示部分 diff。完整内容请在项目中查看。
                </div>
              )}
            </section>
          </div>
        </>
      )}
      <footer className="git-diff-footer">
        <span>当前项目的未提交变更</span>
        <span>刷新后重新标记已读</span>
      </footer>
    </dialog>
  );
}
