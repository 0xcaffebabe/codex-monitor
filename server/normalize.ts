import type { TimelineEvent } from '../src/types.js';
import path from 'node:path';
import { isComputerUseCall } from './source/computer-use-parser.js';
const LIMIT = 100_000;
export function textOf(value: unknown, limit = LIMIT): string {
  if (typeof value === 'string')
    return value.length > limit ? value.slice(0, limit) + '\n…（内容过长，已截断）' : value;
  if (Array.isArray(value))
    return textOf(
      value
        .map((x) =>
          typeof x === 'string'
            ? x
            : (x?.text ??
              x?.input_text ??
              x?.output_text ??
              (x?.type === 'image' || x?.type === 'input_image' ? '[图片]' : '')),
        )
        .join('\n'),
      limit,
    );
  if (value == null) return '';
  return textOf(JSON.stringify(value, null, 2), limit);
}
export function toolTextOf(value: unknown, limit = 2000): string {
  const text = textOf(value, Infinity);
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.65),
    tail = limit - head;
  return `${text.slice(0, head)}\n\n…（中间已省略 ${text.length - limit} 个字符）…\n\n${text.slice(-tail)}`;
}
function toolTitleOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const title = (value as { title?: unknown }).title;
  return typeof title === 'string' ? title.trim() || undefined : undefined;
}
function delegatedText(item: any): string | undefined {
  if (
    String(item.type).replaceAll('_', '').toLowerCase() !== 'functioncalloutput' ||
    item.namespace !== 'codex_app' ||
    !['create_thread', 'send_message_to_thread'].includes(item.name) ||
    typeof item.output !== 'string'
  )
    return;
  const match =
    /^<codex_delegation>\s*<source_thread_id>[^<]*<\/source_thread_id>\s*(?:<source_orbit_id>[^<]*<\/source_orbit_id>\s*)?<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/.exec(
      item.output.trim(),
    );
  if (match)
    return textOf(
      match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'),
    );
}
export function normalizeItem(
  item: any,
  id: string,
  timestamp: number,
  turnId?: string,
): TimelineEvent | null {
  const type = String(item.type || '')
    .replaceAll('_', '')
    .toLowerCase();
  const base = { id, timestamp, turnId };
  // Desktop app tools persist follow-up prompts as tagged tool output. Present the
  // actual human input in the conversation and outline, while retaining raw storage.
  const input = delegatedText(item);
  if (input !== undefined) return { ...base, kind: 'user', text: input };
  if (type === 'usermessage') return { ...base, kind: 'user', text: textOf(item.content) };
  if (type === 'agentmessage')
    return {
      ...base,
      kind: 'assistant',
      text: textOf(item.text ?? item.content),
      phase: item.phase,
    };
  if (type === 'reasoning') {
    const text = textOf(item.summary ?? item.summary_text ?? item.content);
    return text ? { ...base, kind: 'reasoning', text } : null;
  }
  if (type === 'plan')
    return { ...base, kind: 'plan', text: textOf(item.text ?? item.plan ?? item) };
  if (type === 'contextcompaction' || type === 'compaction')
    return { ...base, kind: 'system', text: '会话上下文已压缩' };
  if (type === 'turnstarted') return { ...base, kind: 'system', text: '开始执行' };
  if (type === 'imageview' && typeof item.path === 'string')
    return {
      ...base,
      kind: 'tool',
      name: '查看图片',
      text: item.path,
      status: 'completed',
      image: { id, name: path.basename(item.path.replaceAll('\\', '/')) },
    };
  const name =
    type === 'commandexecution'
      ? '终端命令'
      : type === 'filechange'
        ? '文件改动'
        : type === 'websearch'
          ? '网页搜索'
          : type === 'imageview'
            ? '查看图片'
            : (item.tool ?? item.tool_name ?? item.name ?? item.kind ?? item.type ?? '工具调用');
  const args =
    item.command ??
    item.arguments ??
    item.input ??
    item.query ??
    item.changes ??
    item.path ??
    item.prompt ??
    item.action ??
    item.params ??
    item.code ??
    '（无参数）';
  const exit = item.exitCode ?? item.exit_code;
  const status =
    typeof exit === 'number' && exit !== 0 ? 'failed' : String(item.status ?? 'completed');
  let durationMs = item.durationMs;
  if (item.duration)
    durationMs = Number(item.duration.secs ?? 0) * 1000 + Number(item.duration.nanos ?? 0) / 1e6;
  return {
    ...base,
    kind: 'tool',
    name: String(name),
    title: toolTitleOf(item.arguments ?? item.input ?? item.params),
    text: toolTextOf(args),
    status,
    durationMs,
    computerUse: isComputerUseCall(item) || undefined,
  };
}
export function normalizeRecord(record: any, ordinal: number): TimelineEvent | null {
  const p = record.payload ?? {},
    timestamp = Date.parse(record.timestamp) || 0,
    id = String(p.id ?? `line-${ordinal}`);
  if (record.type === 'response_item') {
    const input = delegatedText(p);
    if (input !== undefined) return { id, kind: 'user', text: input, timestamp };
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role))
      return {
        id,
        kind: p.role === 'user' ? 'user' : 'assistant',
        text: textOf(p.content),
        timestamp,
        phase: p.phase,
      };
    if (['function_call', 'custom_tool_call'].includes(p.type)) {
      const args = p.arguments ?? p.input;
      let imagePath: string | undefined;
      if (/(?:^|[.:])view_image$/.test(String(p.name))) {
        try {
          const args = JSON.parse(p.arguments ?? p.input ?? '{}');
          if (typeof args.path === 'string') imagePath = args.path;
        } catch {}
      }
      return {
        id: p.call_id ?? id,
        kind: 'tool',
        name: p.name,
        title: toolTitleOf(args),
        text: imagePath ?? toolTextOf(args),
        timestamp,
        status: 'inProgress',
        callId: p.call_id,
        computerUse: isComputerUseCall(p) || undefined,
        image: imagePath
          ? { id: p.call_id ?? id, name: path.basename(imagePath.replaceAll('\\', '/')) }
          : undefined,
      };
    }
    if (p.type === 'reasoning') {
      const text = textOf(p.summary);
      return text ? { id, kind: 'reasoning', text, timestamp } : null;
    }
  }
  if (record.type === 'event_msg' && p.type === 'item_completed')
    return normalizeItem(p.item, p.item.id ?? id, timestamp, p.turn_id);
  if (record.type === 'event_msg' && p.type === 'user_message')
    return { id, kind: 'user', text: textOf(p.message), timestamp };
  if (
    record.type === 'event_msg' &&
    ['task_complete', 'task_completed', 'turn_aborted', 'context_compacted'].includes(p.type)
  )
    return {
      id,
      kind: 'system',
      text:
        p.type === 'turn_aborted'
          ? '执行已中断'
          : p.type === 'context_compacted'
            ? '上下文已压缩'
            : '本轮执行完成',
      timestamp,
    };
  return null;
}
