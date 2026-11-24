import { createReadStream } from 'node:fs';

/** Preserve line ordinals by yielding an empty string or a bounded prefix for oversized records. */
export async function* jsonLines(
  file: string,
  maxBytes: number,
  range?: { start: number; end: number; oversizedPrefixBytes?: number },
) {
  const input = createReadStream(file, range);
  let parts: Buffer[] = [],
    size = 0,
    skipping = false;
  const take = (part: Buffer) => {
    if (skipping) return;
    size += part.length;
    if (size > maxBytes) {
      const prefixSize = range?.oversizedPrefixBytes ?? 0;
      parts = prefixSize ? [Buffer.concat([...parts, part], prefixSize)] : [];
      size = prefixSize;
      skipping = true;
    } else if (part.length) parts.push(part);
  };
  const text = () => Buffer.concat(parts, size).toString('utf8');
  try {
    for await (const raw of input) {
      const chunk = raw as Buffer;
      let start = 0,
        end: number;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        take(chunk.subarray(start, end));
        yield text();
        parts = [];
        size = 0;
        skipping = false;
        start = end + 1;
      }
      take(chunk.subarray(start));
    }
    if (size || skipping) yield text();
  } finally {
    input.destroy();
  }
}
