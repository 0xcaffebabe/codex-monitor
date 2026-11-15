import { LoaderCircle, RefreshCw } from 'lucide-react';
import { CommandButtonProps, useCommand } from './useCommand';

export function CommandButton(props: CommandButtonProps) {
  const {
    command,
    label,
    disabled,
    children,
    iconOnly = false,
    onFeedback,
    className = '',
  } = props;
  const { requestId, busy, message, run, reset } = useCommand(props);
  return (
    <div
      className={
        'command-action' + (iconOnly ? ' compact-command' : '') + (className ? ` ${className}` : '')
      }
    >
      <button
        type="button"
        className={iconOnly ? 'icon-button' : 'secondary'}
        disabled={busy || (!requestId && disabled)}
        aria-label={requestId && !busy ? `查询${label}结果` : label}
        title={
          command === 'compact' && disabled
            ? '本轮结束后可压缩上下文'
            : requestId && !busy
              ? `查询${label}结果`
              : label
        }
        aria-busy={busy}
        onClick={() => void run()}
      >
        {busy ? (
          <LoaderCircle size={13} className="spin" />
        ) : iconOnly && requestId ? (
          <RefreshCw size={15} />
        ) : (
          children
        )}
        {!iconOnly && (busy ? '处理中…' : requestId ? `查询${label}结果` : label)}
      </button>
      {message && !onFeedback && (
        <p className="control-hint" role="status">
          {message}
        </p>
      )}
      {requestId && !busy && (
        <button className="secondary command-reset" type="button" onClick={reset}>
          已核对，重置操作
        </button>
      )}
    </div>
  );
}
