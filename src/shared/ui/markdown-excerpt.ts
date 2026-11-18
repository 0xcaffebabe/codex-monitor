import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Node, Parent } from 'mdast';

function prose(node: Node): string {
  if (['code', 'html', 'thematicBreak', 'definition'].includes(node.type)) return '';
  if (node.type === 'break') return ' ';
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('alt' in node && typeof node.alt === 'string') return node.alt;
  return 'children' in node
    ? (node as Parent).children
        .map(prose)
        .join(node.type === 'paragraph' || node.type === 'heading' ? '' : ' ')
    : '';
}

export function markdownExcerpt(text: string, limit = 130) {
  const first = fromMarkdown(text)
    .children.map((node) => prose(node).replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!first) return '';
  const characters = Array.from(first);
  return characters.length > limit ? characters.slice(0, limit).join('').trimEnd() + '…' : first;
}
