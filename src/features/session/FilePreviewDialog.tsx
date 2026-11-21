import { Download, FileText, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { SessionFileLink } from '../../file-preview-types';
import { Markdown } from '../../shared/ui/Markdown';
import { useSessionFilePreview } from './useSessionFilePreview';

export function FilePreviewDialog({
  sessionId,
  itemId,
  link,
  workspaceName,
  onClose,
}: {
  sessionId: string;
  itemId: string;
  link: SessionFileLink;
  workspaceName?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const contents = useRef<HTMLPreElement>(null);
  const { preview, error, retry, download, downloadError, downloading, onImageError } =
    useSessionFilePreview(sessionId, itemId, link.id);
  const file = preview?.file;
  const path = file?.path ?? link.path;
  const name = file?.name ?? (path.split(/[\\/]/).at(-1) || path);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    contents.current
      ?.querySelector('[data-target-line]')
      ?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [file]);

  function close() {
    dialog.current?.close();
    onClose();
  }

  return (
    <dialog
      ref={dialog}
      className="file-preview-dialog"
      aria-label="文件预览"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="file-preview-header">
        <FileText size={21} aria-hidden="true" />
        <div>
          <h2 title={name}>{name}</h2>
          <p>
            {workspaceName || '当前工作空间'}
            {link.line ? ` · 第 ${link.line}${link.endLine ? `–${link.endLine}` : ''} 行` : ''}
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          title="关闭文件预览"
          aria-label="关闭文件预览"
          onClick={close}
          autoFocus
        >
          <X size={20} />
        </button>
        <div className="file-preview-path" title={path} tabIndex={0}>
          {path}
        </div>
      </header>
      {file && (file.kind === 'text' || file.kind === 'markdown') && file.partial && (
        <div className="file-preview-note" role="status">
          部分预览 · 第 {file.startLine}–{file.startLine + file.lines.length - 1} 行
        </div>
      )}
      <div className="file-preview-body">
        {error ? (
          <div className="file-preview-state" role="alert">
            <p>{error}</p>
            <button type="button" className="secondary" onClick={retry}>
              重试
            </button>
          </div>
        ) : !file ? (
          <div className="file-preview-state" role="status">
            <LoaderCircle className="spin" size={20} />
            正在读取文件…
          </div>
        ) : file.kind === 'image' ? (
          <div className="file-preview-image">
            <img src={preview?.imageUrl} alt={name} onError={onImageError} />
          </div>
        ) : file.kind === 'download' ? (
          <div className="file-preview-state">
            <button
              type="button"
              className="secondary"
              disabled={downloading}
              onClick={() => void download()}
            >
              {downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
              {downloading ? '正在下载…' : '下载文件'}
            </button>
            {downloadError && <p role="alert">{downloadError}</p>}
          </div>
        ) : file.kind === 'markdown' ? (
          <div className="file-preview-markdown">
            <Markdown text={file.lines.join('\n')} />
          </div>
        ) : file.kind === 'text' ? (
          <pre ref={contents} className="file-preview-lines" aria-label="文件内容" tabIndex={0}>
            {file.lines.map((text, index) => {
              const line = file.startLine + index;
              const highlighted =
                file.line !== undefined && line >= file.line && line <= (file.endLine ?? file.line);
              return (
                <span
                  key={line}
                  className={`file-preview-line${highlighted ? ' highlighted' : ''}`}
                  data-target-line={line === file.line ? '' : undefined}
                >
                  <span className="file-preview-number" aria-hidden="true">
                    {line}
                  </span>
                  <span className="file-preview-code">{text || ' '}</span>
                </span>
              );
            })}
          </pre>
        ) : null}
      </div>
    </dialog>
  );
}
