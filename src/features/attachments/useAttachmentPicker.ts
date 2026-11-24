import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { api, apiBlob } from '../../api';
import { workspaceSignal, workspaceUrl } from '../../workspace-scope';
import type { WorkspaceSession } from '../workspace/session-list-model';
import { maxAttachments, maxBytes } from './attachment-model';
import type { Attachment } from './types';

type AttachmentPickerOptions = {
  attachments: Attachment[];
  disabled: boolean;
  onAdd: (attachment: Attachment, prompt?: string) => void;
  onRemove: (id: string) => void;
  onBusy: (busy: boolean) => void;
  onError: (error: string) => void;
};

type PendingFile =
  File | { name: string; load: (signal: AbortSignal) => Promise<File>; prompt?: string };

function transferFiles(data: DataTransfer) {
  const files = Array.from(data.files);
  if (!files.length) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

const hasFiles = (data: DataTransfer) => Array.from(data.types).includes('Files');

export function useAttachmentPicker({
  attachments,
  disabled,
  onAdd,
  onRemove,
  onBusy,
  onError,
}: AttachmentPickerOptions) {
  const input = useRef<HTMLInputElement>(null);
  const lifetime = useRef(new AbortController());
  const working = useRef(false);
  const queue = useRef<PendingFile[]>([]);
  const reservedCount = useRef(attachments.length);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  async function enqueue(files: PendingFile[]) {
    if (!files.length) return;
    if (disabled) return '当前无法添加附件，请稍后再试。';
    const fail = (message: string) => {
      onError(message);
      return message;
    };
    if (working.current && (!queue.current.length || 'load' in queue.current[0])) {
      return fail('正在处理附件，请稍后再试。');
    }
    if (!working.current) reservedCount.current = attachments.length;
    if (reservedCount.current + files.length > maxAttachments) {
      return fail('每条消息最多添加 10 个附件。');
    }
    if (files.some((file) => 'size' in file && file.size > maxBytes)) {
      return fail('单个附件不能超过 20 MB。');
    }
    // Reserve space for pending files so pasted and dropped files share the same limit.
    reservedCount.current += files.length;
    queue.current.push(...files);
    onError('');
    if (working.current) return;
    working.current = true;
    onBusy(true);
    // Keep both the export and upload bound to the composer that started them.
    const signal = workspaceSignal('/api/uploads', lifetime.current.signal)!;
    const uploadUrl = workspaceUrl('/api/uploads');
    try {
      while (queue.current.length) {
        const pending = queue.current[0];
        if ('load' in pending) setProgress(`正在导出会话 ${pending.name}`);
        const file = 'load' in pending ? await pending.load(signal) : pending;
        signal.throwIfAborted();
        if (file.size > maxBytes) throw new Error('单个附件不能超过 20 MB。');
        setProgress(`正在上传 ${file.name}（剩余 ${queue.current.length} 个）`);
        const attachment = await api<Attachment>(
          uploadUrl + '?name=' + encodeURIComponent(file.name),
          {
            method: 'POST',
            signal,
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Upload-Type': file.type || 'application/octet-stream',
            },
            body: file,
          },
        );
        signal.throwIfAborted();
        onAdd(attachment, 'load' in pending ? pending.prompt : undefined);
        queue.current.shift();
      }
    } catch (error) {
      if (!signal.aborted) return fail((error as Error).message);
      return '已取消添加附件。';
    } finally {
      queue.current = [];
      working.current = false;
      if (!signal.aborted) {
        setProgress('');
        onBusy(false);
      }
    }
  }
  const upload = (files: File[]) => enqueue(files);
  const reference = (session: WorkspaceSession, prompt?: string) => {
    if (working.current) return Promise.resolve('正在处理附件，请稍后再试。');
    const name =
      `会话-${session.workspaceName}-${session.title}`
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
        .slice(0, 130) + '.md';
    return enqueue([
      {
        name: session.title,
        prompt,
        load: async (signal) => {
          const content = await apiBlob(
            workspaceUrl(
              `/api/sessions/${encodeURIComponent(session.id)}/export`,
              session.workspaceId,
            ),
            { signal },
          );
          return new File([content], name, { type: 'text/markdown' });
        },
      },
    ]);
  };
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled) return;
    const files = transferFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    void upload(files);
  }
  function dragEnter(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current++;
    if (!disabled) setDragging(true);
  }
  function dragOver(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }
  function dragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }
  function drop(event: DragEvent<HTMLElement>) {
    dragDepth.current = 0;
    setDragging(false);
    const files = transferFiles(event.dataTransfer);
    if (!files.length && !hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    void upload(files);
  }
  async function remove(id: string) {
    if (disabled || working.current) return;
    working.current = true;
    onBusy(true);
    onError('');
    try {
      await api(`/api/uploads/${id}`, { method: 'DELETE', signal: lifetime.current.signal });
      onRemove(id);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      working.current = false;
      onBusy(false);
    }
  }

  return {
    input,
    progress,
    upload,
    reference,
    paste,
    dragging: dragging && !disabled,
    dragEnter,
    dragOver,
    dragLeave,
    drop,
    remove,
  };
}
