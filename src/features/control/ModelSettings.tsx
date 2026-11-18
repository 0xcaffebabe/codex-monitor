import type { ReasoningEffort } from '../../types';
import type { useModelSettings } from './useModelSettings';
import { Brain, ChevronDown, Cpu, RefreshCw } from 'lucide-react';

const effortLabels: Record<ReasoningEffort, string> = {
  none: '不思考',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '更高',
  max: '最高',
  ultra: '极高',
};

export function modelSettingsSummary(settings: ReturnType<typeof useModelSettings>) {
  const model = settings.selectedModel?.displayName;
  return model && (settings.thinking ? `${model} · ${effortLabels[settings.thinking]}` : model);
}

export function ModelSettings({
  settings,
  prefix,
  onRetry,
  continuing = false,
  compact = false,
}: {
  settings: ReturnType<typeof useModelSettings>;
  prefix: string;
  onRetry: () => void;
  continuing?: boolean;
  compact?: boolean;
}) {
  const defaultLabel = continuing ? '沿用当前会话设置' : '跟随 Codex 默认设置';
  const modelSelect = (
    <select
      aria-label={`${prefix}模型`}
      title={settings.model || defaultLabel}
      value={settings.model}
      disabled={settings.loading || !settings.models.length}
      onChange={(event) => settings.selectModel(event.target.value)}
    >
      <option value="">
        {settings.loading ? '加载模型…' : continuing ? '当前模型' : defaultLabel}
      </option>
      {settings.models.map((option) => (
        <option key={option.model} value={option.model}>
          {option.displayName}
        </option>
      ))}
    </select>
  );
  const thinkingSelect = (
    <select
      aria-label={`${prefix}思考级别`}
      title={
        settings.thinking
          ? `思考级别：${effortLabels[settings.thinking]}`
          : settings.model
            ? defaultLabel
            : '选择模型后可设置思考级别'
      }
      value={settings.thinking}
      disabled={settings.loading || !settings.selectedModel?.supportedReasoningEfforts.length}
      onChange={(event) => settings.setThinking(event.target.value as ReasoningEffort | '')}
    >
      <option value="">
        {continuing ? '思考级别' : settings.model ? defaultLabel : '选择模型后可设置'}
      </option>
      {settings.selectedModel?.supportedReasoningEfforts.map((effort) => (
        <option key={effort} value={effort}>
          {effortLabels[effort]}（{effort}）
        </option>
      ))}
    </select>
  );
  if (continuing || compact)
    return (
      <div className="session-model-settings">
        <span
          className={
            'composer-choice' + (settings.loading || !settings.models.length ? ' is-disabled' : '')
          }
        >
          <Cpu size={15} aria-hidden="true" />
          <span className="composer-choice-label" aria-hidden="true">
            {settings.loading
              ? '加载模型…'
              : settings.selectedModel?.displayName || (continuing ? '当前模型' : '默认模型')}
          </span>
          <ChevronDown size={11} aria-hidden="true" />
          {modelSelect}
        </span>
        <span
          className={
            'composer-choice' +
            (settings.loading || !settings.selectedModel?.supportedReasoningEfforts.length
              ? ' is-disabled'
              : '')
          }
        >
          <Brain size={15} aria-hidden="true" />
          <span className="composer-choice-label" aria-hidden="true">
            {settings.thinking ? effortLabels[settings.thinking] : '思考级别'}
          </span>
          <ChevronDown size={11} aria-hidden="true" />
          {thinkingSelect}
        </span>
        {settings.error && (
          <button
            type="button"
            className="icon-button"
            aria-label="重新加载模型"
            title={`模型列表暂不可用，${continuing ? '可沿用当前会话设置发送' : '可使用默认设置创建'}。${settings.error}`}
            onClick={onRetry}
          >
            <RefreshCw size={13} />
          </button>
        )}
      </div>
    );
  return (
    <>
      <div className="new-session-settings">
        <label className="prompt-label">
          模型
          {modelSelect}
        </label>
        <label className="prompt-label">
          思考级别
          {thinkingSelect}
        </label>
      </div>
      {settings.error && (
        <p className="control-hint" role="status">
          模型列表暂不可用，可使用默认设置创建。
          {settings.error}{' '}
          <button type="button" className="secondary" onClick={onRetry}>
            重新加载
          </button>
        </p>
      )}
    </>
  );
}
