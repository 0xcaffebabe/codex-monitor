import { z } from 'zod';
import type {
  Sub2ApiAccount,
  Sub2ApiCredits,
  Sub2ApiKeyUsage,
  Sub2ApiPage,
  Sub2ApiQuota,
} from '../src/sub2api-types.js';

export type Sub2ApiConnection = { baseUrl: string; adminKey: string };
type DateRange = { startDate: string; endDate: string; timezone: string };
const keyLimit = 500;
const pageSize = 10;

const id = z.number().int().positive();
const accountsPage = z.object({
  items: z.array(z.object({ id, name: z.string(), platform: z.string(), status: z.string() })),
  total: z.number().int().nonnegative(),
  page_size: z.number().int().positive(),
});
const progress = z.object({
  utilization: z.number().nullish(),
  utilization_unknown: z.boolean().optional(),
  resets_at: z.string().nullish(),
  window_stats: z.object({ requests: z.number(), tokens: z.number() }).nullish(),
});
const grokQuota = z.object({
  limit: z.number().positive().nullish(),
  remaining: z.number().nonnegative().nullish(),
  reset_at: z.string().nullish(),
});
const quotaWindows = {
  five_hour: '5 小时',
  seven_day: '7 天',
  seven_day_sonnet: 'Sonnet 7 天',
  seven_day_opus: 'Opus 7 天',
  seven_day_fable: 'Fable 7 天',
  thirty_day: '月度',
  gemini_shared_daily: 'Gemini 每日共享额度',
  gemini_pro_daily: 'Gemini Pro 每日',
  gemini_flash_daily: 'Gemini Flash 每日',
  gemini_shared_minute: 'Gemini 每分钟共享额度',
  gemini_pro_minute: 'Gemini Pro 每分钟',
  gemini_flash_minute: 'Gemini Flash 每分钟',
} as const;
const quotaInfo = z
  .object({
    updated_at: z.string().nullish(),
    error: z.string().optional(),
    error_code: z.string().optional(),
    antigravity_quota_groups: z
      .array(
        z.object({
          key: z.string(),
          windows: z.array(progress.extend({ window: z.string() })),
        }),
      )
      .nullish(),
    antigravity_quota: z
      .record(
        z.string(),
        z
          .object({
            utilization: z.number(),
            reset_time: z.string().nullish(),
          })
          .nullable(),
      )
      .nullish(),
  })
  .loose();
const batchQuota = z.object({
  usage: z.record(z.string(), z.unknown()).nullable(),
  errors: z.record(z.string(), z.unknown()).nullish(),
});
const keyTrend = z.object({
  trend: z
    .array(
      z.object({
        api_key_id: id,
        key_name: z.string(),
        requests: z.number(),
        tokens: z.number(),
      }),
    )
    .nullable(),
});
const keyStats = z.object({
  total_requests: z.number(),
  total_tokens: z.number(),
  total_actual_cost: z.number().nullish(),
});
const openAiQuota = z.object({
  credits: z
    .object({
      balance: z
        .string()
        .regex(/^[+-]?\d+(?:\.\d+)?$/)
        .nullish(),
      has_credits: z.boolean(),
      unlimited: z.boolean(),
    })
    .nullish(),
});

export class Sub2ApiError extends Error {
  constructor(
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

export function sub2ApiBaseUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const basePath = url.pathname.replace(/\/+$/, '').replace(/\/(?:api\/)?v1$/, '');
    return url.origin + basePath;
  } catch {
    return null;
  }
}

async function inBatches<T, R>(items: T[], read: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += 3)
    results.push(...(await Promise.all(items.slice(offset, offset + 3).map(read))));
  return results;
}

function quota(label: string, data: z.infer<typeof progress>): Sub2ApiQuota {
  return {
    label,
    usedPercent: data.utilization_unknown ? null : (data.utilization ?? null),
    resetsAt: data.resets_at || null,
    requests: data.window_stats?.requests ?? null,
    tokens: data.window_stats?.tokens ?? null,
  };
}

function accountQuota(
  value: unknown,
): Pick<Sub2ApiAccount, 'updatedAt' | 'quotas' | 'quotaUnavailable'> {
  const info = quotaInfo.safeParse(value);
  if (!info.success) return { updatedAt: null, quotas: [], quotaUnavailable: true };
  const data = info.data;
  const quotas: Sub2ApiQuota[] = [];
  for (const [key, label] of Object.entries(quotaWindows)) {
    const window = progress.safeParse(data[key]);
    if (window.success) quotas.push(quota(label, window.data));
  }
  for (const group of data.antigravity_quota_groups ?? []) {
    for (const window of group.windows) {
      const period =
        window.window === '5h' ? '5 小时' : window.window === 'weekly' ? '7 天' : window.window;
      quotas.push(quota(`${group.key} ${period}`, window));
    }
  }
  if (!data.antigravity_quota_groups?.length) {
    for (const [model, window] of Object.entries(data.antigravity_quota ?? {})) {
      if (window)
        quotas.push(
          quota(model, { utilization: window.utilization, resets_at: window.reset_time }),
        );
    }
  }
  for (const [field, label] of [
    ['grok_request_quota', 'Grok 请求'],
    ['grok_token_quota', 'Grok Token'],
  ] as const) {
    const window = grokQuota.safeParse(data[field]);
    if (!window.success) continue;
    const { limit, remaining, reset_at } = window.data;
    const used = limit && remaining != null ? Math.max(0, limit - remaining) : null;
    quotas.push({
      label,
      usedPercent: limit && used !== null ? (used / limit) * 100 : null,
      resetsAt: reset_at || null,
      requests: field === 'grok_request_quota' ? used : null,
      tokens: field === 'grok_token_quota' ? used : null,
    });
  }
  return {
    updatedAt: data.updated_at ?? null,
    quotas,
    quotaUnavailable: !!(data.error || data.error_code),
  };
}

export class Sub2ApiClient {
  constructor(
    private connection: Sub2ApiConnection,
    private signal: AbortSignal,
  ) {}

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    query?: Record<string, string>,
    json?: object,
  ): Promise<T> {
    const url = new URL(`${this.connection.baseUrl}/api/v1/admin${path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const timeout = AbortSignal.timeout(12000);
    try {
      const response = await fetch(url, {
        method: json ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          'x-api-key': this.connection.adminKey,
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        body: json ? JSON.stringify(json) : undefined,
        redirect: 'error',
        signal: AbortSignal.any([timeout, this.signal]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        const message =
          {
            401: 'Sub2API 管理员 Key 无效，请检查设置',
            403: 'Sub2API 拒绝查询，请检查管理员 Key 的读取权限',
            404: 'Sub2API 接口不可用，请检查站点地址和版本',
            429: 'Sub2API 查询过于频繁，请稍后重试',
          }[status] ?? `Sub2API 请求失败（HTTP ${status}）`;
        throw new Sub2ApiError(message, status);
      }
      const payload = await response.json().catch(() => null);
      const result = z.object({ code: z.literal(0), data: schema }).safeParse(payload);
      if (!result.success)
        throw new Sub2ApiError('Sub2API 返回了无法识别的响应，请检查站点地址和版本');
      return result.data.data;
    } catch (error) {
      this.signal.throwIfAborted();
      if (timeout.aborted) throw new Sub2ApiError('Sub2API 查询超时，请稍后重试');
      if (error instanceof Sub2ApiError) throw error;
      throw new Sub2ApiError('无法连接 Sub2API，请检查站点地址及 Server 的网络连接');
    }
  }

  async accounts({
    type,
    search,
    page,
  }: {
    type: string;
    search: string;
    page: number;
  }): Promise<Sub2ApiPage<Sub2ApiAccount>> {
    const list = await this.request('/accounts', accountsPage, {
      type,
      search,
      page: String(page),
      page_size: String(pageSize),
    });
    let usage: Record<string, unknown> | null = null;
    let quotaErrors: Record<string, unknown> | null = null;
    let warning: string | undefined;
    if (list.items.length) {
      try {
        const batch = await this.request('/accounts/usage/batch', batchQuota, undefined, {
          account_ids: list.items.map((account) => account.id),
        });
        usage = batch.usage;
        quotaErrors = batch.errors ?? null;
      } catch (error) {
        this.signal.throwIfAborted();
        if (!(error instanceof Sub2ApiError)) throw error;
        if (error.upstreamStatus === 404 || error.upstreamStatus === 405) {
          const entries = await inBatches(list.items, async ({ id }) => {
            try {
              return [id, await this.request(`/accounts/${id}/usage`, quotaInfo)] as const;
            } catch {
              this.signal.throwIfAborted();
              return [id, null] as const;
            }
          });
          usage = Object.fromEntries(entries);
        } else warning = error.message;
      }
    }
    return {
      items: list.items.map((account) => {
        const quota = accountQuota(usage?.[account.id]);
        return {
          ...account,
          ...quota,
          quotaUnavailable: quota.quotaUnavailable || !!quotaErrors?.[account.id],
        };
      }),
      total: list.total,
      pageSize: list.page_size,
      warning,
    };
  }

  async accountCredits(accountId: number): Promise<Sub2ApiCredits | null> {
    const { credits } = await this.request(`/openai/accounts/${accountId}/quota`, openAiQuota);
    return credits
      ? {
          balance: credits.balance ?? null,
          hasCredits: credits.has_credits,
          unlimited: credits.unlimited,
        }
      : null;
  }

  async keys({
    startDate,
    endDate,
    timezone,
    page,
    search,
  }: DateRange & { page: number; search: string }): Promise<Sub2ApiPage<Sub2ApiKeyUsage>> {
    const range = { start_date: startDate, end_date: endDate, timezone };
    const requestedId = search.match(/^#([1-9]\d*)$/)?.[1];
    if (requestedId && Number.isSafeInteger(Number(requestedId))) {
      const stats = await this.request('/usage/stats', keyStats, {
        ...range,
        api_key_id: requestedId,
      });
      return {
        items: [
          {
            id: Number(requestedId),
            name: '',
            requests: stats.total_requests,
            tokens: stats.total_tokens,
            actualCost: stats.total_actual_cost ?? null,
          },
        ],
        total: 1,
        pageSize,
      };
    }

    const { trend } = await this.request('/dashboard/api-keys-trend', keyTrend, {
      ...range,
      granularity: 'day',
      limit: String(keyLimit + 1),
    });
    const keys = new Map<number, Sub2ApiKeyUsage>();
    for (const row of trend ?? []) {
      const saved = keys.get(row.api_key_id);
      keys.set(row.api_key_id, {
        id: row.api_key_id,
        name: row.key_name,
        requests: (saved?.requests ?? 0) + row.requests,
        tokens: (saved?.tokens ?? 0) + row.tokens,
        actualCost: null,
      });
    }
    const matching = [...keys.values()]
      .sort((a, b) => b.tokens - a.tokens || a.id - b.id)
      .slice(0, keyLimit)
      .filter(({ name }) => name.toLowerCase().includes(search.toLowerCase()));
    const warnings = new Set<string>();
    if (keys.size > keyLimit)
      warnings.add(`当前列出 Token 用量最高的 ${keyLimit} 把 Key。输入 #ID 可查询其他 Key。`);
    const items = await inBatches(
      matching.slice((page - 1) * pageSize, page * pageSize),
      async (key) => {
        try {
          const stats = await this.request('/usage/stats', keyStats, {
            ...range,
            api_key_id: String(key.id),
          });
          return {
            ...key,
            requests: stats.total_requests,
            tokens: stats.total_tokens,
            actualCost: stats.total_actual_cost ?? null,
          };
        } catch (error) {
          this.signal.throwIfAborted();
          if (!(error instanceof Sub2ApiError)) throw error;
          warnings.add(`部分 Key 的扣费无法查询。${error.message}。`);
          return key;
        }
      },
    );
    return {
      items,
      total: matching.length,
      pageSize,
      warning: [...warnings].join(' ') || undefined,
    };
  }
}
