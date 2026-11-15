import { jsonLines } from '../jsonl.js';
import { normalizeImagePath, recordedImage } from '../media.js';

export async function savedImage(file: string | null, itemId: string) {
  if (!file) return null;
  let views: { id: string; start: number; path: string }[] = [];
  const calls = new Map<string, string>();
  for await (const line of jsonLines(file, 60 * 1024 * 1024)) {
    try {
      const record = JSON.parse(line),
        p = record.payload ?? {};
      if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type))
        calls.set(p.call_id, String(p.input ?? p.arguments ?? ''));
      if (
        record.type === 'event_msg' &&
        p.type === 'item_completed' &&
        String(p.item?.type).replaceAll('_', '').toLowerCase() === 'imageview'
      )
        views.push({
          id: String(p.item.id),
          start: Number(p.started_at_ms) || Date.parse(record.timestamp) || 0,
          path: String(p.item.path ?? ''),
        });
      if (
        record.type === 'response_item' &&
        ['function_call', 'custom_tool_call'].includes(p.type) &&
        /(?:^|[.:])view_image$/.test(String(p.name))
      )
        views.push({ id: p.call_id, start: Date.parse(record.timestamp) || 0, path: '' });
      if (
        record.type === 'response_item' &&
        ['function_call_output', 'custom_tool_call_output'].includes(p.type)
      ) {
        const images = Array.isArray(p.output)
          ? p.output.filter(
              (part: any) => part.type === 'input_image' && typeof part.image_url === 'string',
            )
          : [];
        if (views.length > 1 && views.some((view) => view.id === itemId)) {
          const code = calls.get(p.call_id) || '';
          const positions = views.map((view) => {
            let position = -1;
            if (view.path) {
              try {
                const local = normalizeImagePath(view.path);
                const variants = [
                  view.path,
                  local,
                  local.replaceAll('\\', '/'),
                  local.replaceAll('\\', '\\\\'),
                ];
                const found = variants
                  .map((value) => code.indexOf(JSON.stringify(value)))
                  .filter((value) => value >= 0);
                if (found.length) position = Math.min(...found);
              } catch {}
            }
            return { view, position };
          });
          if (
            positions.some((entry) => entry.position < 0) ||
            new Set(positions.map((entry) => entry.position)).size !== views.length
          )
            return null;
          positions.sort((a, b) => a.position - b.position);
          views = positions.map((entry) => entry.view);
        }
        const index = views.findIndex((view) => view.id === itemId);
        if (index >= 0) {
          if (images.length === views.length) return recordedImage(images[index].image_url);
          return null;
        }
        views = [];
        calls.delete(p.call_id);
      }
    } catch {}
  }
  return null;
}
