import { createReadStream } from 'node:fs';

export const COMPUTER_USE_LINE_LIMIT = 32 * 1024 * 1024;

/** Keep byte offsets so a selected screenshot needs only its own record, not another log scan. */
export async function* computerUseRecords(file: string, start: number, size: number) {
  if (start >= size) return;
  const input = createReadStream(file, { start, end: size - 1 });
  let parts: Buffer[] = [],
    bytes = 0,
    offset = start,
    skipped = false;
  const take = (part: Buffer) => {
    bytes += part.length;
    if (bytes > COMPUTER_USE_LINE_LIMIT) {
      parts = [];
      skipped = true;
    } else if (!skipped && part.length) parts.push(part);
  };
  try {
    for await (const raw of input) {
      const chunk = raw as Buffer;
      let from = 0,
        end: number;
      while ((end = chunk.indexOf(10, from)) !== -1) {
        take(chunk.subarray(from, end));
        const next = offset + bytes + 1;
        yield {
          line: skipped ? '' : Buffer.concat(parts, bytes).toString('utf8'),
          offset,
          bytes,
          next,
        };
        offset = next;
        parts = [];
        bytes = 0;
        skipped = false;
        from = end + 1;
      }
      take(chunk.subarray(from));
    }
    // A trailing partial record is retried from the last complete newline on the next refresh.
  } finally {
    input.destroy();
  }
}
