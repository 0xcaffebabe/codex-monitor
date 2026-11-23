import { fromMarkdown } from 'mdast-util-from-markdown';

const omission = '…（回复过长，部分内容已省略）';

export function limitMarkdown(text: string, fits: (value: string) => boolean) {
  if (fits(text)) return text;
  let result = omission;
  for (const block of fromMarkdown(text).children) {
    const end = block.position?.end.offset;
    if (end === undefined) continue;
    const prefix = text.slice(0, end);
    const candidate = `${prefix}\n\n${omission}`;
    if (!fits(candidate)) break;
    result = candidate;
  }
  return result;
}
