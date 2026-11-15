import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { api } from '../../api';
import { maxAttachments, maxBytes } from './attachment-model';
import type { Attachment } from './types';

type AttachmentPickerOptions = {
  attachments: Attachment[];
  disabled: boolean;
  onAdd: (attachment: Attachment) => void;
  onRemove: (id: string) => void;
  onBusy: (busy: boolean) => void;
  onError: (error: string) => void;
};

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
  const working = useRef(false);
  const queue = useRef<File[]>([]);
  const reservedCount = useRef(attachments.length);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState('');
  async function upload(files: File[]) {
    if (!files.length || disabled) return;
    if (working.current && !queue.current.length) {
      onError('正在移除附件，请稍后再试。');
      return;
    }
    if (!working.current) reservedCount.current = attachments.length;
    if (reservedCount.current + files.length > maxAttachments) {
      onError('每条消息最多添加 10 个附件。');
      return;
    }
    if (files.some((file) => file.size > maxBytes)) {
      onError('单个附件不能超过 20 MB。');
      return;
    }
    // Reserve space for pending files so pasted and dropped files share the same limit.
    reservedCount.current += files.length;
    queue.current.push(...files);
    onError('');
    if (working.current) return;
    working.current = true;
    onBusy(true);
    try {
      while (queue.current.length) {
        const file = queue.current[0];
        setProgress(`正在上传 ${file.name}（剩余 ${queue.current.length} 个）`);
        onAdd(
          await api<Attachment>('/api/uploads?name=' + encodeURIComponent(file.name), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Upload-Type': file.type || 'application/octet-stream',
            },
            body: file,
          }),
        );
        queue.current.shift();
      }
    } catch (error) {
      onError((error as Error).message);
    } finally {
      queue.current = [];
      working.current = false;
      setProgress('');
      onBusy(false);
    }
  }
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
      await api(`/api/uploads/${id}`, { method: 'DELETE' });
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
    paste,
    dragging: dragging && !disabled,
    dragEnter,
    dragOver,
    dragLeave,
    drop,
    remove,
  };
}
