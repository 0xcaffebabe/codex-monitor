import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError, post } from '../../api';
import { useAttachmentPicker } from '../attachments/useAttachmentPicker';
import { newRequestId } from './request-id';
import type { Draft, Receipt } from './types';
import { workspaceStorageKey } from '../../workspace-scope';

export type PromptFormProps = {
  storageKey: string;
  url: string;
  extra?: object;
  label: string;
  enabled: boolean;
  onAccepted: (receipt: Receipt) => void;
  children?: React.ReactNode;
  inputLabel?: string;
  autoFocus?: boolean;
  submitOnEnter?: boolean;
  maxLength?: number;
  allowAttachments?: boolean;
  attachmentControls?: React.ReactNode;
  submitActions?: React.ReactNode;
  initialPrompt?: string;
  allowGoal?: boolean;
};
export function usePromptForm({
  storageKey: unscopedKey,
  url,
  extra,
  enabled,
  onAccepted,
  initialPrompt = '',
  allowAttachments = false,
  allowGoal = false,
  maxLength = 12000,
}: PromptFormProps) {
  const storageKey = workspaceStorageKey(unscopedKey);
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      const saved: Draft | undefined = stored ? JSON.parse(stored) : undefined;
      return saved && (saved.prompt || saved.requestId || saved.attachments?.length || saved.asGoal)
        ? saved
        : { prompt: initialPrompt };
    } catch {
      return { prompt: initialPrompt };
    }
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(draft.creation?.goalError || ''),
    [notice, setNotice] = useState(draft.creation?.message || ''),
    [queueState, setQueueState] = useState(''),
    [uploadBusy, setUploadBusy] = useState(false);
  const submitting = useRef(false);
  const uploading = useRef(false);
  const attachments = draft.attachments ?? [];
  const goalCommand = allowGoal && /^\/goal(?:\s|$)/.test(draft.prompt.trimStart());
  const asGoal = allowGoal && (!!draft.asGoal || goalCommand);
  const objective = goalCommand ? draft.prompt.trimStart().slice(5).trim() : draft.prompt.trim();
  const characterLimit = asGoal ? 4000 : maxLength;
  const characterCount = asGoal ? objective.length : draft.prompt.length;
  const validationError =
    characterCount > characterLimit
      ? `${asGoal ? '目标' : '消息'}最多 ${characterLimit} 字符，请缩短内容。`
      : '';
  const hasContent = asGoal ? !!objective : !!draft.prompt.trim() || !!attachments.length;
  const canSubmit = !!enabled && hasContent && !validationError;
  const attachmentPicker = useAttachmentPicker({
    attachments,
    disabled: !allowAttachments || busy || !!draft.requestId || !enabled,
    onAdd: (attachment) =>
      setDraft((previous) => ({
        ...previous,
        attachments: [...(previous.attachments ?? []), attachment],
      })),
    onRemove: (id) =>
      setDraft((previous) => ({
        ...previous,
        attachments: previous.attachments?.filter((attachment) => attachment.id !== id),
      })),
    onBusy: (value) => {
      uploading.current = value;
      setUploadBusy(value);
    },
    onError: setError,
  });
  const currentRequest = useRef(draft.requestId);
  currentRequest.current = draft.requestId;
  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft, storageKey]);
  function accept(result: Receipt) {
    if (result.requestId && result.requestId !== currentRequest.current) return false;
    if (
      result.mode === 'create' &&
      result.threadId &&
      result.goalState &&
      result.goalState !== 'saved'
    ) {
      setDraft((previous) => ({ ...previous, creation: result, queued: undefined }));
      setQueueState('');
      setError(result.goalError || '');
      setNotice(result.message || '会话已创建，请确认目标保存结果。');
      return false;
    }
    if (result.state === 'queued' || result.state === 'pending') {
      setDraft((previous) => (previous.requestId ? { ...previous, queued: true } : previous));
      setQueueState(result.state);
      setError('');
      setNotice(result.message || '消息已排队，等待压缩完成后自动发送。');
      return false;
    }
    if (result.state === 'cancelled') {
      currentRequest.current = undefined;
      setDraft((previous) => ({ ...previous, requestId: undefined, queued: undefined }));
      setQueueState('');
      setError('');
      setNotice('已取消排队，消息未发送。');
      return false;
    }
    if (result.state === 'succeeded' && result.threadId) {
      currentRequest.current = undefined;
      setDraft({ prompt: '' });
      sessionStorage.removeItem(storageKey);
      setError('');
      setQueueState('');
      setNotice(
        result.message ||
          (result.mode === 'append'
            ? 'Codex 已接收追加消息'
            : result.mode === 'create'
              ? '会话已创建'
              : 'Codex 已接收消息'),
      );
      onAccepted(result);
      return true;
    }
    setQueueState('');
    setNotice('');
    if (result.state === 'failed') currentRequest.current = undefined;
    setDraft((previous) =>
      result.state === 'failed'
        ? { ...previous, requestId: undefined, queued: undefined }
        : { ...previous, queued: false },
    );
    setError(result.error || '结果待确认，请核对会话记录，勿重复发送。');
    return false;
  }
  async function submit() {
    if (submitting.current || uploading.current || !canSubmit || draft.requestId) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const requestId = newRequestId(),
      payload = {
        prompt: draft.prompt,
        attachments: draft.attachments,
        requestId,
        // Ordinary creation must remain compatible with clients predating goal creation.
        ...(asGoal ? { asGoal: true } : {}),
      };
    currentRequest.current = requestId;
    // Persist the ID before the request, so a reload never repeats an uncertain send.
    sessionStorage.setItem(storageKey, JSON.stringify(payload));
    setDraft(payload);
    try {
      accept(
        await post<Receipt>(url, {
          ...extra,
          ...payload,
          attachments: payload.attachments?.map((attachment) => attachment.id),
        }),
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.state === 'failed' || [400, 401, 403, 404, 413].includes(error.status))
      )
        setDraft((previous) => ({ ...previous, requestId: undefined, queued: undefined }));
      setError((error as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (!draft.requestId || busy) return;
    setBusy(true);
    try {
      accept(await api<Receipt>('/api/control/requests/' + draft.requestId));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        if (draft.creation?.threadId) setError('找不到创建回执，请打开已创建会话核对目标。');
        else {
          setDraft((previous) => ({ ...previous, requestId: undefined, queued: undefined }));
          setError('服务器没有记录该请求，可以重新发送。');
        }
      } else setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retryGoal() {
    if (!draft.requestId || !draft.creation || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      accept(await post<Receipt>(`/api/control/requests/${draft.requestId}/goal`));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function setAsGoal(value: boolean) {
    setDraft((previous) => ({
      ...previous,
      asGoal: value,
      prompt:
        !value && /^\/goal(?:\s|$)/.test(previous.prompt.trimStart())
          ? previous.prompt.trimStart().slice(5).trimStart()
          : previous.prompt,
    }));
  }
  function reset() {
    currentRequest.current = undefined;
    setDraft({ prompt: '' });
    setError('');
    setNotice('');
    setQueueState('');
  }
  useEffect(() => {
    if (!draft.requestId || !draft.queued) return;
    const requestId = draft.requestId;
    const controller = new AbortController();
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<Receipt>('/api/control/requests/' + requestId, {
          signal: controller.signal,
        });
        if (!stopped && currentRequest.current === requestId) accept(result);
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.status === 404) {
          setDraft((previous) => ({ ...previous, requestId: undefined, queued: undefined }));
          setError('服务器没有记录该请求，可以重新发送。');
          setNotice('');
        } else setNotice('暂时无法查询队列，连接恢复后会继续查询，请勿重复发送。');
      } finally {
        if (!stopped) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft.requestId, draft.queued]);
  async function cancelQueued() {
    if (!draft.requestId || busy) return;
    setBusy(true);
    try {
      accept(await post<Receipt>(`/api/control/requests/${draft.requestId}/cancel`));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return {
    draft,
    setDraft,
    busy,
    error,
    setError,
    notice,
    queueState,
    uploadBusy,
    attachments,
    attachmentPicker,
    submit,
    check,
    cancelQueued,
    asGoal,
    setAsGoal,
    characterLimit,
    characterCount,
    validationError,
    canSubmit,
    retryGoal,
    reset,
    openCreated: () => draft.creation && onAccepted(draft.creation),
  };
}
