import { ArrowUpRight, Check, CircleAlert, Copy, FileText } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyText } from '../clipboard';

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

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const feedback = status === 'copied' ? '已复制到剪贴板' : status === 'error' ? '复制失败' : '';
  const Icon = status === 'copied' ? Check : status === 'error' ? CircleAlert : Copy;

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setStatus('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copyCode() {
    if (!code.current || status === 'copying') return;
    setStatus('copying');
    try {
      // The Markdown renderer appends one newline to nonempty code blocks.
      await copyText((code.current.textContent ?? '').replace(/\n$/, ''));
      setStatus('copied');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="markdown-code-block">
      <pre ref={code} tabIndex={0}>{children}</pre>
      <button type="button" className="icon-button markdown-code-copy" data-status={status}
        aria-label="复制代码" title={feedback || '复制代码'} onClick={copyCode}>
        <Icon size={15} aria-hidden="true" />
      </button>
      <span className="markdown-code-feedback" role="status">{feedback}</span>
    </div>
  );
}

// Keep component identities stable so session refreshes preserve loaded image URLs.
const components: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  pre: MarkdownCodeBlock,
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
