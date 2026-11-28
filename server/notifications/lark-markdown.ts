import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { completionAttachmentLinkId } from '../source/message-files.js';

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
export function larkMarkdown(text: string, images?: ReadonlyMap<string, string>) {
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
    const image = (source: string | undefined, label: string) => {
      if (!images?.size) return;
      const id = completionAttachmentLinkId(source);
      const key = id && images.get(id);
      if (key) return `![${label}](${key})`;
    };
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
        const source = node.type === 'image' ? node.url : definitions.get(node.identifier.toUpperCase());
        const url = webUrl(source);
        const label = escapedLabel(node.alt, '图片');
        const value = inLink
          ? label
          : image(source, label) ?? (url
            ? `[${label}](<${url}>)`
            : label);
        edits.push({ start, end, value });
      } else if (node.type === 'link' || node.type === 'linkReference') {
        const url =
          node.type === 'link' ? node.url : definitions.get(node.identifier.toUpperCase());
        const label = escapedLabel(linkLabel(node), '附件');
        const child = node.children.length === 1 ? node.children[0] : undefined;
        const nestedImage = child?.type === 'image' ? child.url
          : child?.type === 'imageReference' ? definitions.get(child.identifier.toUpperCase())
            : undefined;
        const value = image(nestedImage, label) ?? image(url, label);
        if (value || !webUrl(url)) edits.push({ start, end, value: value ?? label });
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
