import { LoaderCircle, Paperclip, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { maxAttachments, sizeLabel } from './attachment-model';
import { Thumbnail } from './Thumbnail';
import type { Attachment } from './types';
import type { useAttachmentPicker } from './useAttachmentPicker';

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
  return (
    <div className="attachment-picker">
      <div className={'attachment-toolbar' + (children ? ' has-controls' : '')}>
        <button
          type="button"
          className="attachment-add"
          title="上传图片或文件"
          disabled={disabled || !!progress || attachments.length >= maxAttachments}
          onClick={() => input.current?.click()}
        >
          <Paperclip size={15} /> <span>添加附件</span>
        </button>
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
        <small>{attachments.length ? `${attachments.length} / 10 · ` : ''}单个 ≤ 20 MB</small>
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
    </div>
  );
}
