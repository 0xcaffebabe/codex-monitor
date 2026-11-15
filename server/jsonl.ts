import { createReadStream } from 'node:fs';

/** Yield an empty line for oversized records, preserving physical line ordinals. */
export async function* jsonLines(file: string, maxBytes: number) {
  const input = createReadStream(file);
  let parts: Buffer[] = [],
    size = 0,
    skipping = false;
  const take = (part: Buffer) => {
    if (skipping) return;
    size += part.length;
    if (size > maxBytes) {
      parts = [];
      size = 0;
      skipping = true;
    } else if (part.length) parts.push(part);
  };
  const text = () => (skipping ? '' : Buffer.concat(parts, size).toString('utf8'));
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
