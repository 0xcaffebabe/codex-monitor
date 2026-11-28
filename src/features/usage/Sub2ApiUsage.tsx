import { ArrowLeft, ArrowRight, RefreshCw, Search } from 'lucide-react';
import { useId, useState } from 'react';
import type { Sub2ApiAccount, Sub2ApiCredits, Sub2ApiKeyUsage } from '../../sub2api-types';
import { Sub2ApiSettings as Sub2ApiSettingsForm } from '../settings/Sub2ApiSettings';
import { integer, money } from './format';
import { Sub2ApiCallFilters, Sub2ApiCallRecords } from './Sub2ApiCallRecords';
import { useSub2ApiAccountDetails, useSub2ApiUsage, type Sub2ApiView } from './useSub2ApiUsage';

const emptyMessage: Record<Sub2ApiView, string> = {
  accounts: '未找到订阅账号',
  keys: '所选区间未找到有调用记录的 Key',
  calls: '所选条件下暂无调用记录',
};

const tokenCount = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
});

function timestamp(value: string | null, includeYear = false) {
  const epoch = value ? Date.parse(value) : NaN;
  return Number.isFinite(epoch)
    ? new Date(epoch).toLocaleString('zh-CN', {
        year: includeYear ? 'numeric' : undefined,
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : null;
}

function creditBalance(credits: Sub2ApiCredits | null) {
  if (!credits) return '暂无点数数据';
  if (credits.unlimited) return '不限量';
  if (credits.balance !== null) return `${credits.balance} 点`;
  return credits.hasCredits ? '点数余额未知' : '无可用点数';
}

function AccountDetails({
  accountId,
  platform,
  enabled,
}: {
  accountId: number;
  platform: 'openai' | 'anthropic';
  enabled: boolean;
}) {
  const { data, error } = useSub2ApiAccountDetails(accountId, platform, enabled);
  if (error)
    return (
      <span className="sub2api-credits" role="alert">
        {error}
      </span>
    );
  const resetCredits = data?.resetCredits;
  let resetLabel = data ? '暂无重置卡数据' : '正在查询重置卡…';
  if (resetCredits) {
    const available = integer(resetCredits.available);
    resetLabel =
      resetCredits.remaining === null
        ? `重置卡可用 ${available} 次`
        : `重置卡剩余 ${integer(resetCredits.remaining)} 次 · 当前可用 ${available} 次`;
  }
  const resetStatus = (
    <span role="status" aria-label="重置卡">
      {resetLabel}
    </span>
  );
  const expirations = resetCredits?.expirations ?? [];
  return (
    <>
      {platform === 'openai' && (
        <span className="sub2api-credits" role="status" aria-label="点数余额">
          {data ? creditBalance(data.credits) : '正在查询点数…'}
        </span>
      )}
      {expirations.length > 0 ? (
        <details className="sub2api-credits sub2api-reset-details">
          <summary>{resetStatus}</summary>
          <ul aria-label="重置卡过期时间">
            {expirations.map((expiresAt, index) => (
              <li key={index}>
                <time dateTime={expiresAt}>{timestamp(expiresAt, true)}</time> 过期
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <div className="sub2api-credits">{resetStatus}</div>
      )}
    </>
  );
}

function AccountRows({
  items,
  accountType,
  loadDetails,
}: {
  items: Sub2ApiAccount[];
  accountType: string;
  loadDetails: boolean;
}) {
  const stateLabels: Record<string, string> = {
    active: '正常',
    inactive: '停用',
    disabled: '停用',
    error: '异常',
  };
  return items.map((account) => (
    <tr key={account.id}>
      <td>
        <strong>{account.name}</strong>
        <small>
          {account.platform} · #{account.id} · {stateLabels[account.status] ?? account.status}
        </small>
        {(account.platform === 'openai' ||
          (account.platform === 'anthropic' && accountType === 'oauth')) && (
          <AccountDetails
            accountId={account.id}
            platform={account.platform}
            enabled={loadDetails}
          />
        )}
      </td>
      <td>
        <div className="sub2api-quotas">
          {account.quotas.map((quota) => {
            const reset = timestamp(quota.resetsAt);
            const { requests, tokens } = quota;
            return (
              <div className="sub2api-quota" key={quota.label}>
                <span>{quota.label}</span>
                <b>
                  {quota.usedPercent === null
                    ? '未知'
                    : `${quota.usedPercent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`}
                </b>
                {quota.usedPercent !== null && (
                  <progress
                    aria-label={`${quota.label}已用比例`}
                    max={100}
                    value={Math.min(100, Math.max(0, quota.usedPercent))}
                  />
                )}
                {reset && <small>{reset} 重置</small>}
                {(requests !== null || tokens !== null) && (
                  <small title={tokens === null ? undefined : `${integer(tokens)} Token`}>
                    {[
                      requests === null ? null : `${integer(requests)} 次`,
                      tokens === null ? null : `${tokenCount.format(tokens)} Token`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                )}
              </div>
            );
          })}
          {account.quotaUnavailable && (
            <span className="muted">
              {account.quotas.length ? '部分额度暂不可用' : '额度暂不可用'}
            </span>
          )}
          {!account.quotaUnavailable && !account.quotas.length && (
            <span className="muted">暂无额度快照</span>
          )}
        </div>
      </td>
      <td>{timestamp(account.updatedAt) ?? '-'}</td>
    </tr>
  ));
}

function KeyRows({ items }: { items: Sub2ApiKeyUsage[] }) {
  return items.map((key) => (
    <tr key={key.id}>
      <td>
        <strong>{key.name || `#${key.id}`}</strong>
        {key.name && <small>#{key.id}</small>}
      </td>
      <td>{integer(key.requests)}</td>
      <td title={integer(key.tokens)}>{tokenCount.format(key.tokens)}</td>
      <td className="usage-cost">{key.actualCost === null ? '-' : money(key.actualCost, 4)}</td>
    </tr>
  ));
}

export function Sub2ApiUsage({
  id,
  revision = 0,
  openSettings,
}: {
  id?: string;
  revision?: number;
  openSettings?: () => void;
}) {
  const titleId = useId();
  const [configuring, setConfiguring] = useState(false);
  const {
    view,
    page,
    draftSearch,
    setDraftSearch,
    accountType,
    days,
    callFilters,
    generation,
    settings,
    configured,
    accounts,
    keys,
    calls,
    result,
    busy,
    error,
    nextPage,
    show,
    refresh,
    submitSearch,
    selectAccountType,
    selectDays,
    applyCallFilters,
    previous,
    next,
  } = useSub2ApiUsage(revision);

  return (
    <section
      id={id}
      className="usage-card sub2api-usage"
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      <div className="usage-section-heading sub2api-heading">
        <h2 id={titleId}>Sub2API 用量</h2>
        {(configured || error) && (
          <button
            className="icon-button"
            title="刷新 Sub2API 用量"
            aria-label="刷新 Sub2API 用量"
            disabled={busy}
            onClick={refresh}
          >
            <RefreshCw size={16} className={busy ? 'spin' : ''} />
          </button>
        )}
      </div>
      {error && (
        <div className="alert error sub2api-message" role="alert">
          {error}
        </div>
      )}
      {!configured && !error && (
        <div className="sub2api-message">
          {settings.busy ? (
            <span role="status">正在读取 Sub2API 配置…</span>
          ) : configuring ? (
            <Sub2ApiSettingsForm
              onChange={() => {
                setConfiguring(false);
                refresh();
              }}
            />
          ) : (
            <button
              type="button"
              className="secondary"
              onClick={openSettings ?? (() => setConfiguring(true))}
            >
              配置 Sub2API
            </button>
          )}
        </div>
      )}
      {configured && (
        <>
          <div className="sub2api-toolbar">
            <div className="sub2api-views" role="group" aria-label="Sub2API 用量视图">
              <button
                type="button"
                aria-pressed={view === 'accounts'}
                onClick={() => show('accounts')}
              >
                订阅账号
              </button>
              <button type="button" aria-pressed={view === 'keys'} onClick={() => show('keys')}>
                API Key
              </button>
              <button type="button" aria-pressed={view === 'calls'} onClick={() => show('calls')}>
                调用记录
              </button>
            </div>
            {view !== 'calls' && (
              <form
                className="sub2api-filters"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitSearch();
                }}
              >
                {view === 'accounts' ? (
                  <select
                    aria-label="订阅账号类型"
                    value={accountType}
                    onChange={(event) => selectAccountType(event.target.value)}
                  >
                    <option value="oauth">OAuth</option>
                    <option value="setup-token">Setup Token</option>
                  </select>
                ) : (
                  <select
                    aria-label="Sub2API Key 统计时间范围"
                    value={days}
                    onChange={(event) => selectDays(event.target.value)}
                  >
                    <option value="1">今天</option>
                    <option value="7">近 7 天</option>
                    <option value="30">近 30 天</option>
                  </select>
                )}
                <input
                  type="search"
                  aria-label={view === 'accounts' ? '订阅账号名称' : 'Key 名称或 #ID'}
                  placeholder={view === 'accounts' ? '订阅账号名称' : 'Key 名称或 #ID'}
                  value={draftSearch}
                  maxLength={100}
                  onChange={(event) => setDraftSearch(event.target.value)}
                />
                <button
                  className="icon-button"
                  title="查询 Sub2API 用量"
                  aria-label="查询 Sub2API 用量"
                >
                  <Search size={16} />
                </button>
              </form>
            )}
          </div>
          {view === 'calls' && (
            <Sub2ApiCallFilters filters={callFilters} onApply={applyCallFilters} />
          )}
          {result.data?.warning && (
            <p className="usage-warning sub2api-message" role="status">
              {result.data.warning}
            </p>
          )}
          {result.busy && (
            <p className="sub2api-message muted" role="status">
              正在查询 Sub2API…
            </p>
          )}
          {result.data &&
            !result.data.items.length &&
            (view !== 'calls' || !result.data.warning) && (
              <p className="sub2api-message muted">{emptyMessage[view]}</p>
            )}
          {view === 'calls' && !!calls.data?.items.length && (
            <Sub2ApiCallRecords items={calls.data.items} />
          )}
          {view !== 'calls' && !!result.data?.items.length && (
            <div className="usage-table-scroll">
              <table
                className="sub2api-table"
                aria-label={view === 'accounts' ? '订阅账号用量' : 'API Key 用量'}
              >
                <thead>
                  {view === 'accounts' ? (
                    <tr>
                      <th scope="col">账号</th>
                      <th scope="col">额度已用</th>
                      <th scope="col">快照时间</th>
                    </tr>
                  ) : (
                    <tr>
                      <th scope="col">API Key</th>
                      <th scope="col">请求数</th>
                      <th scope="col">Token</th>
                      <th scope="col">实际扣费</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {view === 'accounts' ? (
                    <AccountRows
                      key={generation}
                      items={accounts.data?.items ?? []}
                      accountType={accountType}
                      loadDetails={!busy}
                    />
                  ) : (
                    <KeyRows items={keys.data?.items ?? []} />
                  )}
                </tbody>
              </table>
            </div>
          )}
          {(page > 1 || nextPage) && (
            <div className="usage-pagination">
              <span>
                第 {page} 页
                {result.data && view !== 'calls' ? ` · ${integer(result.data.total)} 条` : ''}
              </span>
              <button
                className="icon-button"
                title="Sub2API 上一页"
                aria-label="Sub2API 上一页"
                disabled={page === 1 || busy}
                onClick={previous}
              >
                <ArrowLeft size={16} />
              </button>
              <button
                className="icon-button"
                title="Sub2API 下一页"
                aria-label="Sub2API 下一页"
                disabled={!nextPage || busy}
                onClick={next}
              >
                <ArrowRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
