import type { ComputerUseStep } from '../../src/types.js';
import { recordedImage } from '../media.js';

function object(value: any): any {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
export function isComputerUseCall(item: any): boolean {
  const name = [item.server, item.namespace, item.name, item.tool].filter(Boolean).join('.');
  const args = object(item.arguments ?? item.input ?? {});
  if (args?.completion_summary && !args.code) return false;
  if (/(?:cua_repl|computer[_-]?use|(?:^|[.:_])computer(?:[.:_]|$))/i.test(name)) return true;
  const code = typeof args === 'string' ? args : String(args?.code ?? item.code ?? '');
  return (
    /node_repl/i.test(name) &&
    /@oai\/sky|\bsky\.(?:list_|get_|click|scroll|drag|type_text|press_key|set_value|activate_window|launch_app|perform_secondary_action)/.test(
      code,
    )
  );
}
export function computerUseStep(item: any, id: string, timestamp: number): ComputerUseStep {
  const args = object(item.arguments ?? item.input ?? {});
  return {
    id,
    timestamp,
    title: typeof args?.title === 'string' ? args.title.slice(0, 240) : '操作电脑或浏览器',
    status: String(item.status ?? 'inProgress'),
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
    screenshots: 0,
  };
}
function resultOf(value: any): any {
  let result = object(value);
  // Desktop history wraps MCP results in a JSON text content block.
  for (let depth = 0; depth < 3; depth++) {
    if (!Array.isArray(result?.content) || result.content.length !== 1) break;
    const text = result.content[0]?.text;
    if (typeof text !== 'string' || !text.startsWith('{')) break;
    const decoded = object(text);
    if (!decoded || typeof decoded !== 'object' || !Array.isArray(decoded.content)) break;
    result = decoded;
  }
  return result;
}
export function screenshotMedia(url: string) {
  const encoded = url.slice(url.indexOf(',') + 1).replace(/[\r\n]/g, '');
  if (encoded.length % 4 !== 0) return null;
  const media = recordedImage(url);
  if (media?.mime === 'image/jpeg' && (media.data.at(-2) !== 255 || media.data.at(-1) !== 217))
    return null;
  if (media?.mime === 'image/png' && media.data.subarray(-8, -4).toString('ascii') !== 'IEND')
    return null;
  return media;
}
export function computerUseResult(value: any) {
  const result = resultOf(value);
  const parts: any[] = Array.isArray(result)
    ? result
    : Array.isArray(result?.content)
      ? result.content
      : [];
  const meta = result?._meta ?? {};
  const surface = meta['codex/toolSurface'] ?? {};
  const screenshot = surface.screenshot;
  const tab =
    surface.openTabs?.find((tab: any) => String(tab.id) === String(screenshot?.tabId)) ??
    surface.openTabs?.[0];
  const text = parts
    .filter((part) => ['text', 'input_text', 'output_text'].includes(part.type))
    .map((part) => String(part.text ?? ''))
    .join('\n')
    .replace(/^Wall time:[^\n]*\nOutput:\s*/, '')
    .trim()
    .slice(0, 4000);
  const urls: string[] = [];
  for (const part of parts) {
    const url =
      part.type === 'input_image'
        ? part.image_url
        : part.type === 'image' && typeof part.data === 'string'
          ? `data:${part.mimeType};base64,${part.data}`
          : undefined;
    if (typeof url === 'string' && screenshotMedia(url)) urls.push(url);
  }
  if (!urls.length && typeof screenshot?.url === 'string' && screenshotMedia(screenshot.url))
    urls.push(screenshot.url);
  const url = screenshot?.pageUrl ?? tab?.url ?? meta.browser_use?.url;
  return {
    images: urls,
    text: text || undefined,
    url: typeof url === 'string' && /^https?:\/\//i.test(url) ? url.slice(0, 2000) : undefined,
    pageTitle: typeof tab?.title === 'string' ? tab.title.slice(0, 500) : undefined,
    failed: !!result?.isError,
  };
}
