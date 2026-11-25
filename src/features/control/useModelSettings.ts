import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { CodexModel, ReasoningEffort, SessionModelSettings } from '../../types';
import { workspaceUrl } from '../../workspace-scope';

export function useModelSettings(enabled: boolean, scope: string, refresh: number, workspaceId?: string) {
  const [models, setModels] = useState<CodexModel[]>([]),
    [model, setModel] = useState(''),
    [thinking, setThinking] = useState<ReasoningEffort | ''>(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const reset = () => {
    setModel('');
    setThinking('');
  };
  useEffect(() => {
    reset();
  }, [scope, workspaceId]);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const route = '/api/control/models';
    api<{ available: boolean; models: CodexModel[]; reason?: string }>(workspaceId ? workspaceUrl(route, workspaceId) : route, {
      signal: controller.signal,
    })
      .then((result) => {
        if (stopped) return;
        setModels(result.models);
        if (!result.available || !result.models.length) setError(result.reason || '暂无可选模型');
      })
      .catch((error) => {
        if (!stopped) setError(error.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [enabled, scope, refresh, workspaceId]);
  const selectModel = (value: string) => {
    setModel(value);
    setThinking('');
  };
  const overrides: SessionModelSettings = {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
  return {
    models,
    model,
    selectModel,
    thinking,
    setThinking,
    loading,
    error,
    reset,
    overrides,
    selectedModel: models.find((option) => option.model === model),
  };
}
