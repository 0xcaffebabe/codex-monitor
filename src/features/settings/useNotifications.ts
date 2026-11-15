import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../../api';
import type { NotificationDelivery, NotificationSettings } from '../../types';

type NotificationState = { settings: NotificationSettings; deliveries: NotificationDelivery[] };

export function useNotifications(notify: (message: string) => void) {
  const [saved, setSaved] = useState<NotificationSettings>();
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const apply = useCallback((state: NotificationState, reset = false) => {
    setSaved(state.settings);
    setDeliveries(state.deliveries);
    if (reset) {
      setEnabled(state.settings.enabled);
      setPublicUrl(state.settings.publicUrl);
      setWebhookUrl('');
      setSigningSecret('');
      setClearSecret(false);
    }
  }, []);
  const refresh = useCallback(
    async (reset = false, signal?: AbortSignal) => {
      try {
        const state = await api<NotificationState>('/api/notifications', { signal });
        apply(state, reset);
      } catch (error) {
        if (!signal?.aborted) setError((error as Error).message);
      }
    },
    [apply],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(true, controller.signal);
    const timer = setInterval(() => void refresh(false, controller.signal), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  const dirty =
    !!saved &&
    (enabled !== saved.enabled ||
      publicUrl !== saved.publicUrl ||
      !!webhookUrl ||
      !!signingSecret ||
      clearSecret);
  async function save() {
    setPending('save');
    setError('');
    try {
      const state = await api<NotificationState>('/api/notifications', {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          provider: 'lark',
          publicUrl: publicUrl.trim(),
          ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
          ...(clearSecret
            ? { signingSecret: '' }
            : signingSecret.trim()
              ? { signingSecret: signingSecret.trim() }
              : {}),
        }),
      });
      apply(state, true);
      notify('通知配置已保存');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending('');
    }
  }
  async function sendTest() {
    setPending('test');
    setError('');
    try {
      apply(await post<NotificationState>('/api/notifications/test'));
      notify('测试通知已发送至飞书/Lark');
    } catch (error) {
      setError((error as Error).message);
      await refresh();
    } finally {
      setPending('');
    }
  }
  return {
    saved,
    deliveries,
    enabled,
    setEnabled,
    webhookUrl,
    setWebhookUrl,
    signingSecret,
    setSigningSecret,
    clearSecret,
    setClearSecret,
    publicUrl,
    setPublicUrl,
    pending,
    error,
    dirty,
    save,
    sendTest,
  };
}
