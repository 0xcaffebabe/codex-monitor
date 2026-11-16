import { X } from 'lucide-react';
import type { GitFile, GitStatus } from '../../git-types';
import type { User } from '../../types';
import { PromptForm } from '../control/PromptForm';
import { gitScopes, reviewPrompt } from './diff-model';
import { useGitReview } from './useGitReview';

export function GitReview({
  user,
  sessionId,
  status,
  file,
  onClose,
  onAccepted,
}: {
  user: User;
  sessionId: string;
  status: GitStatus;
  file?: GitFile;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const state = useGitReview(sessionId);
  return (
    <section className="git-review" aria-label="代码审查请求">
      <header>
        <div>
          <strong>{file ? '审查当前文件' : `审查${gitScopes[status.scope]}`}</strong>
          <p>发送后在当前会话中查看审查结果。可以补充关注点。</p>
        </div>
        <button className="icon-button" title="收起审查请求" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      {!state && <p role="status">正在检查会话状态…</p>}
      {state?.reason && (
        <p className="control-notice" role="status">
          {state.reason}
        </p>
      )}
      <PromptForm
        storageKey={`codex-monitor.git-review.${user.id}.${sessionId}.${status.root}.${status.scope}.${file?.path ?? ':all'}`}
        url={`/api/sessions/${sessionId}/messages`}
        label="发送审查请求"
        inputLabel="审查要求"
        enabled={!!state?.available}
        initialPrompt={reviewPrompt(status, file)}
        onAccepted={onAccepted}
      />
    </section>
  );
}
