import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { SessionFileLink } from '../../src/file-preview-types.js';
import type { TimelineEvent } from '../../src/types.js';

const scheme = /^[a-z][a-z\d+.-]*:/i;
const drive = /^\/?[a-z]:[\\/]/i;
const control = /[\x00-\x1f\x7f]/;
const lineFragment = /#L(\d+)(?:-L?(\d+))?$/i;
const lineSuffix = /:(\d+)(?::\d+)?$/;

function fileTarget(destination: string): Omit<SessionFileLink, 'id' | 'offset'> | undefined {
  if (!destination || destination.length > 4096 || control.test(destination)) return;
  const fragment = lineFragment.exec(destination);
  const suffix = fragment ?? lineSuffix.exec(destination);
  const file = suffix ? destination.slice(0, suffix.index) : destination;
  let local = file;
  if (/^file:\/\//i.test(file)) {
    try {
      const url = new URL(file);
      if (url.hostname && url.hostname !== 'localhost') return;
      local = fileURLToPath(url);
    } catch {
      return;
    }
  } else {
    if (!drive.test(file) && scheme.test(destination)) {
      // A bare filename such as README.md:42 also has the shape of a URI scheme.
      if (!suffix || fragment || !/^[^.\s]+\.[^:\s]+$/.test(file)) return;
    }
    try {
      local = decodeURIComponent(file);
    } catch {
      // A literal percent sign is valid in a Markdown path.
    }
  }
  if (
    !local ||
    /^[?#]|^[\\/]{2}/.test(local) ||
    control.test(local) ||
    (!drive.test(local) && scheme.test(local))
  )
    return;
  const line = suffix ? Number(suffix[1]) : undefined;
  const endLine = fragment?.[2] ? Number(fragment[2]) : undefined;
  if (
    (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) ||
    (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line!))
  )
    return;
  return { path: local, line, endLine };
}

function attachmentTarget(destination: string) {
  const local = destination.startsWith('sandbox:/mnt/data/')
    ? destination.slice('sandbox:'.length)
    : destination;
  const target = fileTarget(local);
  if (target?.line === undefined) return target;
}

export function completionAttachmentId(file: string) {
  return createHash('sha256').update(file).digest('hex');
}

export function completionAttachmentLinkId(destination: string | undefined) {
  const file = destination && attachmentTarget(destination);
  return file ? completionAttachmentId(file.path) : undefined;
}

function markdownFiles(
  event: Pick<TimelineEvent, 'kind' | 'text'>,
  attachment = false,
): SessionFileLink[] {
  if (event.kind === 'tool' || event.kind === 'system' || !/\[|<file:/i.test(event.text)) return [];
  type Node = {
    type: string;
    url?: string;
    identifier?: string;
    children?: Node[];
    position?: { start: { offset?: number } };
  };
  const nodes: Node[] = [];
  const pending: Node[] = [fromMarkdown(event.text)];
  while (pending.length) {
    const node = pending.pop()!;
    nodes.push(node);
    if (node.children) pending.push(...node.children.toReversed());
  }
  const definitions = new Map<string, string>();
  for (const node of nodes) {
    if (
      node.type === 'definition' &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url);
  }
  const files: SessionFileLink[] = [];
  for (const node of nodes) {
    const destination =
      node.type === 'link' || (attachment && node.type === 'image')
        ? node.url
        : node.type === 'linkReference' || (attachment && node.type === 'imageReference')
          ? definitions.get(node.identifier ?? '')
          : undefined;
    const offset = node.position?.start.offset;
    if (!destination || offset === undefined) continue;
    const target = attachment ? attachmentTarget(destination) : fileTarget(destination);
    if (!target) continue;
    // A changing realtime message must never open a new target at an old offset.
    const id = createHash('sha256')
      .update(JSON.stringify([offset, destination]))
      .digest('hex');
    files.push({ ...target, id, offset });
    if (files.length === 100) break;
  }
  return files;
}

export function messageFiles(event: TimelineEvent) {
  return markdownFiles(event);
}

export function completionFilePaths(text: string) {
  return [...new Set(markdownFiles({ kind: 'assistant', text }, true).map((file) => file.path))];
}

export function withMessageFiles(event: TimelineEvent): TimelineEvent {
  const files = messageFiles(event);
  return files.length ? { ...event, files } : event;
}
