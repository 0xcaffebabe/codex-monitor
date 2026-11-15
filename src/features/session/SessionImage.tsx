import { Image as ImageIcon, LoaderCircle, X, ZoomIn } from 'lucide-react';
import { createPortal } from 'react-dom';
import { SessionImageProps, useSessionImage } from './useSessionImage';

export function SessionImage(props: SessionImageProps) {
  const { url, error, open, setOpen, ref, name, onImageError } = useSessionImage(props);
  return (
    <span ref={ref} className={`session-image${props.inline ? ' inline-session-image' : ''}`}>
      {url ? (
        <button
          className="image-thumbnail"
          aria-label={'放大查看图片：' + name}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }}
        >
          <img src={url} alt={name} onError={onImageError} />
          <span>
            <ZoomIn size={14} />
          </span>
        </button>
      ) : (
        <span className="image-loading">
          {error ? (
            <>
              <ImageIcon size={20} />
              <span>{error}</span>
            </>
          ) : (
            <LoaderCircle className="spin" size={18} />
          )}
        </span>
      )}
      <span className="image-filename" title={name}>
        {name}
      </span>
      {open &&
        createPortal(
          <div
            className="image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="图片预览"
            onClick={() => setOpen(false)}
          >
            <header>
              <span>{name}</span>
              <button className="icon-button" title="关闭图片预览" onClick={() => setOpen(false)}>
                <X size={22} />
              </button>
            </header>
            <img src={url} alt={name} onClick={(e) => e.stopPropagation()} />
          </div>,
          props.portalTarget ?? document.body,
        )}
    </span>
  );
}
