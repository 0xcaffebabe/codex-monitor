import { LoaderCircle, RefreshCw, Send } from 'lucide-react';
import { useMediaQuery } from '../../shared/useMediaQuery';
import { AttachmentPicker } from '../attachments/AttachmentPicker';
import { PromptFormProps, usePromptForm } from './usePromptForm';

export function PromptForm(props: PromptFormProps) {
  const isMobile = useMediaQuery('(max-width: 760px)');
  const {
    label,
    enabled,
    children,
    inputLabel = '发送给 Codex 的消息',
    submitOnEnter = false,
    maxLength = 12000,
    allowAttachments = false,
    attachmentControls,
    submitActions,
    allowGoal = false,
  } = props;
  const {
    draft,
    setDraft,
    busy,
    error,
    notice,
    queueState,
    uploadBusy,
    attachments,
    attachmentPicker,
    submit,
    check,
    cancelQueued,
    asGoal,
    setAsGoal,
    characterLimit,
    characterCount,
    validationError,
    canSubmit,
    retryGoal,
    openCreated,
    reset,
  } = usePromptForm(props);
  const submitLabel = asGoal ? '创建并执行目标' : label;
  const promptLabel = asGoal ? '目标内容' : inputLabel;
  const busyLabel = draft.creation ? '正在保存目标…' : '正在发送…';
  return (
    <form
      className={
        'prompt-form' +
        (allowAttachments ? ' accepts-attachments' : '') +
        (attachmentPicker.dragging ? ' is-file-dragging' : '') +
        (draft.requestId && (!busy || draft.queued) ? ' has-receipt' : '')
      }
      onDragEnter={allowAttachments ? attachmentPicker.dragEnter : undefined}
      onDragOver={allowAttachments ? attachmentPicker.dragOver : undefined}
      onDragLeave={allowAttachments ? attachmentPicker.dragLeave : undefined}
      onDrop={allowAttachments ? attachmentPicker.drop : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {attachmentPicker.dragging && (
        <div className="attachment-drop-hint" role="status">
          <span>松开即可添加图片或文件</span>
        </div>
      )}
      {children}
      {allowGoal && (
        <label className="new-session-goal-toggle">
          <input
            type="checkbox"
            checked={asGoal}
            disabled={busy || !!draft.requestId}
            onChange={(event) => setAsGoal(event.target.checked)}
          />
          将首条消息设为目标
        </label>
      )}
      <label className="prompt-label">
        {promptLabel === '发送给 Codex 的消息' ? '消息' : promptLabel}
        <textarea
          aria-label={promptLabel}
          placeholder={
            asGoal
              ? '输入本会话要完成的目标…'
              : allowAttachments && !isMobile
                ? '输入消息，可粘贴或拖入图片/文件…'
                : '输入消息…'
          }
          aria-keyshortcuts={
            submitOnEnter ? 'Enter Control+Enter Meta+Enter' : 'Control+Enter Meta+Enter'
          }
          title={submitOnEnter ? 'Enter 发送，Shift+Enter 换行' : undefined}
          value={draft.prompt}
          maxLength={
            asGoal
              ? characterLimit + (draft.prompt.trimStart().startsWith('/goal') ? 6 : 0)
              : maxLength
          }
          disabled={busy || !!draft.requestId}
          rows={3}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, prompt: event.target.value }))
          }
          onPaste={allowAttachments ? attachmentPicker.paste : undefined}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (submitOnEnter ? !event.shiftKey : event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </label>
      {allowAttachments && (
        <AttachmentPicker
          attachments={attachments}
          disabled={busy || !!draft.requestId || !enabled}
          picker={attachmentPicker}
        >
          {attachmentControls}
        </AttachmentPicker>
      )}
      {(error || validationError) && (
        <p className="control-error" role="alert">
          {error || validationError}
        </p>
      )}
      {notice && (
        <p className="control-notice" role="status">
          {notice}
        </p>
      )}
      <div className="prompt-actions">
        <span className="muted">
          {characterCount.toLocaleString()} / {characterLimit.toLocaleString()}
        </span>
        {draft.requestId && (!busy || draft.queued) ? (
          <>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void check()}
            >
              <RefreshCw size={14} />
              查询发送结果
            </button>
            {draft.creation && (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || draft.creation.state === 'pending'}
                  onClick={() => void retryGoal()}
                >
                  重试保存目标
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={openCreated}>
                  打开已创建会话
                </button>
              </>
            )}
            {draft.queued ? (
              <button
                type="button"
                className="secondary"
                disabled={busy || queueState === 'pending'}
                onClick={() => void cancelQueued()}
              >
                取消排队
              </button>
            ) : (
              <button type="button" className="secondary" onClick={reset}>
                已核对，编写新消息
              </button>
            )}
          </>
        ) : (
          <button
            type="submit"
            className="primary"
            aria-label={busy ? busyLabel : submitLabel}
            title={busy ? busyLabel : submitLabel}
            disabled={busy || uploadBusy || !canSubmit}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
            <span className="prompt-submit-label">{busy ? busyLabel : submitLabel}</span>
          </button>
        )}
        {submitActions}
      </div>
    </form>
  );
}
