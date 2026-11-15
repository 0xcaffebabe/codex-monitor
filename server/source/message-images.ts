import { fromMarkdown } from 'mdast-util-from-markdown';
import path from 'node:path';
import type { SessionImageRef, TimelineEvent } from '../../src/types.js';
import { normalizeImagePath } from '../media.js';

type MarkdownNode = {
  type: string;
  url?: string;
  identifier?: string;
  alt?: string | null;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
};
type MarkdownImage = Omit<SessionImageRef, 'source'> & { source: string };

export function messageImagePath(source: string) {
  if (!source.startsWith('file:')) {
    try {
      source = decodeURIComponent(source);
    } catch {}
  }
  return normalizeImagePath(source);
}

/** Resolve only actual Markdown images, including references, never code or plain links. */
export function messageImages(event: TimelineEvent): MarkdownImage[] {
  if (event.kind === 'tool' || event.kind === 'system' || !event.text.includes('!')) return [];
  const nodes: MarkdownNode[] = [],
    pending: MarkdownNode[] = [fromMarkdown(event.text)];
  while (pending.length) {
    const node = pending.pop()!;
    nodes.push(node);
    if (node.children) pending.push(...node.children.toReversed());
  }
  const definitions = new Map<string, string>();
  for (const node of nodes) {
    if (node.type === 'definition' && node.identifier && node.url) {
      const key = node.identifier.toUpperCase();
      if (!definitions.has(key)) definitions.set(key, node.url);
    }
  }
  const images: MarkdownImage[] = [];
  for (const node of nodes) {
    const source =
      node.type === 'image'
        ? node.url
        : node.type === 'imageReference'
          ? definitions.get(node.identifier?.toUpperCase() ?? '')
          : undefined;
    if (!source) continue;
    try {
      const file = messageImagePath(source);
      if (!/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file)) continue;
      images.push({
        id: event.id,
        index: images.length,
        name: node.alt || path.basename(file),
        offset: node.position?.start.offset,
        source,
      });
    } catch {
      // Remote URLs and network paths remain placeholders without fetching them.
    }
  }
  return images;
}

export function withMessageImages(event: TimelineEvent): TimelineEvent {
  const images = messageImages(event);
  return images.length
    ? { ...event, images: images.map(({ source: _source, ...image }) => image) }
    : event;
}
