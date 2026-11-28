import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

function webUrl(source: string | undefined) {
  try {
    const url = new URL(source ?? '');
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {}
}

function escapedLabel(text: string | null | undefined, fallback: string) {
  return (text?.trim() || fallback).replace(/[\\[\]`*_<>!]/g, '\\$&');
}

function linkLabel(node: Nodes): string {
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  return 'children' in node ? node.children.map(linkLabel).join('') : '';
}

/** Card images require provider-issued image keys, never URLs or local paths. */
export function larkMarkdown(text: string) {
  if (/[!\[<]/.test(text)) {
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
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (node.type === 'image' || node.type === 'imageReference') {
        const url = webUrl(
          node.type === 'image' ? node.url : definitions.get(node.identifier.toUpperCase()),
        );
        const label = escapedLabel(node.alt, '图片');
        const value = inLink
          ? label
          : url
            ? `[${label}](<${url}>)`
            : label;
        edits.push({ start, end, value });
      } else if (node.type === 'link' || node.type === 'linkReference') {
        const url =
          node.type === 'link' ? node.url : definitions.get(node.identifier.toUpperCase());
        if (!webUrl(url)) edits.push({ start, end, value: escapedLabel(linkLabel(node), '附件') });
      } else if (node.type === 'definition' && !webUrl(node.url)) {
        edits.push({ start, end, value: '' });
      }
    }
    let offset = 0;
    const parts: string[] = [];
    for (const edit of edits.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (edit.start < offset) continue; // The enclosing link has already been replaced.
      parts.push(text.slice(offset, edit.start), edit.value);
      offset = edit.end;
    }
    text = parts.join('') + text.slice(offset);
  }
  // Neutralize mentions while preserving blockquotes, autolinks and code operators.
  return text.replace(/<\/?at\b[^>]*>/gi, (tag) => tag.replaceAll('<', '＜').replaceAll('>', '＞'));
}
