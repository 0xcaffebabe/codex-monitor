import path from 'node:path';
import os from 'node:os';
import { rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.js';
import { createMonitorServer } from '../server/server-app.js';
import { MonitorClient } from '../server/client/connection.js';
import { requestGuard } from '../server/http/security.js';
import { FixtureDesktop } from './control-fixture.js';
const root = process.env.MONITOR_TEST_ROOT || path.join(os.tmpdir(), 'codex-monitor-e2e-01a1d7fa');
const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
if (
  !relative ||
  relative.startsWith('..') ||
  path.isAbsolute(relative) ||
  !path.basename(root).startsWith('codex-monitor-')
)
  throw new Error(
    'MONITOR_TEST_ROOT must be a codex-monitor-* directory inside the system temporary directory',
  );
// This verified test-only directory contains generated fixtures, never the user's Codex home.
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const f = fixture(root);
// The provider adapter still makes an HTTP request, with all traffic captured locally.
const webhookReceiver = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  appendFileSync(path.join(root, 'webhook-messages.jsonl'), body + '\n');
  response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"code":0}');
});
await new Promise<void>((resolve) => webhookReceiver.listen(0, '127.0.0.1', resolve));
const webhookPort = (webhookReceiver.address() as { port: number }).port;
f.config.port = Number(process.env.MONITOR_TEST_PORT || 14317);
const app = createMonitorServer(f.config, {
  publicDir: process.env.MONITOR_TEST_PUBLIC_DIR,
  webhookTransport: (_url, init) => fetch(`http://127.0.0.1:${webhookPort}`, init),
});
const server = createServer(app.app);
app.gateway.attach(server, requestGuard(f.config));
server.listen(f.config.port, '127.0.0.1');
await once(server, 'listening');
const local = app.gateway.store.create('本机工作空间', 'local');
const client = await MonitorClient.start({
  config: f.config,
  serverUrl: `http://127.0.0.1:${f.config.port}`,
  workspaceId: 'local',
  key: local.key,
  services: {
    store: app.auth,
    control: new FixtureDesktop(f, 5000),
  },
});
const secondFixture = fixture(path.join(root, 'client-b'));
secondFixture.state
  .prepare("UPDATE threads SET title='第二台电脑的独立会话' WHERE id=?")
  .run('11111111-1111-4111-8111-111111111111');
const second = app.gateway.store.create('第二台测试电脑', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const secondClient = await MonitorClient.start({
  config: secondFixture.config,
  serverUrl: `http://127.0.0.1:${f.config.port}`,
  workspaceId: second.workspace.id,
  key: second.key,
  services: { control: new FixtureDesktop(secondFixture) },
});
async function stop() {
  await client.close();
  await secondClient.close();
  await app.close();
  f.close();
  secondFixture.close();
  webhookReceiver.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
