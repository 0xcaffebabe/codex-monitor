import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { Sub2ApiSettings } from '../../src/sub2api-types.js';
import { Sub2ApiClient, Sub2ApiError, sub2ApiBaseUrl, type Sub2ApiConnection } from '../sub2api.js';
import { admin, fail } from './access.js';
import type { WorkspaceAuth } from '../authorization.js';

const settings = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048),
    adminKey: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]{1,512}$/)
      .optional(),
  })
  .strict();
const pagination = z.object({
  page: z.coerce.number().int().positive().default(1),
  search: z.string().trim().max(100).default(''),
});
const accounts = pagination
  .extend({ type: z.enum(['oauth', 'setup-token']).default('oauth') })
  .strict();
const accountId = z.coerce.number().int().positive();
const usageDates = {
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  timezone: z.string().regex(/^[A-Za-z0-9_+/-]{1,64}$/),
};

function validUsageDates({ startDate, endDate }: { startDate: string; endDate: string }) {
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
  return days >= 0 && days < 31;
}

const filterId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .pipe(z.coerce.number<string>().int().positive())
  .optional();
const keys = pagination.extend(usageDates).strict().refine(validUsageDates);
const calls = pagination
  .pick({ page: true })
  .extend({
    ...usageDates,
    apiKey: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    userId: filterId,
    accountId: filterId,
    groupId: filterId,
    requestType: z.enum(['sync', 'stream', 'ws_v2', 'live', 'cyber']).optional(),
    billingMode: z.enum(['token', 'per_request', 'image', 'video']).optional(),
    billingType: z.enum(['0', '1']).optional(),
  })
  .strict()
  .refine(validUsageDates);

export function installSub2ApiRoutes(app: Express, auth: WorkspaceAuth) {
  const db = auth.db;
  db.exec(`CREATE TABLE IF NOT EXISTS sub2api_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), base_url TEXT NOT NULL, admin_key TEXT NOT NULL
  )`);
  const read = db.prepare(
    'SELECT base_url AS baseUrl, admin_key AS adminKey FROM sub2api_settings WHERE id=1',
  );
  const save = db.prepare(`INSERT INTO sub2api_settings(id,base_url,admin_key) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url, admin_key=excluded.admin_key`);
  const remove = db.prepare('DELETE FROM sub2api_settings WHERE id=1');
  const connection = () => read.get() as Sub2ApiConnection | undefined;
  const publicSettings = (saved?: Sub2ApiConnection): Sub2ApiSettings => ({
    configured: !!saved,
    baseUrl: saved?.baseUrl ?? '',
  });

  app.get('/api/sub2api/settings', admin, (_req, res) => res.json(publicSettings(connection())));
  app.put('/api/sub2api/settings', admin, (req, res) => {
    const input = settings.safeParse(req.body);
    if (!input.success) return fail(res, 400, '请填写有效的 Sub2API 站点地址和管理员 Key');
    const baseUrl = sub2ApiBaseUrl(input.data.baseUrl);
    if (!baseUrl) return fail(res, 400, '请填写有效的 HTTP 或 HTTPS 站点地址');
    const before = connection();
    // Only retain the credential for the same normalized site address.
    const adminKey =
      input.data.adminKey ?? (before?.baseUrl === baseUrl ? before.adminKey : undefined);
    if (!adminKey) return fail(res, 400, '请填写此站点的管理员 Key');
    save.run(baseUrl, adminKey);
    auth.log('sub2api_settings_saved', req.identity!.user.username, req.ip ?? '');
    res.json(publicSettings({ baseUrl, adminKey }));
  });
  app.delete('/api/sub2api/settings', admin, (req, res) => {
    remove.run();
    auth.log('sub2api_settings_removed', req.identity!.user.username, req.ip ?? '');
    res.json(publicSettings());
  });

  function query<T>(
    schema: z.ZodType<T>,
    load: (client: Sub2ApiClient, input: T) => Promise<unknown>,
  ): RequestHandler {
    return async (req, res) => {
      const input = schema.safeParse(req.query);
      if (!input.success) return fail(res, 400, 'Sub2API 查询参数无效');
      const saved = connection();
      if (!saved) return fail(res, 409, '请先配置 Sub2API');
      const abort = new AbortController();
      const onClose = () => abort.abort();
      res.once('close', onClose);
      try {
        const result = await load(new Sub2ApiClient(saved, abort.signal), input.data);
        if (!abort.signal.aborted) res.json(result);
      } catch (error) {
        if (abort.signal.aborted) return;
        if (!(error instanceof Sub2ApiError)) throw error;
        fail(res, 502, error.message);
      } finally {
        res.off('close', onClose);
      }
    };
  }

  app.get(
    '/api/sub2api/accounts',
    admin,
    query(accounts, (client, input) => client.accounts(input)),
  );
  app.get(
    '/api/sub2api/account-credits',
    admin,
    query(z.object({ accountId }).strict(), (client, input) =>
      client.accountCredits(input.accountId),
    ),
  );
  app.get(
    '/api/sub2api/account-details',
    admin,
    query(
      z.object({ accountId, platform: z.enum(['openai', 'anthropic']) }).strict(),
      (client, input) => client.accountDetails(input.accountId, input.platform),
    ),
  );
  app.get(
    '/api/sub2api/keys',
    admin,
    query(keys, (client, input) => client.keys(input)),
  );
  app.get(
    '/api/sub2api/calls',
    admin,
    query(calls, (client, input) => client.callRecords(input)),
  );
}
