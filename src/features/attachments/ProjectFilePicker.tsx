import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectFileEntry, ProjectFileListing } from '../../project-file-types';
import { useProjectFiles } from './useProjectFiles';

export type ProjectFileOptions = {
  url: string;
  onInsert: (paths: string[]) => string | undefined;
};

type PickerProps = ProjectFileOptions & { disabled: boolean };

export function ProjectFilePicker({ closeMenu, ...props }: PickerProps & { closeMenu: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="composer-option"
        aria-haspopup="dialog"
        disabled={props.disabled}
        onClick={() => {
          closeMenu();
          setOpen(true);
        }}
      >
        <FolderTree size={18} />
        <span>
          <strong>项目文件</strong>
        </span>
      </button>
      {open && <ProjectFileDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProjectFileDialog({
  url,
  disabled,
  onInsert,
  onClose,
}: PickerProps & { onClose: () => void }) {
  const model = useProjectFiles(url);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    if (!window.matchMedia('(max-width: 760px)').matches) search.current?.focus();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);

  function fileRow(entry: ProjectFileEntry, listing: ProjectFileListing, showPath = false) {
    const absolute = `${listing.root.replace(/\/$/, '')}/${entry.path}`;
    return (
      <label className="project-file-row project-file-leaf" title={absolute}>
        <input
          type="checkbox"
          aria-label={`选择文件 ${entry.path}`}
          checked={model.selected.has(absolute)}
          disabled={disabled}
          onChange={() => model.toggleFile(absolute)}
        />
        <File size={16} />
        <span className="project-file-name">
          <span>{entry.name}</span>
          {showPath && <small>{entry.path}</small>}
        </span>
      </label>
    );
  }

  function directoryContents(directory: string) {
    const state = model.directories.get(directory);
    if (!state || state.loading)
      return (
        <p className="project-file-state" role="status">
          <LoaderCircle className="spin" size={15} />
          正在读取文件…
        </p>
      );
    if (state.error)
      return (
        <p className="control-error project-file-state" role="alert">
          {state.error}
          <button type="button" className="secondary" onClick={() => void model.load(directory)}>
            重试
          </button>
        </p>
      );
    const listing = state.listing!;
    return (
      <>
        {!listing.entries.length && <p className="project-file-state">此目录下没有可选文件</p>}
        <ul aria-label={directory ? `目录 ${directory}` : '项目文件树'}>
          {listing.entries.map((entry) => (
            <li key={entry.path}>
              {entry.type === 'file' ? (
                fileRow(entry, listing)
              ) : (
                <>
                  <button
                    type="button"
                    className="project-file-row project-file-directory"
                    aria-label={`目录 ${entry.path}`}
                    aria-expanded={model.expanded.has(entry.path)}
                    onClick={() => model.toggleDirectory(entry.path)}
                  >
                    {model.expanded.has(entry.path) ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                    {model.expanded.has(entry.path) ? (
                      <FolderOpen size={16} />
                    ) : (
                      <Folder size={16} />
                    )}
                    <span className="project-file-name">{entry.name}</span>
                  </button>
                  {model.expanded.has(entry.path) && (
                    <div className="project-file-children">{directoryContents(entry.path)}</div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        {listing.truncated && (
          <p className="control-hint">此目录的文件列表未全部显示，请按文件名搜索。</p>
        )}
      </>
    );
  }

  const results = model.search;
  const root = model.directories.get('')?.listing?.root || results.listing?.root;
  return createPortal(
    <dialog
      ref={dialog}
      className="control-dialog project-file-dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <header>
        <FolderTree size={21} />
        <h2 id={titleId}>选择项目文件</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新项目文件"
          title="刷新项目文件"
          onClick={model.refresh}
        >
          <RefreshCw size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭项目文件"
          onClick={onClose}
          autoFocus
        >
          <X size={18} />
        </button>
      </header>
      <p className="control-hint">展开目录或按文件名搜索，勾选后将文件路径插入消息。</p>
      {root && (
        <p className="project-file-root" title={root}>
          {root}
        </p>
      )}
      <div className="search-box project-file-search">
        <Search size={16} />
        <input
          ref={search}
          aria-label="搜索项目文件名"
          placeholder="按文件名搜索，包含子目录…"
          maxLength={200}
          value={model.query}
          onChange={(event) => model.setQuery(event.target.value)}
        />
        {!!model.query && (
          <button
            type="button"
            className="icon-button"
            aria-label="清除文件搜索"
            onClick={() => model.setQuery('')}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div
        className="project-file-results"
        aria-busy={model.searching ? results.loading : model.directories.get('')?.loading}
      >
        {!model.searching ? (
          directoryContents('')
        ) : results.loading ? (
          <p className="project-file-state" role="status">
            <LoaderCircle className="spin" size={16} />
            正在搜索文件…
          </p>
        ) : results.error ? (
          <p className="control-error" role="alert">
            {results.error}
            <button type="button" className="secondary" onClick={model.refresh}>
              重试
            </button>
          </p>
        ) : (
          results.listing && (
            <>
              {!results.listing.entries.length && (
                <p className="project-file-state" role="status">
                  没有找到匹配的文件
                </p>
              )}
              <ul aria-label="文件搜索结果">
                {results.listing.entries.map((entry) => (
                  <li key={entry.path}>{fileRow(entry, results.listing!, true)}</li>
                ))}
              </ul>
              {results.listing.truncated && (
                <p className="control-hint" role="status">
                  搜索达到上限，请输入更完整的文件名缩小范围。
                </p>
              )}
              {results.listing.incomplete && (
                <p className="control-hint" role="status">
                  部分目录暂时无法读取，已显示可访问的搜索结果。
                </p>
              )}
            </>
          )
        )}
      </div>
      {error && (
        <p className="control-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <span className="muted" role="status">
          已选 {model.selected.size} 个文件
        </span>
        <button
          type="button"
          className="secondary"
          disabled={!model.selected.size}
          onClick={() => {
            model.clearSelection();
            setError('');
          }}
        >
          清空选择
        </button>
        <button
          type="button"
          className="primary"
          disabled={disabled || !model.selected.size}
          onClick={() => {
            const failure = onInsert([...model.selected]);
            if (failure) setError(failure);
            else onClose();
          }}
        >
          插入路径
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
