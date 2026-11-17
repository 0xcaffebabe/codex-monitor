import { LoaderCircle, MessageSquareQuote, Paperclip, Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Popover } from '../../shared/ui/Popover';
import { maxAttachments, sizeLabel } from './attachment-model';
import { Thumbnail } from './Thumbnail';
import type { Attachment } from './types';
import type { useAttachmentPicker } from './useAttachmentPicker';
import { SessionReferenceDialog } from './SessionReferenceDialog';

export function AttachmentPicker({
  attachments,
  disabled,
  picker,
  children,
}: {
  attachments: Attachment[];
  disabled: boolean;
  picker: ReturnType<typeof useAttachmentPicker>;
  children?: ReactNode;
}) {
  const { input, progress, upload, remove } = picker;
  const [referencing, setReferencing] = useState(false);
  return (
    <div className="attachment-picker">
      <div className={'attachment-toolbar' + (children ? ' has-controls' : '')}>
        <Popover
          label="添加内容"
          icon={<Plus size={17} />}
          className="composer-add-trigger"
          disabled={disabled || !!progress || attachments.length >= maxAttachments}
        >
          {(close) => (
            <div className="composer-add-options">
              <button
                type="button"
                className="composer-option"
                aria-label="添加附件"
                onClick={() => {
                  close();
                  input.current?.click();
                }}
              >
                <Paperclip size={18} />
                <span>
                  <strong>添加附件</strong>
                  <small>上传图片或文件，也可直接粘贴、拖入</small>
                </span>
              </button>
              <button
                type="button"
                className="composer-option attachment-reference"
                aria-label="引用会话"
                onClick={() => {
                  close();
                  setReferencing(true);
                }}
              >
                <MessageSquareQuote size={18} />
                <span>
                  <strong>引用会话</strong>
                  <small>从其他会话添加上下文，支持跨工作空间</small>
                </span>
              </button>
              <p className="composer-menu-hint">最多 10 个附件，单个不超过 20 MB</p>
            </div>
          )}
        </Popover>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="上传图片或文件"
          disabled={disabled || !!progress}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = '';
            void upload(files);
          }}
        />
        {children}
      </div>
      {attachments.length > 0 && (
        <ul className="attachment-list" aria-label="待发送附件">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <span className="attachment-thumbnail">
                <Thumbnail attachment={attachment} />
              </span>
              <span className="attachment-meta">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small>{sizeLabel(attachment.size)}</small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`移除附件 ${attachment.name}`}
                disabled={disabled || !!progress}
                onClick={() => void remove(attachment.id)}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {progress && (
        <p className="attachment-progress" role="status">
          <LoaderCircle className="spin" size={13} />
          {progress}
        </p>
      )}
      {referencing && (
        <SessionReferenceDialog
          disabled={disabled || attachments.length >= maxAttachments}
          progress={progress}
          onReference={picker.reference}
          onClose={() => setReferencing(false)}
        />
      )}
    </div>
  );
}
