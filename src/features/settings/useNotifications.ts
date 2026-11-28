import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../../api';
import type { LarkStartSettings, NotificationDelivery, NotificationSettings } from '../../types';

type NotificationState = { settings: NotificationSettings; deliveries: NotificationDelivery[] };
const defaultApp = { appRegion: 'lark', appId: '', appSecret: '', replyOpenIds: '' } as const;
const emptyLarkStart: LarkStartSettings = { defaultAlias: '', targets: [] };

export function useNotifications(notify: (message: string) => void) {
  const [saved, setSaved] = useState<NotificationSettings>();
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [completionMode, setCompletionMode] =
    useState<NotificationSettings['completionMode']>('watched');
  const [app, setApp] = useState<{
    appRegion: NotificationSettings['appRegion'];
    appId: string;
    appSecret: string;
    replyOpenIds: string;
  }>(defaultApp);
  const [clearAppSecret, setClearAppSecret] = useState(false);
  const [larkStart, setLarkStart] = useState(emptyLarkStart);
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
      setApp({
        appRegion: state.settings.appRegion ?? 'lark',
        appId: state.settings.appId ?? '',
        appSecret: '',
        replyOpenIds: state.settings.replyOpenIds?.join(', ') ?? '',
      });
      setClearAppSecret(false);
      setLarkStart(state.settings.larkStart ?? emptyLarkStart);
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
      app.appRegion !== saved.appRegion ||
      app.appId !== saved.appId ||
      app.replyOpenIds !== saved.replyOpenIds.join(', ') ||
      JSON.stringify(larkStart) !== JSON.stringify(saved.larkStart) ||
      !!app.appSecret.trim() ||
      clearAppSecret);
  async function save() {
    setPending('save');
    setError('');
    try {
      const state = await api<NotificationState>('/api/notifications', {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          provider: 'lark',
          completionMode,
          publicUrl: publicUrl.trim(),
          appRegion: app.appRegion,
          appId: app.appId.trim(),
          replyOpenIds: app.replyOpenIds.split(/[\s,，]+/).filter(Boolean),
          larkStart,
          ...(clearAppSecret || app.appSecret.trim()
            ? { appSecret: clearAppSecret ? '' : app.appSecret.trim() }
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
    completionMode,
    setCompletionMode,
    app,
    setApp,
    larkStart,
    setLarkStart,
    clearAppSecret,
    setClearAppSecret,
    testConfigured: !!(saved?.appId && saved.appSecretConfigured && saved.replyOpenIds.length),
    publicUrl,
    setPublicUrl,
    pending,
    error,
    dirty,
    save,
    sendTest,
  };
}
