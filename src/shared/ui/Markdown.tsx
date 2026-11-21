import { ArrowUpRight, FileText } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ImageRenderer = (offset: number | undefined, alt: string) => ReactNode;
type FileRenderer = (offset: number | undefined, children: ReactNode) => ReactNode;
const MarkdownRenderers = createContext<{ renderImage?: ImageRenderer; renderFile?: FileRenderer }>({});

function MarkdownImage({ node, alt }: ExtraProps & { alt?: string }) {
  const { renderImage } = useContext(MarkdownRenderers);
  return (
    renderImage?.(node?.position?.start.offset, alt || '') ?? (
      <span className="image-placeholder">
        <FileText size={14} />
        {alt || '会话附图'}
      </span>
    )
  );
}

function MarkdownLink({ href, node, children }: ExtraProps & { href?: string; children?: ReactNode }) {
  const { renderFile } = useContext(MarkdownRenderers);
  return renderFile?.(node?.position?.start.offset, children) ?? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <ArrowUpRight size={11} />
    </a>
  );
}

// Keep component identities stable so session refreshes preserve loaded image URLs.
const components: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  table: ({ children }) => (
    <div className="markdown-table-scroll" role="region" aria-label="表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ text, renderImage, renderFile }: {
  text: string;
  renderImage?: ImageRenderer;
  renderFile?: FileRenderer;
}) {
  return (
    <div className="markdown">
      <MarkdownRenderers.Provider value={{ renderImage, renderFile }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
      </MarkdownRenderers.Provider>
    </div>
  );
}
