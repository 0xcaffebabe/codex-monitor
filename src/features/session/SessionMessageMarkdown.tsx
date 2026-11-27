import { FileText } from 'lucide-react';
import type { ComponentProps } from 'react';
import type { SessionFileLink } from '../../file-preview-types';
import { Markdown } from '../../shared/ui/Markdown';
import type { TimelineEvent } from '../../types';

export function SessionMessageMarkdown({
  event,
  renderImage,
  onOpenFile,
}: {
  event: Pick<TimelineEvent, 'id' | 'text' | 'files'>;
  renderImage?: ComponentProps<typeof Markdown>['renderImage'];
  onOpenFile?: (itemId: string, file: SessionFileLink) => void;
}) {
  const renderFile: ComponentProps<typeof Markdown>['renderFile'] = (offset, children) => {
    const file = event.files?.find((link) => link.offset === offset);
    if (!file) return null;
    if (!onOpenFile)
      return <span title="文件预览需要管理员权限">{children || file.path}</span>;
    return (
      <button
        type="button"
        className="markdown-file-link"
        aria-haspopup="dialog"
        title={file.path}
        onClick={() => onOpenFile(event.id, file)}
      >
        {children || file.path}
        <FileText size={12} aria-hidden="true" />
      </button>
    );
  };

  return (
    <Markdown
      text={event.text}
      renderImage={renderImage}
      renderFile={event.files ? renderFile : undefined}
    />
  );
}
