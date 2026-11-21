import { RotateCcw, Search } from 'lucide-react';
import { useState } from 'react';
import type { Sub2ApiCallRecord } from '../../sub2api-types';
import { dateKey, integer, money } from './format';

const requestTypes = new Map([
  ['sync', '同步'],
  ['stream', '流式'],
  ['ws_v2', 'WebSocket'],
  ['live', '实时'],
  ['cyber', 'Cyber'],
]);
const billingModes = new Map([
  ['token', '按量'],
  ['per_request', '按次'],
  ['image', '图片'],
  ['video', '视频'],
]);
const billingTypes = new Map([
  ['0', '余额'],
  ['1', '订阅'],
]);
const idFields = [
  ['userId', '用户 ID'],
  ['accountId', '账号 ID'],
  ['groupId', '分组 ID'],
] as const;

export function defaultCallRecordFilters() {
  const today = dateKey(new Date());
  return {
    startDate: today,
    endDate: today,
    apiKey: '',
    model: '',
    requestType: '',
    billingMode: '',
    billingType: '',
    userId: '',
    accountId: '',
    groupId: '',
  };
}

export type CallRecordFilters = ReturnType<typeof defaultCallRecordFilters>;

export function Sub2ApiCallFilters({
  filters,
  onApply,
}: {
  filters: CallRecordFilters;
  onApply: (filters: CallRecordFilters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const [dateError, setDateError] = useState('');

  function change(key: keyof CallRecordFilters, value: string) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setDateError('');
  }

  return (
    <form
      className="sub2api-call-filters"
      aria-label="筛选 Sub2API 调用记录"
      onSubmit={(event) => {
        event.preventDefault();
        const span = Date.parse(draft.endDate) - Date.parse(draft.startDate);
        if (span < 0 || span >= 31 * 86400000) {
          setDateError('结束日期不能早于开始日期，日期范围最多 31 天。');
          return;
        }
        onApply({ ...draft, apiKey: draft.apiKey.trim(), model: draft.model.trim() });
      }}
      onReset={(event) => {
        event.preventDefault();
        const next = defaultCallRecordFilters();
        setDraft(next);
        setDateError('');
        onApply(next);
      }}
    >
      <div className="sub2api-call-filter-grid">
        <label>
          开始日期
          <input
            type="date"
            required
            value={draft.startDate}
            onChange={(event) => change('startDate', event.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            required
            value={draft.endDate}
            onChange={(event) => change('endDate', event.target.value)}
          />
        </label>
        <label>
          API Key
          <input
            type="search"
            maxLength={100}
            placeholder="名称或 #ID"
            value={draft.apiKey}
            onChange={(event) => change('apiKey', event.target.value)}
          />
        </label>
        <label>
          模型
          <input
            type="search"
            maxLength={100}
            placeholder="模型名称"
            value={draft.model}
            onChange={(event) => change('model', event.target.value)}
          />
        </label>
      </div>
      <details>
        <summary>更多筛选</summary>
        <div className="sub2api-call-filter-grid">
          {idFields.map(([name, label]) => (
            <label key={name}>
              {label}
              <input
                type="text"
                inputMode="numeric"
                pattern="[1-9][0-9]*"
                maxLength={16}
                value={draft[name]}
                onChange={(event) => change(name, event.target.value)}
              />
            </label>
          ))}
          {(
            [
              ['requestType', '请求类型', requestTypes],
              ['billingMode', '计费模式', billingModes],
              ['billingType', '计费类型', billingTypes],
            ] as const
          ).map(([name, label, options]) => (
            <label key={name}>
              {label}
              <select value={draft[name]} onChange={(event) => change(name, event.target.value)}>
                <option value="">全部</option>
                {Array.from(options, ([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </details>
      {dateError && (
        <div className="alert error" role="alert">
          {dateError}
        </div>
      )}
      <div className="sub2api-call-actions">
        <button
          className="icon-button"
          type="reset"
          title="重置调用记录筛选"
          aria-label="重置调用记录筛选"
        >
          <RotateCcw size={16} />
        </button>
        <button className="primary" type="submit">
          <Search size={16} /> 查询记录
        </button>
      </div>
    </form>
  );
}

const callTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

function partyLabel(party: Sub2ApiCallRecord['account']) {
  if (!party) return '—';
  return party.name ? `${party.name} #${party.id}` : `#${party.id}`;
}

function elapsed(ms: number) {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function Sub2ApiCallRecords({ items }: { items: Sub2ApiCallRecord[] }) {
  return (
    <div className="usage-table-scroll">
      <table className="sub2api-table sub2api-call-records" aria-label="Sub2API 调用记录">
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col">API Key / 用户</th>
            <th scope="col">模型 / 端点</th>
            <th scope="col">账号 / 分组</th>
            <th scope="col">Token</th>
            <th scope="col">实际扣费</th>
            <th scope="col">延迟 / IP</th>
          </tr>
        </thead>
        <tbody>
          {items.map((record) => {
            const at = Date.parse(record.createdAt);
            const billing = [
              record.billingMode && (billingModes.get(record.billingMode) ?? record.billingMode),
              record.billingType !== null && billingTypes.get(String(record.billingType)),
            ].filter(Boolean);
            return (
              <tr key={record.id}>
                <td>
                  {Number.isFinite(at) ? (
                    <time dateTime={record.createdAt}>{callTimeFormat.format(at)}</time>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <strong>{partyLabel(record.apiKey)}</strong>
                  <small>{partyLabel(record.user)}</small>
                </td>
                <td>
                  <strong>{record.model || '—'}</strong>
                  {record.upstreamModel && record.upstreamModel !== record.model && (
                    <small>上游模型 {record.upstreamModel}</small>
                  )}
                  {record.inboundEndpoint && <small>入站 {record.inboundEndpoint}</small>}
                  {record.upstreamEndpoint && <small>上游 {record.upstreamEndpoint}</small>}
                  {record.requestType && (
                    <small>{requestTypes.get(record.requestType) ?? record.requestType}</small>
                  )}
                </td>
                <td>
                  <strong>{partyLabel(record.account)}</strong>
                  {record.group && <small>{partyLabel(record.group)}</small>}
                </td>
                <td>
                  <span>输入 {integer(record.inputTokens)}</span>
                  <small>输出 {integer(record.outputTokens)}</small>
                  {record.cacheReadTokens > 0 && (
                    <small>缓存读取 {integer(record.cacheReadTokens)}</small>
                  )}
                  {record.cacheCreationTokens > 0 && (
                    <small>缓存写入 {integer(record.cacheCreationTokens)}</small>
                  )}
                </td>
                <td>
                  <span className="usage-cost">
                    {record.actualCost === null ? '—' : money(record.actualCost, 6)}
                  </span>
                  {billing.length > 0 && <small>{billing.join(' · ')}</small>}
                </td>
                <td>
                  {record.durationMs === null ? '—' : `总耗时 ${elapsed(record.durationMs)}`}
                  {record.firstTokenMs !== null && (
                    <small>首字 {elapsed(record.firstTokenMs)}</small>
                  )}
                  {record.ipAddress && <small>{record.ipAddress}</small>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
