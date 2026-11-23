import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../../api';
import type { NotificationDelivery, NotificationSettings } from '../../types';

type NotificationState = { settings: NotificationSettings; deliveries: NotificationDelivery[] };
const defaultApp = { appRegion: 'lark', appId: '', appSecret: '', chatId: '' } as const;

export function useNotifications(notify: (message: string) => void) {
  const [saved, setSaved] = useState<NotificationSettings>();
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [completionMode, setCompletionMode] =
    useState<NotificationSettings['completionMode']>('watched');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [mode, setMode] = useState<NotificationSettings['mode']>('webhook');
  const [app, setApp] = useState<{
    appRegion: NotificationSettings['appRegion'];
    appId: string;
    appSecret: string;
    chatId: string;
  }>(defaultApp);
  const [clearAppSecret, setClearAppSecret] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const apply = useCallback((state: NotificationState, reset = false) => {
    setSaved(state.settings);
    setDeliveries(state.deliveries);
    if (reset) {
      setEnabled(state.settings.enabled);
      setCompletionMode(state.settings.completionMode ?? 'watched');
      setPublicUrl(state.settings.publicUrl);
      setWebhookUrl('');
      setSigningSecret('');
      setClearSecret(false);
      setMode(state.settings.mode ?? 'webhook');
      setApp({
        appRegion: state.settings.appRegion ?? 'lark',
        appId: state.settings.appId ?? '',
        appSecret: '',
        chatId: state.settings.chatId ?? '',
      });
      setClearAppSecret(false);
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
      completionMode !== (saved.completionMode ?? 'watched') ||
      publicUrl !== saved.publicUrl ||
      mode !== (saved.mode ?? 'webhook') ||
      (mode === 'webhook'
        ? !!webhookUrl.trim() || !!signingSecret.trim() || clearSecret
        : app.appRegion !== saved.appRegion ||
          app.appId !== saved.appId ||
          app.chatId !== saved.chatId ||
          !!app.appSecret.trim() ||
          clearAppSecret));
  async function save() {
    setPending('save');
    setError('');
    try {
      const state = await api<NotificationState>('/api/notifications', {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          provider: 'lark',
          mode,
          completionMode,
          publicUrl: publicUrl.trim(),
          ...(mode === 'app'
            ? {
                appRegion: app.appRegion,
                appId: app.appId.trim(),
                chatId: app.chatId.trim(),
                ...(clearAppSecret || app.appSecret.trim()
                  ? { appSecret: clearAppSecret ? '' : app.appSecret.trim() }
                  : {}),
              }
            : {
                ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
                ...(clearSecret || signingSecret.trim()
                  ? { signingSecret: clearSecret ? '' : signingSecret.trim() }
                  : {}),
              }),
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
    completionMode,
    setCompletionMode,
    webhookUrl,
    setWebhookUrl,
    signingSecret,
    setSigningSecret,
    clearSecret,
    setClearSecret,
    mode,
    setMode,
    app,
    setApp,
    clearAppSecret,
    setClearAppSecret,
    testConfigured:
      mode === 'app'
        ? !!(saved?.appId && saved.appSecretConfigured && saved.chatId)
        : !!saved?.webhookConfigured,
    publicUrl,
    setPublicUrl,
    pending,
    error,
    dirty,
    save,
    sendTest,
  };
}
