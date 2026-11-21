import { createServer } from 'node:http';
import { once } from 'node:events';

export const sub2ApiAdminKey = 'sub2api-test-admin-key';
export const upstreamCredential = 'sub2api-test-upstream-credential';

export async function sub2ApiFixture() {
  const calls: { method: string; path: string; query: URLSearchParams }[] = [];
  const behavior = { legacyBatch: false, rejectCost: false, rejectCredits: false, redirect: false };
  const createQuota = (utilization: number, utilizationUnknown = false) => ({
    updated_at: '2026-11-20T08:00:00Z',
    five_hour: {
      utilization,
      utilization_unknown: utilizationUnknown,
      resets_at: '2026-11-20T13:00:00Z',
      window_stats: { requests: 178, tokens: 9_354_344 },
    },
    seven_day: {
      utilization: 0,
      resets_at: '2026-11-24T04:00:00Z',
      window_stats: { requests: 19_548, tokens: 2_530_953_480 },
    },
  });
  const account = {
    id: 41,
    name: 'Codex Plus',
    api_key: upstreamCredential,
    platform: 'openai',
    status: 'active',
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const path = url.pathname.replace('/relay/api/v1/admin', '');
    calls.push({ method: req.method!, path, query: url.searchParams });
    const json = (status: number, data: unknown) => {
      res
        .writeHead(status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ code: status === 200 ? 0 : status, data }));
    };
    if (req.headers['x-api-key'] !== sub2ApiAdminKey)
      return json(401, { message: upstreamCredential });
    switch (path) {
      case '/accounts': {
        if (behavior.redirect)
          return res.writeHead(302, { Location: '/unexpected-redirect' }).end();
        const search = url.searchParams.get('search') || '';
        const items =
          url.searchParams.get('type') === 'setup-token'
            ? [{ ...account, id: 43, name: 'Claude subscription', platform: 'anthropic' }]
            : [account, { ...account, id: 42, name: 'Codex backup', status: 'inactive' }];
        const matches = items.filter((item) =>
          item.name.toLowerCase().includes(search.toLowerCase()),
        );
        return json(200, { items: matches, total: matches.length, page_size: 10 });
      }
      case '/accounts/usage/batch': {
        if (behavior.legacyBatch) return json(404, {});
        let body = '';
        for await (const chunk of req) body += chunk.toString();
        const { account_ids } = JSON.parse(body) as { account_ids: number[] };
        const usage = Object.fromEntries(
          account_ids
            .filter((id) => id !== 42)
            .map((id) => [id, createQuota(id === 41 ? 18.5 : 0, id === 43)]),
        );
        return json(200, {
          usage,
          errors: account_ids.includes(42) ? { 42: upstreamCredential } : {},
        });
      }
      case '/accounts/41/usage':
        return json(200, createQuota(18.5));
      case '/openai/accounts/41/quota':
        if (behavior.rejectCredits) return json(403, { message: upstreamCredential });
        return json(200, {
          credits: { balance: '1250.50', has_credits: true, unlimited: false },
          rate_limit_reset_credits: { available_count: 2 },
          access_token: upstreamCredential,
        });
      case '/openai/accounts/42/quota':
        return json(200, { credits: { balance: '0', has_credits: false, unlimited: false } });
      case '/openai/accounts/44/quota':
        return json(200, { credits: { balance: null, has_credits: true, unlimited: true } });
      case '/openai/accounts/45/quota':
        return json(200, { rate_limit_reset_credits: { available_count: 5 } });
      case '/dashboard/api-keys-trend':
        return json(200, {
          trend: [
            { date: '2026-11-19', api_key_id: 7, key_name: 'CI runner', requests: 4, tokens: 250 },
            { date: '2026-11-20', api_key_id: 7, key_name: 'CI runner', requests: 5, tokens: 750 },
            { date: '2026-11-20', api_key_id: 8, key_name: 'Editor', requests: 1, tokens: 100 },
          ],
        });
      case '/usage/stats': {
        if (behavior.rejectCost) return json(403, { message: upstreamCredential });
        const totals =
          url.searchParams.get('api_key_id') === '7'
            ? [9, 1000, 0.1234]
            : url.searchParams.get('api_key_id') === '8'
              ? [1, 100, 0.02]
              : [0, 0, 0];
        return json(200, {
          total_requests: totals[0],
          total_tokens: totals[1],
          total_actual_cost: totals[2],
          key: upstreamCredential,
        });
      }
      default:
        return json(404, {});
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/relay`,
    calls,
    behavior,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
