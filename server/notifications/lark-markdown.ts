import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

function imageText(alt: string | null | undefined, source: string | undefined, inLink: boolean) {
  const label = (alt?.trim() || '图片').replace(/[\\[\]`*_<>!]/g, '\\$&');
  if (inLink) return label;
  try {
    const url = new URL(source ?? '');
    if (url.protocol === 'https:' || url.protocol === 'http:') return `[${label}](<${url.href}>)`;
  } catch {}
  return `${label}（请在会话中查看图片）`;
}

/** Card images require provider-issued image keys, never URLs or local paths. */
export function larkMarkdown(text: string) {
  if (text.includes('!')) {
    const nodes: { node: Nodes; inLink: boolean }[] = [],
      pending = [{ node: fromMarkdown(text) as Nodes, inLink: false }];
    while (pending.length) {
      const entry = pending.pop()!;
      nodes.push(entry);
      if ('children' in entry.node) {
        const inLink =
          entry.inLink || entry.node.type === 'link' || entry.node.type === 'linkReference';
        pending.push(...entry.node.children.toReversed().map((node) => ({ node, inLink })));
      }
    }
    const definitions = new Map<string, string>();
    for (const { node } of nodes) {
      if (node.type === 'definition') {
        const key = node.identifier.toUpperCase();
        if (!definitions.has(key)) definitions.set(key, node.url);
      }
    }
    const edits: { start: number; end: number; value: string }[] = [];
    for (const { node, inLink } of nodes) {
      if (node.type !== 'image' && node.type !== 'imageReference') continue;
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      const source =
        node.type === 'image' ? node.url : definitions.get(node.identifier.toUpperCase());
      edits.push({ start, end, value: imageText(node.alt, source, inLink) });
    }
    // Replace only parsed images, leaving code examples and other formatting intact.
    for (const edit of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  }
  // Neutralize mentions while preserving blockquotes, autolinks and code operators.
  return text.replace(/<\/?at\b[^>]*>/gi, (tag) => tag.replaceAll('<', '＜').replaceAll('>', '＞'));
}
