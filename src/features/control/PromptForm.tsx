import { LoaderCircle, Monitor, RefreshCw, Send, SlidersHorizontal } from 'lucide-react';
import { useRef } from 'react';
import { Popover } from '../../shared/ui/Popover';
import { useMediaQuery } from '../../shared/useMediaQuery';
import { AttachmentPicker } from '../attachments/AttachmentPicker';
import { ProjectFilePicker } from '../attachments/ProjectFilePicker';
import { PromptFormProps, usePromptForm } from './usePromptForm';
import { PromptShortcuts } from './PromptShortcuts';

export function PromptForm(props: PromptFormProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const isMobile = useMediaQuery('(max-width: 760px)');
  const {
    label,
    enabled,
    children,
    inputLabel = '发送给 Codex 的消息',
    autoFocus = false,
    submitOnEnter = false,
    maxLength = 12000,
    allowAttachments = false,
    projectFilesUrl,
    attachmentControls,
    modelSummary,
    submitActions,
    allowGoal = false,
    allowDesktopChannel = false,
    promptShortcuts,
    shortcutActions,
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
    insertProjectFiles,
    submit,
    submitPresetPrompt,
    check,
    cancelQueued,
    asGoal,
    setAsGoal,
    characterLimit,
    characterCount,
    validationError,
    canSubmit,
    canSubmitPreset,
    retryGoal,
    openCreated,
    reset,
  } = usePromptForm(props);
  const submitLabel = asGoal ? '创建并执行目标' : label;
  const promptLabel = asGoal ? '目标内容' : inputLabel;
  const busyLabel = draft.creation ? '正在保存目标…' : '正在发送…';
  const enterSends = submitOnEnter && !isMobile;
  const sendSettings = [draft.desktopChannel && '桌面通道', modelSummary]
    .filter(Boolean)
    .join(' · ');
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
      {!allowAttachments && children}
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
          ref={input}
          aria-label={promptLabel}
          autoFocus={autoFocus && !isMobile}
          placeholder={
            asGoal
              ? '输入本会话要完成的目标…'
              : allowAttachments && !isMobile
                ? '输入消息，可粘贴或拖入图片/文件…'
                : '输入消息…'
          }
          aria-keyshortcuts={
            enterSends ? 'Enter Control+Enter Meta+Enter' : 'Control+Enter Meta+Enter'
          }
          title={enterSends ? 'Enter 发送，Shift+Enter 换行' : undefined}
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
              (enterSends ? !event.shiftKey : event.ctrlKey || event.metaKey) &&
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
          {projectFilesUrl && (
            <ProjectFilePicker
              key={projectFilesUrl}
              url={projectFilesUrl}
              disabled={busy || !!draft.requestId || !enabled}
              onInsert={insertProjectFiles}
            />
          )}
          {(!!promptShortcuts?.length || !!shortcutActions?.length) && (
            <PromptShortcuts
              shortcuts={promptShortcuts ?? []}
              actions={shortcutActions}
              disabled={busy || uploadBusy || !!draft.requestId || !enabled}
              canSubmit={canSubmitPreset}
              allowDesktopChannel={allowDesktopChannel}
              onSend={(shortcut) => void submitPresetPrompt(shortcut)}
              onInsert={(shortcut) => {
                setDraft((previous) => ({
                  ...previous,
                  prompt: shortcut.prompt,
                  desktopChannel: shortcut.channel === 'desktop' || previous.desktopChannel,
                }));
                input.current?.focus();
              }}
            />
          )}
          {(attachmentControls || allowDesktopChannel || draft.desktopChannel) && (
            <Popover
              label="发送设置"
              displayLabel={sendSettings || undefined}
              icon={draft.desktopChannel ? <Monitor size={15} /> : <SlidersHorizontal size={15} />}
              active={!!sendSettings}
              className="composer-settings-trigger"
            >
              {() => (
                <div className="composer-settings">
                  <section>
                    <h3>模型与思考</h3>
                    {attachmentControls || (
                      <p className="composer-menu-hint">沿用当前会话的模型与思考设置。</p>
                    )}
                  </section>
                  {(allowDesktopChannel || draft.desktopChannel) && (
                    <section>
                      <h3>发送通道</h3>
                      <label className="composer-desktop-channel">
                        <input
                          type="checkbox"
                          aria-label="桌面通道"
                          checked={!!draft.desktopChannel}
                          disabled={busy || !!draft.requestId || !enabled}
                          onChange={(event) =>
                            setDraft((previous) => ({
                              ...previous,
                              desktopChannel: event.target.checked,
                            }))
                          }
                        />
                        <span>
                          <strong>桌面通道</strong>
                          <small>通过 Codex 桌面应用发送，支持执行中追加。</small>
                        </span>
                      </label>
                    </section>
                  )}
                </div>
              )}
            </Popover>
          )}
          {children}
        </AttachmentPicker>
      )}
      <div className="prompt-actions">
        <span
          className={
            'muted prompt-count' + (characterCount > characterLimit * 0.8 ? ' near-limit' : '')
          }
        >
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
    </form>
  );
}
