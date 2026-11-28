import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.js';
import { createMonitorServer } from '../server/server-app.js';
import { fixture } from './fixture.js';
import { FixtureDesktop } from './control-fixture.js';

for (const mode of ['local', 'server'] as const) {
  test(`${mode} account API preserves public, authenticated and administrator boundaries`, async () => {
    const data = fixture();
    const service =
      mode === 'local'
        ? createApp(data.config, { control: new FixtureDesktop(data) })
        : createMonitorServer(data.config);
    const server = service.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (route: string, options: RequestInit = {}, token?: string) =>
      fetch(base + route, {
        ...options,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
      });
    const post = (route: string, body: object, token?: string) =>
      request(
        route,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        token,
      );
    try {
      const health = await request('/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('x-powered-by'), null);
      assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(health.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await (await request('/api/auth/status')).json(), { configured: false });
      for (const route of [
        '/api/auth/me',
        '/api/auth/devices',
        '/api/users',
        '/api/sub2api/settings',
      ])
        assert.equal((await request(route)).status, 401, route);
      const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
        const incoming = httpRequest(
          base + '/api/health',
          { headers: { Host: 'attacker.invalid' } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        incoming.on('error', reject);
        incoming.end();
      });
      assert.equal(invalidHost, 403);
      assert.equal(
        (await request('/api/auth/status', { headers: { Origin: 'https://attacker.invalid' } }))
          .status,
        403,
      );
      const malformed = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), { error: 'JSON 格式无效' });

      const setup = await post('/api/auth/setup', {
        username: 'owner',
        password: 'account-api-password',
        setupKey: service.auth.setupKey,
      });
      assert.equal(setup.status, 201);
      const owner = await setup.json();
      assert.equal((await request('/api/auth/me', {}, owner.token)).status, 200);
      assert.equal((await request('/api/users', {}, owner.token)).status, 200);
      const configuration = await request('/api/sub2api/settings', {}, owner.token);
      assert.equal(configuration.status, 200);
      assert.deepEqual(await configuration.json(), { configured: false, baseUrl: '' });
      assert.equal(
        (
          await post(
            '/api/users',
            {
              username: 'viewer',
              password: 'account-api-password',
              role: 'viewer',
            },
            owner.token,
          )
        ).status,
        201,
      );
      const login = await post('/api/auth/login', {
        username: 'viewer',
        password: 'account-api-password',
      });
      assert.equal(login.status, 200);
      const viewer = await login.json();
      assert.equal((await request('/api/auth/devices', {}, viewer.token)).status, 200);
      for (const route of ['/api/users', '/api/sub2api/settings'])
        assert.equal((await request(route, {}, viewer.token)).status, 403, route);

      // Setup, login and password changes must share one limiter, even across public/protected routes.
      for (let attempt = 0; attempt < 10; attempt++)
        assert.equal((await post('/api/auth/login', {})).status, 400);
      const limited = await post(
        '/api/auth/password',
        {
          currentPassword: 'account-api-password',
          password: 'new-account-api-password',
        },
        owner.token,
      );
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal((await post('/api/auth/logout', {}, owner.token)).status, 204);
      assert.equal((await request('/api/auth/me', {}, owner.token)).status, 401);
    } finally {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      data.close();
      rmSync(data.root, { recursive: true, force: true });
    }
  });
}
