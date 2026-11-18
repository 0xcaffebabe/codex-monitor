import { ArrowUpRight, FileText } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ImageRenderer = (offset: number | undefined, alt: string) => ReactNode;
const ImageRendererContext = createContext<ImageRenderer | undefined>(undefined);

function MarkdownImage({ node, alt }: ExtraProps & { alt?: string }) {
  const renderImage = useContext(ImageRendererContext);
  return (
    renderImage?.(node?.position?.start.offset, alt || '') ?? (
      <span className="image-placeholder">
        <FileText size={14} />
        {alt || '会话附图'}
      </span>
    )
  );
}

// Keep component identities stable so session refreshes preserve loaded image URLs.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <ArrowUpRight size={11} />
    </a>
  ),
  img: MarkdownImage,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  table: ({ children }) => (
    <div className="markdown-table-scroll" role="region" aria-label="表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ text, renderImage }: { text: string; renderImage?: ImageRenderer }) {
  return (
    <div className="markdown">
      <ImageRendererContext.Provider value={renderImage}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
      </ImageRendererContext.Provider>
    </div>
  );
}
